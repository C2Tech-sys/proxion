import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import { PveApiError, type PveClient } from '@proxion/pve-api';
import { resolveIdentity } from '../pve/identity.js';
import {
  guestTypeSchema,
  vmidSchema,
  hasPrivilege,
  hasStoragePrivilege,
  formatPveErrorMessage,
  sanitizeMessage,
} from './shared.js';

/**
 * Guest disk lifecycle (T52): add a disk / lxc mount point, detach a disk (PVE keeps the volume as
 * `unused[n]`) and permanently remove an unused volume. Three more allow-listed writes this server
 * performs against PVE, registered from `actionsRoutes` (`routes.ts`) next to
 * `registerHardwareRoutes` so they share its rate limiter. The raw `/api/pve/*` proxy stays
 * read-only; each call here names exactly one config key and composes its value from validated
 * fields, never from caller-supplied text. See "Guest actions" in README.md for the contract.
 */

/** A PVE storage id. Deliberately free of `:`, `,` and `=` so it can only ever be one segment of
 * the `<storage>:<size>,...` property string it is placed into. */
const STORAGE_ID_RE = /^[A-Za-z][A-Za-z0-9._-]{0,63}$/;

/** An absolute path inside the container. No `,` (property-string separator), no spaces, and `..`
 * is refused separately. */
const MOUNT_POINT_RE = /^\/[A-Za-z0-9._/-]{0,200}$/;

const MAX_SIZE_GIB = 65536;

/** qemu disk buses and the number of slots each has (`ide0-3`, `sata0-5`, `virtio0-15`, `scsi0-30`). */
const BUS_SLOTS = { ide: 4, sata: 6, virtio: 16, scsi: 31 } as const;
type Bus = keyof typeof BUS_SLOTS;

/** lxc mount points are `mp0`..`mp255`. */
const MAX_MOUNT_POINTS = 256;

/** Slots the detach route accepts: a disk on a qemu bus, or a lxc mount point -- never `rootfs`,
 * `efidisk0`, `tpmstate0` or `unused[n]`. */
const QEMU_DISK_SLOT_RE = /^(ide[0-3]|sata[0-5]|scsi(\d|[12]\d|30)|virtio(\d|1[0-5]))$/;
const LXC_DISK_SLOT_RE = /^mp(\d|[1-9]\d|1\d\d|2[0-4]\d|25[0-5])$/;
const UNUSED_SLOT_RE = /^unused(\d|[1-9]\d|1\d\d|2[0-4]\d|25[0-5])$/;

const addDiskBodySchema = z
  .object({
    // qemu
    bus: z.enum(['scsi', 'virtio', 'sata', 'ide']).optional(),
    format: z.enum(['raw', 'qcow2', 'vmdk']).optional(),
    discard: z.boolean().optional(),
    ssd: z.boolean().optional(),
    iothread: z.boolean().optional(),
    cache: z.enum(['none', 'writethrough', 'writeback', 'unsafe', 'directsync']).optional(),
    // lxc
    mountPoint: z
      .string()
      .regex(MOUNT_POINT_RE)
      .refine((v) => !v.includes('..'), { message: 'Path traversal is not allowed' })
      .optional(),
    readOnly: z.boolean().optional(),
    acl: z.boolean().optional(),
    // both
    storage: z.string().regex(STORAGE_ID_RE),
    sizeGiB: z.number().int().min(1).max(MAX_SIZE_GIB),
    backup: z.boolean().optional(),
  })
  .strict();

type AddDiskBody = z.infer<typeof addDiskBodySchema>;

const QEMU_ONLY_FIELDS = ['bus', 'format', 'discard', 'ssd', 'iothread', 'cache'] as const;
const LXC_ONLY_FIELDS = ['mountPoint', 'readOnly', 'acl'] as const;

interface GuestRouteParams {
  node: string;
  type: 'qemu' | 'lxc';
  vmid: number;
}

/** Same local `:node/:type/:vmid` parse every hardware/clone/backup route file keeps. */
function parseGuestParams(rawParams: Record<string, string>): GuestRouteParams | undefined {
  const node = rawParams.node;
  const type = guestTypeSchema.safeParse(rawParams.type);
  const vmid = vmidSchema.safeParse(rawParams.vmid);
  if (!node || !type.success || !vmid.success) return undefined;
  return { node, type: type.data, vmid: vmid.data };
}

/** Maps a PVE call failure to the `502`/`4xx` shape every guest-action route uses; `true` iff it
 * sent a reply. */
function sendPveError(reply: FastifyReply, error: unknown): boolean {
  if (error instanceof PveApiError) {
    if (error.status >= 500) {
      reply.code(502).send({ error: 'pve-unreachable' });
    } else {
      reply.code(error.status).send({ error: 'pve-rejected', message: sanitizeMessage(formatPveErrorMessage(error)) });
    }
    return true;
  }
  return false;
}

async function fetchConfig(
  client: PveClient,
  type: 'qemu' | 'lxc',
  node: string,
  vmid: number,
): Promise<Record<string, unknown>> {
  const config: unknown =
    type === 'qemu'
      ? await client.get('/nodes/{node}/qemu/{vmid}/config', { node, vmid })
      : await client.get('/nodes/{node}/lxc/{vmid}/config', { node, vmid });
  return (config ?? {}) as Record<string, unknown>;
}

/** PUT .../config with one dynamically-keyed parameter (`scsi2`, `mp1`, `delete`), which the
 * generated table's `scsi[n]`-style keys can't express, hence the cast. */
async function putConfig(
  client: PveClient,
  type: 'qemu' | 'lxc',
  node: string,
  vmid: number,
  params: Record<string, string>,
): Promise<void> {
  if (type === 'qemu') {
    await client.put('/nodes/{node}/qemu/{vmid}/config', { node, vmid, ...params } as never);
  } else {
    await client.put('/nodes/{node}/lxc/{vmid}/config', { node, vmid, ...params } as never);
  }
}

interface PendingRow {
  key: string;
  pending?: unknown;
  delete?: unknown;
}

/** Which of `keys` PVE is holding back until the guest restarts. A failure to read the pending
 * list never fails the (already applied) change -- it just reports none. */
async function pendingKeysOf(
  app: FastifyInstance,
  client: PveClient,
  type: 'qemu' | 'lxc',
  node: string,
  vmid: number,
  keys: string[],
): Promise<string[]> {
  try {
    const rows: unknown =
      type === 'qemu'
        ? await client.get('/nodes/{node}/qemu/{vmid}/pending', { node, vmid })
        : await client.get('/nodes/{node}/lxc/{vmid}/pending', { node, vmid });
    if (!Array.isArray(rows)) return [];
    const held = new Set(
      (rows as PendingRow[])
        .filter((row) => row.pending !== undefined || (row.delete !== undefined && Boolean(row.delete)))
        .map((row) => row.key),
    );
    return keys.filter((key) => held.has(key));
  } catch (error) {
    app.log.warn({ err: error }, 'Failed to read pending config after guest disk change');
    return [];
  }
}

/** The lowest free slot of a qemu bus, or `undefined` when the bus is full. Any config key of the
 * form `<bus><n>` counts as taken (a CD-ROM on `ide2` occupies it too). */
function nextQemuSlot(config: Record<string, unknown>, bus: Bus): string | undefined {
  const taken = new Set<number>();
  const re = new RegExp(`^${bus}(\\d+)$`);
  for (const key of Object.keys(config)) {
    const match = re.exec(key);
    if (match) taken.add(Number(match[1]));
  }
  for (let n = 0; n < BUS_SLOTS[bus]; n++) {
    if (!taken.has(n)) return `${bus}${n}`;
  }
  return undefined;
}

function nextMountPointSlot(config: Record<string, unknown>): string | undefined {
  const taken = new Set<number>();
  for (const key of Object.keys(config)) {
    const match = /^mp(\d+)$/.exec(key);
    if (match) taken.add(Number(match[1]));
  }
  for (let n = 0; n < MAX_MOUNT_POINTS; n++) {
    if (!taken.has(n)) return `mp${n}`;
  }
  return undefined;
}

/** The PVE value for a new qemu disk. `<storage>:<size>` with a bare number allocates that many
 * GiB. `format` goes out only when the caller chose one (PVE uses the storage default otherwise). */
function composeQemuValue(body: AddDiskBody): string {
  const parts = [`${body.storage}:${body.sizeGiB}`];
  if (body.format !== undefined) parts.push(`format=${body.format}`);
  if (body.discard === true) parts.push('discard=on');
  if (body.ssd === true) parts.push('ssd=1');
  if (body.iothread === true) parts.push('iothread=1');
  if (body.cache !== undefined) parts.push(`cache=${body.cache}`);
  parts.push(`backup=${body.backup === false ? 0 : 1}`);
  return parts.join(',');
}

function composeMountPointValue(body: AddDiskBody): string {
  const parts = [`${body.storage}:${body.sizeGiB}`, `mp=${body.mountPoint ?? ''}`];
  parts.push(`backup=${body.backup === false ? 0 : 1}`);
  if (body.acl === true) parts.push('acl=1');
  if (body.readOnly === true) parts.push('ro=1');
  return parts.join(',');
}

/** The volume id of a drive value (`local-lvm:vm-100-disk-1,size=32G` -> `local-lvm:vm-100-disk-1`). */
function volumeOf(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const first = value.split(',')[0];
  return first ? first : undefined;
}

/** The `unused[n]` slot that now holds `volume`, looked up in a re-read config. */
function findUnusedSlot(config: Record<string, unknown>, volume: string): string | undefined {
  for (const [key, value] of Object.entries(config)) {
    if (/^unused\d+$/.test(key) && volumeOf(value) === volume) return key;
  }
  return undefined;
}

const isCdromValue = (value: unknown): boolean =>
  typeof value === 'string' && /(?:^|,)media=cdrom(?:,|$)/.test(value);

export function registerDiskRoutes(
  app: FastifyInstance,
  guestActionsRateLimit: ReturnType<FastifyInstance['rateLimit']>,
): void {
  app.post(
    '/api/actions/guest/:node/:type/:vmid/disks',
    { onRequest: guestActionsRateLimit },
    async (req, reply) => {
      const params = parseGuestParams(req.params as Record<string, string>);
      if (!params) {
        reply.code(400).send({ error: 'Invalid node/type/vmid' });
        return;
      }

      const parsed = addDiskBodySchema.safeParse(req.body ?? {});
      if (!parsed.success) {
        reply.code(400).send({ error: 'Invalid request body' });
        return;
      }
      const body = parsed.data;

      const wrongFields = (params.type === 'qemu' ? LXC_ONLY_FIELDS : QEMU_ONLY_FIELDS).filter(
        (field) => (body as Record<string, unknown>)[field] !== undefined,
      );
      if (wrongFields.length > 0) {
        reply.code(400).send({
          error: 'invalid-field-for-type',
          message: `${wrongFields.join(', ')} ${wrongFields.length === 1 ? 'is' : 'are'} not valid for a ${params.type} guest.`,
        });
        return;
      }
      if (params.type === 'qemu' && body.bus === undefined) {
        reply.code(400).send({ error: 'Invalid request body' });
        return;
      }
      if (params.type === 'lxc' && body.mountPoint === undefined) {
        reply.code(400).send({ error: 'Invalid request body' });
        return;
      }
      // PVE itself refuses these combinations; say so up front instead of relaying its error.
      if (params.type === 'qemu' && body.bus === 'virtio' && body.ssd === true) {
        reply.code(400).send({ error: 'invalid-option-for-bus', message: 'SSD emulation is not available on virtio disks.' });
        return;
      }
      if (params.type === 'qemu' && (body.bus === 'ide' || body.bus === 'sata') && body.iothread === true) {
        reply.code(400).send({ error: 'invalid-option-for-bus', message: 'IO thread is only available on scsi and virtio disks.' });
        return;
      }

      const identity = await resolveIdentity(app, req);
      if (!identity) {
        reply.code(401).send({ error: 'Not authenticated' });
        return;
      }
      if (identity.credentials.type === 'token') {
        reply.code(403).send({ error: 'writes-disabled-in-token-mode' });
        return;
      }
      const client = identity.client;

      let guestAllowed: boolean;
      let storageAllowed: boolean;
      try {
        [guestAllowed, storageAllowed] = await Promise.all([
          hasPrivilege(client, params.vmid, 'VM.Config.Disk'),
          hasStoragePrivilege(client, body.storage, 'Datastore.AllocateSpace'),
        ]);
      } catch (error) {
        app.log.warn({ err: error }, 'Failed to check permissions for guest disk add');
        reply.code(502).send({ error: 'pve-unreachable' });
        return;
      }
      if (!guestAllowed) {
        reply.code(403).send({ error: 'forbidden', missing: 'VM.Config.Disk' });
        return;
      }
      if (!storageAllowed) {
        reply.code(403).send({ error: 'forbidden', missing: 'Datastore.AllocateSpace' });
        return;
      }

      let config: Record<string, unknown>;
      try {
        config = await fetchConfig(client, params.type, params.node, params.vmid);
      } catch (error) {
        if (sendPveError(reply, error)) return;
        app.log.warn({ err: error }, 'Failed to read current config for guest disk add');
        reply.code(502).send({ error: 'pve-unreachable' });
        return;
      }

      const slot =
        params.type === 'qemu' ? nextQemuSlot(config, body.bus as Bus) : nextMountPointSlot(config);
      if (slot === undefined) {
        reply.code(400).send({
          error: 'bus-full',
          message:
            params.type === 'qemu'
              ? `The ${body.bus} bus has no free slot; choose another bus.`
              : 'This container has no free mount point slot.',
        });
        return;
      }

      const value = params.type === 'qemu' ? composeQemuValue(body) : composeMountPointValue(body);
      try {
        await putConfig(client, params.type, params.node, params.vmid, { [slot]: value });
      } catch (error) {
        if (sendPveError(reply, error)) return;
        app.log.warn({ err: error }, 'Guest disk add request failed');
        reply.code(502).send({ error: 'pve-unreachable' });
        return;
      }

      const pending = await pendingKeysOf(app, client, params.type, params.node, params.vmid, [slot]);

      // Keys and sizes only, same convention as the other hardware routes.
      app.log.info(
        {
          username: identity.username,
          node: params.node,
          type: params.type,
          vmid: params.vmid,
          slot,
          storage: body.storage,
          sizeGiB: body.sizeGiB,
          pending,
        },
        'Guest disk added',
      );
      reply.code(200).send({ ok: true, slot, pending });
    },
  );

  app.post(
    '/api/actions/guest/:node/:type/:vmid/disks/:slot/detach',
    { onRequest: guestActionsRateLimit },
    async (req, reply) => {
      const rawParams = req.params as Record<string, string>;
      const params = parseGuestParams(rawParams);
      if (!params) {
        reply.code(400).send({ error: 'Invalid node/type/vmid' });
        return;
      }
      const slot = rawParams.slot ?? '';
      const slotRe = params.type === 'qemu' ? QEMU_DISK_SLOT_RE : LXC_DISK_SLOT_RE;
      if (!slotRe.test(slot)) {
        reply.code(400).send({
          error: 'invalid-disk-for-type',
          message: `${slot} is not a detachable disk on a ${params.type} guest.`,
        });
        return;
      }

      const identity = await resolveIdentity(app, req);
      if (!identity) {
        reply.code(401).send({ error: 'Not authenticated' });
        return;
      }
      if (identity.credentials.type === 'token') {
        reply.code(403).send({ error: 'writes-disabled-in-token-mode' });
        return;
      }
      const client = identity.client;

      let allowed: boolean;
      try {
        allowed = await hasPrivilege(client, params.vmid, 'VM.Config.Disk');
      } catch (error) {
        app.log.warn({ err: error }, 'Failed to check VM.Config.Disk permission for guest disk detach');
        reply.code(502).send({ error: 'pve-unreachable' });
        return;
      }
      if (!allowed) {
        reply.code(403).send({ error: 'forbidden', missing: 'VM.Config.Disk' });
        return;
      }

      let before: Record<string, unknown>;
      try {
        before = await fetchConfig(client, params.type, params.node, params.vmid);
      } catch (error) {
        if (sendPveError(reply, error)) return;
        app.log.warn({ err: error }, 'Failed to read current config for guest disk detach');
        reply.code(502).send({ error: 'pve-unreachable' });
        return;
      }
      const current = before[slot];
      if (current === undefined || current === null || current === '') {
        reply.code(404).send({ error: 'disk-not-found', message: `${slot} is not present on this guest.` });
        return;
      }
      if (isCdromValue(current)) {
        reply.code(400).send({ error: 'not-a-disk', message: `${slot} is a CD/DVD drive, not a disk.` });
        return;
      }

      try {
        await putConfig(client, params.type, params.node, params.vmid, { delete: slot });
      } catch (error) {
        if (sendPveError(reply, error)) return;
        app.log.warn({ err: error }, 'Guest disk detach request failed');
        reply.code(502).send({ error: 'pve-unreachable' });
        return;
      }

      // Where PVE parked the volume. A failed re-read never fails the (already applied) detach.
      let unusedSlot: string | undefined;
      const volume = volumeOf(current);
      if (volume !== undefined) {
        try {
          const after = await fetchConfig(client, params.type, params.node, params.vmid);
          unusedSlot = findUnusedSlot(after, volume);
        } catch (error) {
          app.log.warn({ err: error }, 'Failed to re-read config after guest disk detach');
        }
      }
      const pending = await pendingKeysOf(app, client, params.type, params.node, params.vmid, [slot]);

      app.log.info(
        { username: identity.username, node: params.node, type: params.type, vmid: params.vmid, slot, unusedSlot },
        'Guest disk detached',
      );
      reply.code(200).send({ ok: true, ...(unusedSlot !== undefined ? { unusedSlot } : {}), pending });
    },
  );

  app.delete(
    '/api/actions/guest/:node/:type/:vmid/disks/:slot',
    { onRequest: guestActionsRateLimit },
    async (req, reply) => {
      const rawParams = req.params as Record<string, string>;
      const params = parseGuestParams(rawParams);
      if (!params) {
        reply.code(400).send({ error: 'Invalid node/type/vmid' });
        return;
      }
      const slot = rawParams.slot ?? '';
      if (!UNUSED_SLOT_RE.test(slot)) {
        reply.code(400).send({
          error: 'not-unused-disk',
          message: `${slot} is not an unused disk; detach it first.`,
        });
        return;
      }

      const identity = await resolveIdentity(app, req);
      if (!identity) {
        reply.code(401).send({ error: 'Not authenticated' });
        return;
      }
      if (identity.credentials.type === 'token') {
        reply.code(403).send({ error: 'writes-disabled-in-token-mode' });
        return;
      }
      const client = identity.client;

      // PVE enforces VM.Config.Disk for `delete=unused[n]`; whatever else it wants (the volume's
      // storage) it checks itself and reports as a `pve-rejected` 403.
      let allowed: boolean;
      try {
        allowed = await hasPrivilege(client, params.vmid, 'VM.Config.Disk');
      } catch (error) {
        app.log.warn({ err: error }, 'Failed to check VM.Config.Disk permission for unused disk removal');
        reply.code(502).send({ error: 'pve-unreachable' });
        return;
      }
      if (!allowed) {
        reply.code(403).send({ error: 'forbidden', missing: 'VM.Config.Disk' });
        return;
      }

      let config: Record<string, unknown>;
      try {
        config = await fetchConfig(client, params.type, params.node, params.vmid);
      } catch (error) {
        if (sendPveError(reply, error)) return;
        app.log.warn({ err: error }, 'Failed to read current config for unused disk removal');
        reply.code(502).send({ error: 'pve-unreachable' });
        return;
      }
      const current = config[slot];
      if (current === undefined || current === null || current === '') {
        reply.code(404).send({ error: 'disk-not-found', message: `${slot} is not present on this guest.` });
        return;
      }

      try {
        await putConfig(client, params.type, params.node, params.vmid, { delete: slot });
      } catch (error) {
        if (sendPveError(reply, error)) return;
        app.log.warn({ err: error }, 'Unused disk removal request failed');
        reply.code(502).send({ error: 'pve-unreachable' });
        return;
      }

      app.log.info(
        { username: identity.username, node: params.node, type: params.type, vmid: params.vmid, slot },
        'Guest unused disk removed',
      );
      reply.code(200).send({ ok: true });
    },
  );
}
