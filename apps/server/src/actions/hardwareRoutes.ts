import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import { PveApiError, type PveClient } from '@proxion/pve-api';
import { resolveIdentity } from '../pve/identity.js';
import { guestTypeSchema, vmidSchema, hasPrivilege, formatPveErrorMessage, sanitizeMessage } from './shared.js';

/**
 * Guest hardware edits (T48, first cut): CPU, memory/balloon/swap, CD-ROM media and disk grow.
 * Two more allow-listed writes this server performs against PVE, registered from `actionsRoutes`
 * (`routes.ts`) so they share its rate limiter, same convention as `registerCloneRoutes`/
 * `registerBackupRoutes`. The raw `/api/pve/*` proxy stays read-only; every hardware field that
 * can be changed is named here, validated, and mapped to its PVE parameter one explicit call at a
 * time. See "Guest actions" in README.md for the contract.
 */

/** A CPU model name (`x86-64-v2-AES`, `host`, `Skylake-Server`, a `custom-*` model, ...). Only the
 * shape is enforced here -- PVE itself validates that the model exists. */
const CPU_MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/;

/** A CD-ROM slot: ide0-3, sata0-5, scsi0-30 (qemu's own slot ranges). */
const CDROM_SLOT_RE = /^(ide[0-3]|sata[0-5]|scsi(\d|[12]\d|30))$/;

/** An ISO volume id (`storage:iso/file.iso`). Deliberately narrower than PVE's own volume syntax:
 * no path separators beyond the `iso/` content dir, no spaces, no option separators (`,`), so the
 * value can only ever be appended into the `<slot>: <volid>,media=cdrom` property string as a
 * single volume id. */
const ISO_VOLID_RE = /^[A-Za-z][A-Za-z0-9._-]*:iso\/[A-Za-z0-9][A-Za-z0-9._+-]*\.(iso|img)$/;
const MAX_VOLID_LENGTH = 255;

/** Disks this route may grow: everything with a size except `efidisk0`/`tpmstate0`/`unused*`. */
const RESIZE_DISK_RE =
  /^(ide[0-3]|sata[0-5]|scsi(\d|[12]\d|30)|virtio(\d|1[0-5])|rootfs|mp(\d|[1-9]\d|1\d\d|2[0-5][0-5]))$/;
const QEMU_DISK_RE = /^(ide[0-3]|sata[0-5]|scsi(\d|[12]\d|30)|virtio(\d|1[0-5]))$/;
const LXC_DISK_RE = /^(rootfs|mp(\d|[1-9]\d|1\d\d|2[0-5][0-5]))$/;

/** Grow-only by construction: the leading `+` is required, so the request can only ever say
 * "add this much" and never "set it to this size" (PVE itself also refuses to shrink). */
const RESIZE_SIZE_RE = /^\+\d+(\.\d+)?[MGT]$/;

/** qemu's `cores` cap is 1024; lxc's is 8192 (the schema's own bound) -- see the handler. */
const MAX_QEMU_CORES = 1024;

const MAX_MEMORY_MIB = 4194304;
const MIN_MEMORY_MIB = 16;

const cdromSchema = z
  .object({
    slot: z.string().regex(CDROM_SLOT_RE),
    iso: z
      .string()
      .max(MAX_VOLID_LENGTH)
      .regex(ISO_VOLID_RE)
      .refine((v) => !v.includes('..'), { message: 'Path traversal is not allowed' })
      .nullable(),
  })
  .strict();

// `.strict()`: an unknown key is a 400, same rationale as every other guest-action body schema.
// Per-type field guards (qemu-only vs lxc-only) and `balloon` against the *current* memory live in
// the handler, where the guest `type` and the caller's client are known.
const hardwareBodySchema = z
  .object({
    cores: z.number().int().min(1).max(8192).optional(),
    sockets: z.number().int().min(1).max(64).optional(),
    cpu: z.string().regex(CPU_MODEL_RE).optional(),
    memory: z.number().int().min(MIN_MEMORY_MIB).max(MAX_MEMORY_MIB).optional(),
    balloon: z.number().int().min(0).max(MAX_MEMORY_MIB).optional(),
    swap: z.number().int().min(0).max(MAX_MEMORY_MIB).optional(),
    cdrom: cdromSchema.optional(),
  })
  .strict()
  .refine((data) => Object.values(data).some((v) => v !== undefined), {
    message: 'At least one hardware field is required',
  })
  .refine((data) => data.balloon === undefined || data.memory === undefined || data.balloon <= data.memory, {
    message: 'balloon must not exceed memory',
  });

type HardwareBody = z.infer<typeof hardwareBodySchema>;

const resizeBodySchema = z
  .object({
    disk: z.string().regex(RESIZE_DISK_RE),
    size: z
      .string()
      .regex(RESIZE_SIZE_RE)
      .refine((v) => Number(v.slice(1, -1)) > 0, { message: 'size must be greater than zero' }),
  })
  .strict();

/** The guest's `type` decides which of the body's fields apply at all. */
const QEMU_ONLY_FIELDS = ['sockets', 'cpu', 'balloon', 'cdrom'] as const;
const LXC_ONLY_FIELDS = ['swap'] as const;

type HardwarePrivilege = 'VM.Config.CPU' | 'VM.Config.Memory' | 'VM.Config.CDROM';

/** The privilege groups a request touches, in the order a missing one is reported. */
function requiredPrivileges(body: HardwareBody): HardwarePrivilege[] {
  const needed: HardwarePrivilege[] = [];
  if (body.cores !== undefined || body.sockets !== undefined || body.cpu !== undefined) needed.push('VM.Config.CPU');
  if (body.memory !== undefined || body.balloon !== undefined || body.swap !== undefined) {
    needed.push('VM.Config.Memory');
  }
  if (body.cdrom !== undefined) needed.push('VM.Config.CDROM');
  return needed;
}

interface GuestRouteParams {
  node: string;
  type: 'qemu' | 'lxc';
  vmid: number;
}

/** Parses/validates the common `:node/:type/:vmid` triple (kept local, same rationale as
 * `cloneRoutes.ts`'s/`backupRoutes.ts`'s own `parseGuestParams`). */
function parseGuestParams(rawParams: Record<string, string>): GuestRouteParams | undefined {
  const node = rawParams.node;
  const type = guestTypeSchema.safeParse(rawParams.type);
  const vmid = vmidSchema.safeParse(rawParams.vmid);
  if (!node || !type.success || !vmid.success) return undefined;
  return { node, type: type.data, vmid: vmid.data };
}

/** Maps a PVE call failure to the same `502`/`4xx` response shape every guest-action route uses
 * (incl. PVE's per-field `errors` map via `formatPveErrorMessage`); `true` iff it sent a reply. */
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

/** Builds the PVE config parameters for this request, keyed by PVE's own config key (a CD-ROM
 * goes out under its slot name, e.g. `ide2`). The order is the order `changed` is reported in. */
function toPveConfig(type: 'qemu' | 'lxc', body: HardwareBody): Record<string, string | number> {
  const out: Record<string, string | number> = {};
  if (body.cores !== undefined) out.cores = body.cores;
  if (type === 'qemu') {
    if (body.sockets !== undefined) out.sockets = body.sockets;
    if (body.cpu !== undefined) out.cpu = body.cpu;
  }
  if (body.memory !== undefined) out.memory = type === 'qemu' ? String(body.memory) : body.memory;
  if (type === 'qemu' && body.balloon !== undefined) out.balloon = body.balloon;
  if (type === 'lxc' && body.swap !== undefined) out.swap = body.swap;
  if (type === 'qemu' && body.cdrom !== undefined) {
    out[body.cdrom.slot] = `${body.cdrom.iso ?? 'none'},media=cdrom`;
  }
  return out;
}

/** The guest's current memory (MiB) for the `balloon <= memory` check when the request doesn't
 * carry a `memory` itself. `undefined` when it can't be read as a plain MiB figure (PVE then does
 * its own validation). PVE's default memory is 512 when the key is absent. */
async function currentQemuMemory(client: PveClient, node: string, vmid: number): Promise<number | undefined> {
  const config = await client.get('/nodes/{node}/qemu/{vmid}/config', { node, vmid });
  const raw: unknown = (config as { memory?: unknown }).memory;
  if (raw === undefined || raw === null) return 512;
  if (typeof raw === 'number') return raw;
  if (typeof raw === 'string') {
    if (/^\d+$/.test(raw)) return Number(raw);
    const current = /(?:^|,)current=(\d+)/.exec(raw);
    if (current) return Number(current[1]);
  }
  return undefined;
}

/** PUT .../config -- one explicit, generated-endpoint-checked call per guest type. The params are
 * built dynamically (a CD-ROM is keyed by its slot name), which the generated table's `ide[n]`-
 * style keys can't express, hence the cast. */
async function callConfigUpdate(
  client: PveClient,
  type: 'qemu' | 'lxc',
  node: string,
  vmid: number,
  config: Record<string, string | number>,
): Promise<void> {
  if (type === 'qemu') {
    await client.put('/nodes/{node}/qemu/{vmid}/config', { node, vmid, ...config } as never);
  } else {
    await client.put('/nodes/{node}/lxc/{vmid}/config', { node, vmid, ...config } as never);
  }
}

interface PendingRow {
  key: string;
  pending?: unknown;
  delete?: unknown;
}

async function fetchPending(
  client: PveClient,
  type: 'qemu' | 'lxc',
  node: string,
  vmid: number,
): Promise<PendingRow[]> {
  const rows: unknown =
    type === 'qemu'
      ? await client.get('/nodes/{node}/qemu/{vmid}/pending', { node, vmid })
      : await client.get('/nodes/{node}/lxc/{vmid}/pending', { node, vmid });
  return Array.isArray(rows) ? (rows as PendingRow[]) : [];
}

/** PUT .../resize -- one explicit call per guest type. Returns PVE's UPID, or `null` if it gave
 * none (older releases resize synchronously). */
async function callResize(
  client: PveClient,
  type: 'qemu' | 'lxc',
  node: string,
  vmid: number,
  disk: string,
  size: string,
): Promise<string | null> {
  const result: unknown =
    type === 'qemu'
      ? await client.put('/nodes/{node}/qemu/{vmid}/resize', { node, vmid, disk: disk as never, size })
      : await client.put('/nodes/{node}/lxc/{vmid}/resize', { node, vmid, disk: disk as never, size });
  return typeof result === 'string' && result.length > 0 ? result : null;
}

export function registerHardwareRoutes(
  app: FastifyInstance,
  guestActionsRateLimit: ReturnType<FastifyInstance['rateLimit']>,
): void {
  app.patch(
    '/api/actions/guest/:node/:type/:vmid/hardware',
    { onRequest: guestActionsRateLimit },
    async (req, reply) => {
      const params = parseGuestParams(req.params as Record<string, string>);
      if (!params) {
        reply.code(400).send({ error: 'Invalid node/type/vmid' });
        return;
      }

      const body = hardwareBodySchema.safeParse(req.body ?? {});
      if (!body.success) {
        reply.code(400).send({ error: 'Invalid request body' });
        return;
      }

      const wrongFields = (params.type === 'qemu' ? LXC_ONLY_FIELDS : QEMU_ONLY_FIELDS).filter(
        (field) => (body.data as Record<string, unknown>)[field] !== undefined,
      );
      if (wrongFields.length > 0) {
        reply.code(400).send({
          error: 'invalid-field-for-type',
          message: `${wrongFields.join(', ')} ${wrongFields.length === 1 ? 'is' : 'are'} not valid for a ${params.type} guest.`,
        });
        return;
      }

      // The schema allows lxc's wider core range; qemu's own cap is lower.
      if (params.type === 'qemu' && body.data.cores !== undefined && body.data.cores > MAX_QEMU_CORES) {
        reply.code(400).send({ error: 'Invalid request body' });
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

      const needed = requiredPrivileges(body.data);
      let granted: boolean[];
      try {
        granted = await Promise.all(needed.map((priv) => hasPrivilege(client, params.vmid, priv)));
      } catch (error) {
        app.log.warn({ err: error }, 'Failed to check permissions for guest hardware update');
        reply.code(502).send({ error: 'pve-unreachable' });
        return;
      }
      const missingIndex = granted.findIndex((ok) => !ok);
      if (missingIndex !== -1) {
        reply.code(403).send({ error: 'forbidden', missing: needed[missingIndex] });
        return;
      }

      if (params.type === 'qemu' && body.data.balloon !== undefined && body.data.memory === undefined) {
        let memory: number | undefined;
        try {
          memory = await currentQemuMemory(client, params.node, params.vmid);
        } catch (error) {
          if (sendPveError(reply, error)) return;
          app.log.warn({ err: error }, 'Failed to read current memory for guest hardware update');
          reply.code(502).send({ error: 'pve-unreachable' });
          return;
        }
        if (memory !== undefined && body.data.balloon > memory) {
          reply.code(400).send({
            error: 'balloon-exceeds-memory',
            message: `The balloon minimum (${body.data.balloon} MiB) cannot exceed the guest's memory (${memory} MiB).`,
          });
          return;
        }
      }

      const config = toPveConfig(params.type, body.data);
      const changed = Object.keys(config);

      try {
        await callConfigUpdate(client, params.type, params.node, params.vmid, config);
      } catch (error) {
        if (sendPveError(reply, error)) return;
        app.log.warn({ err: error }, 'Guest hardware update request failed');
        reply.code(502).send({ error: 'pve-unreachable' });
        return;
      }

      // Which of the changed keys PVE is holding back until the guest restarts. A failure to read
      // the pending list never fails the (already applied) update -- it just reports none.
      let pending: string[] = [];
      try {
        const rows = await fetchPending(client, params.type, params.node, params.vmid);
        const held = new Set(
          rows
            .filter((row) => row.pending !== undefined || (row.delete !== undefined && Boolean(row.delete)))
            .map((row) => row.key),
        );
        pending = changed.filter((key) => held.has(key));
      } catch (error) {
        app.log.warn({ err: error }, 'Failed to read pending config after guest hardware update');
      }

      // One line per update; the changed *keys* only, never their values.
      app.log.info(
        { username: identity.username, node: params.node, type: params.type, vmid: params.vmid, changed, pending },
        'Guest hardware updated',
      );
      reply.code(200).send({ ok: true, changed, pending });
    },
  );

  app.put(
    '/api/actions/guest/:node/:type/:vmid/resize',
    { onRequest: guestActionsRateLimit },
    async (req, reply) => {
      const params = parseGuestParams(req.params as Record<string, string>);
      if (!params) {
        reply.code(400).send({ error: 'Invalid node/type/vmid' });
        return;
      }

      const body = resizeBodySchema.safeParse(req.body ?? {});
      if (!body.success) {
        reply.code(400).send({ error: 'Invalid request body' });
        return;
      }

      const diskRe = params.type === 'qemu' ? QEMU_DISK_RE : LXC_DISK_RE;
      if (!diskRe.test(body.data.disk)) {
        reply.code(400).send({
          error: 'invalid-disk-for-type',
          message: `${body.data.disk} is not a resizable disk on a ${params.type} guest.`,
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

      let allowed: boolean;
      try {
        allowed = await hasPrivilege(identity.client, params.vmid, 'VM.Config.Disk');
      } catch (error) {
        app.log.warn({ err: error }, 'Failed to check VM.Config.Disk permission for guest disk resize');
        reply.code(502).send({ error: 'pve-unreachable' });
        return;
      }
      if (!allowed) {
        reply.code(403).send({ error: 'forbidden', missing: 'VM.Config.Disk' });
        return;
      }

      let upid: string | null;
      try {
        upid = await callResize(identity.client, params.type, params.node, params.vmid, body.data.disk, body.data.size);
      } catch (error) {
        if (sendPveError(reply, error)) return;
        app.log.warn({ err: error }, 'Guest disk resize request failed');
        reply.code(502).send({ error: 'pve-unreachable' });
        return;
      }

      app.log.info(
        {
          username: identity.username,
          node: params.node,
          type: params.type,
          vmid: params.vmid,
          disk: body.data.disk,
          size: body.data.size,
          upid,
        },
        'Guest disk resize requested',
      );
      if (upid === null) {
        reply.code(200).send({ ok: true });
        return;
      }
      reply.code(202).send({ upid });
    },
  );
}
