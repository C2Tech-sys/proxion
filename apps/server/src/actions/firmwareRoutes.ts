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
 * Guest firmware / platform hardware edits (T72): BIOS, machine type (+ version, vIOMMU), display,
 * SCSI controller, and adding an EFI disk or TPM state. One allow-listed write this server performs
 * against PVE, registered from `actionsRoutes` (`routes.ts`) so it shares its rate limiter, same
 * convention as `registerHardwareRoutes`. QEMU guests only. Every field is named here, validated,
 * and mapped to its PVE parameter explicitly; the raw `/api/pve/*` proxy stays read-only.
 */

/** Same shape diskRoutes.ts accepts for a storage id. */
const STORAGE_ID_RE = /^[A-Za-z][A-Za-z0-9._-]{0,63}$/;

/** A pinned machine version: `8.1`, `9.0+pve1`, `2.12.1`. */
const MACHINE_VERSION_RE = /^\d+\.\d+(\.\d+)?(\+pve\d+)?$/;

const VGA_TYPES = [
  'std',
  'cirrus',
  'vmware',
  'qxl',
  'qxl2',
  'qxl3',
  'qxl4',
  'serial0',
  'serial1',
  'serial2',
  'serial3',
  'virtio',
  'virtio-gl',
  'none',
] as const;

const SCSI_CONTROLLERS = [
  'lsi',
  'lsi53c810',
  'virtio-scsi-pci',
  'virtio-scsi-single',
  'megasas',
  'pvscsi',
] as const;

const machineSchema = z
  .object({
    type: z.enum(['i440fx', 'q35']),
    version: z.string().regex(MACHINE_VERSION_RE).max(32).optional(),
    viommu: z.enum(['intel', 'virtio']).optional(),
  })
  .strict()
  .refine((m) => m.viommu === undefined || m.type === 'q35', { message: 'vIOMMU needs the q35 machine type' });

const vgaSchema = z
  .object({
    type: z.enum(VGA_TYPES),
    memory: z.number().int().min(4).max(512).optional(),
  })
  .strict();

const efidiskSchema = z
  .object({
    storage: z.string().regex(STORAGE_ID_RE),
    efitype: z.enum(['2m', '4m']).optional(),
    preEnrolledKeys: z.boolean().optional(),
  })
  .strict();

const tpmstateSchema = z
  .object({
    storage: z.string().regex(STORAGE_ID_RE),
    version: z.enum(['v1.2', 'v2.0']),
  })
  .strict();

const firmwareBodySchema = z
  .object({
    bios: z.enum(['seabios', 'ovmf']).optional(),
    machine: machineSchema.nullable().optional(),
    vga: vgaSchema.nullable().optional(),
    scsihw: z.enum(SCSI_CONTROLLERS).optional(),
    efidisk: efidiskSchema.optional(),
    tpmstate: tpmstateSchema.optional(),
    digest: z.string().min(1).max(64).optional(),
  })
  .strict()
  .refine(
    (data) =>
      data.bios !== undefined ||
      data.machine !== undefined ||
      data.vga !== undefined ||
      data.scsihw !== undefined ||
      data.efidisk !== undefined ||
      data.tpmstate !== undefined,
    { message: 'At least one firmware field is required' },
  );

type FirmwareBody = z.infer<typeof firmwareBodySchema>;

interface GuestRouteParams {
  node: string;
  type: 'qemu' | 'lxc';
  vmid: number;
}

/** Parses/validates the common `:node/:type/:vmid` triple (kept local, same rationale as
 * `hardwareRoutes.ts`'s own copy). */
function parseGuestParams(rawParams: Record<string, string>): GuestRouteParams | undefined {
  const node = rawParams.node;
  const type = guestTypeSchema.safeParse(rawParams.type);
  const vmid = vmidSchema.safeParse(rawParams.vmid);
  if (!node || !type.success || !vmid.success) return undefined;
  return { node, type: type.data, vmid: vmid.data };
}

/** Same `502`/`4xx` mapping every guest-action route uses; `true` iff it sent a reply. */
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

/** PVE's `machine` string: `pc` / `pc-i440fx-<v>` / `q35` / `pc-q35-<v>`, plus `,viommu=<x>`. */
function composeMachine(machine: NonNullable<FirmwareBody['machine']>): string {
  const base =
    machine.type === 'q35'
      ? machine.version
        ? `pc-q35-${machine.version}`
        : 'q35'
      : machine.version
        ? `pc-i440fx-${machine.version}`
        : 'pc';
  return machine.viommu ? `${base},viommu=${machine.viommu}` : base;
}

/** PVE's `vga` string: `<type>[,memory=<MiB>]`. */
function composeVga(vga: NonNullable<FirmwareBody['vga']>): string {
  return vga.memory !== undefined ? `${vga.type},memory=${vga.memory}` : vga.type;
}

/** The PVE config parameters for this request, keyed by PVE's own config key. A `null`
 * machine/vga becomes one comma-joined `delete`. */
function toPveConfig(body: FirmwareBody): Record<string, string> {
  const out: Record<string, string> = {};
  const deletes: string[] = [];
  if (body.bios !== undefined) out.bios = body.bios;
  if (body.machine === null) deletes.push('machine');
  else if (body.machine !== undefined) out.machine = composeMachine(body.machine);
  if (body.vga === null) deletes.push('vga');
  else if (body.vga !== undefined) out.vga = composeVga(body.vga);
  if (body.scsihw !== undefined) out.scsihw = body.scsihw;
  if (body.efidisk !== undefined) {
    const efitype = body.efidisk.efitype ?? '4m';
    const keys = body.efidisk.preEnrolledKeys === false ? 0 : 1;
    out.efidisk0 = `${body.efidisk.storage}:1,efitype=${efitype},pre-enrolled-keys=${keys}`;
  }
  if (body.tpmstate !== undefined) {
    out.tpmstate0 = `${body.tpmstate.storage}:1,version=${body.tpmstate.version}`;
  }
  if (deletes.length > 0) out.delete = deletes.join(',');
  if (body.digest !== undefined) out.digest = body.digest;
  return out;
}

/** The config keys this request changes (a deleted key counts as changed; `delete`/`digest` are
 * plumbing, not config keys). */
function changedKeys(body: FirmwareBody): string[] {
  const keys: string[] = [];
  if (body.bios !== undefined) keys.push('bios');
  if (body.machine !== undefined) keys.push('machine');
  if (body.vga !== undefined) keys.push('vga');
  if (body.scsihw !== undefined) keys.push('scsihw');
  if (body.efidisk !== undefined) keys.push('efidisk0');
  if (body.tpmstate !== undefined) keys.push('tpmstate0');
  return keys;
}

interface PendingRow {
  key: string;
  pending?: unknown;
  delete?: unknown;
}

export function registerFirmwareRoutes(
  app: FastifyInstance,
  guestActionsRateLimit: ReturnType<FastifyInstance['rateLimit']>,
): void {
  app.put(
    '/api/actions/guest/:node/:type/:vmid/firmware',
    { onRequest: guestActionsRateLimit },
    async (req, reply) => {
      const params = parseGuestParams(req.params as Record<string, string>);
      if (!params) {
        reply.code(400).send({ error: 'Invalid node/type/vmid' });
        return;
      }
      if (params.type !== 'qemu') {
        reply.code(400).send({ error: 'qemu-only', message: 'Firmware settings only exist on QEMU guests.' });
        return;
      }

      const parsed = firmwareBodySchema.safeParse(req.body ?? {});
      if (!parsed.success) {
        reply.code(400).send({ error: 'Invalid request body' });
        return;
      }
      const body = parsed.data;

      const identity = await resolveIdentity(app, req);
      if (!identity) {
        reply.code(401).send({ error: 'Not authenticated' });
        return;
      }
      if (identity.credentials.type === 'token') {
        reply.code(403).send({ error: 'writes-disabled-in-token-mode' });
        return;
      }
      const client: PveClient = identity.client;

      // Privileges, only for what the body touches: HWType for the four platform fields, Disk on
      // the guest plus AllocateSpace on each target storage for the EFI disk / TPM state.
      const checks: Array<{ missing: string; check: () => Promise<boolean> }> = [];
      if (
        body.bios !== undefined ||
        body.machine !== undefined ||
        body.vga !== undefined ||
        body.scsihw !== undefined
      ) {
        checks.push({ missing: 'VM.Config.HWType', check: () => hasPrivilege(client, params.vmid, 'VM.Config.HWType') });
      }
      const storages = [...new Set([body.efidisk?.storage, body.tpmstate?.storage])].filter(
        (s): s is string => s !== undefined,
      );
      if (storages.length > 0) {
        checks.push({ missing: 'VM.Config.Disk', check: () => hasPrivilege(client, params.vmid, 'VM.Config.Disk') });
        for (const storage of storages) {
          checks.push({
            missing: 'Datastore.AllocateSpace',
            check: () => hasStoragePrivilege(client, storage, 'Datastore.AllocateSpace'),
          });
        }
      }
      let granted: boolean[];
      try {
        granted = await Promise.all(checks.map((c) => c.check()));
      } catch (error) {
        app.log.warn({ err: error }, 'Failed to check permissions for guest firmware update');
        reply.code(502).send({ error: 'pve-unreachable' });
        return;
      }
      const missingIndex = granted.findIndex((ok) => !ok);
      if (missingIndex !== -1) {
        reply.code(403).send({ error: 'forbidden', missing: checks[missingIndex]!.missing });
        return;
      }

      // Adding an EFI disk / TPM state over an existing one would orphan it; refuse instead.
      if (body.efidisk !== undefined || body.tpmstate !== undefined) {
        let current: Record<string, unknown>;
        try {
          current = (await client.get('/nodes/{node}/qemu/{vmid}/config', {
            node: params.node,
            vmid: params.vmid,
          })) as Record<string, unknown>;
        } catch (error) {
          if (sendPveError(reply, error)) return;
          app.log.warn({ err: error }, 'Failed to read current config for guest firmware update');
          reply.code(502).send({ error: 'pve-unreachable' });
          return;
        }
        const present = (key: string): boolean =>
          current[key] !== undefined && current[key] !== null && current[key] !== '';
        if (body.efidisk !== undefined && present('efidisk0')) {
          reply.code(400).send({ error: 'already-present', message: 'This VM already has an EFI disk.' });
          return;
        }
        if (body.tpmstate !== undefined && present('tpmstate0')) {
          reply.code(400).send({ error: 'already-present', message: 'This VM already has a TPM state disk.' });
          return;
        }
      }

      const config = toPveConfig(body);
      const changed = changedKeys(body);

      try {
        await client.put('/nodes/{node}/qemu/{vmid}/config', {
          node: params.node,
          vmid: params.vmid,
          ...config,
        } as never);
      } catch (error) {
        if (sendPveError(reply, error)) return;
        app.log.warn({ err: error }, 'Guest firmware update request failed');
        reply.code(502).send({ error: 'pve-unreachable' });
        return;
      }

      // Which of the changed keys PVE is holding back until the guest restarts. A failure to read
      // the pending list never fails the (already applied) update -- it just reports none.
      let pending: string[] = [];
      try {
        const rows: unknown = await client.get('/nodes/{node}/qemu/{vmid}/pending', {
          node: params.node,
          vmid: params.vmid,
        });
        const held = new Set(
          (Array.isArray(rows) ? (rows as PendingRow[]) : [])
            .filter((row) => row.pending !== undefined || (row.delete !== undefined && Boolean(row.delete)))
            .map((row) => row.key),
        );
        pending = changed.filter((key) => held.has(key));
      } catch (error) {
        app.log.warn({ err: error }, 'Failed to read pending config after guest firmware update');
      }

      // One line per update; the changed *keys* only.
      app.log.info(
        { username: identity.username, node: params.node, vmid: params.vmid, changed, pending },
        'Guest firmware updated',
      );
      reply.code(200).send({ ok: true, changed, pending });
    },
  );
}
