import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import { PveApiError, type PveClient } from '@proxion/pve-api';
import { resolveIdentity } from '../pve/identity.js';
import { composeNetValue, type NicBody } from './networkRoutes.js';
import { hasPrivilege, hasStoragePrivilege, formatPveErrorMessage, sanitizeMessage } from './shared.js';

/**
 * Create VM wizard backend (T61): one allow-listed write, `POST /nodes/{node}/qemu`, registered from
 * `actionsRoutes` (`routes.ts`) so it shares the guest-actions rate limiter, same convention as
 * `registerNetworkRoutes`. The raw `/api/pve/*` proxy stays read-only; every config key PVE gets is
 * composed here from a validated, typed body (the caller never hands PVE a free-form property
 * string). Session sign-in only. See "Guest actions" in README.md for the contract.
 *
 * Privileges, all checked BEFORE the POST: `VM.Allocate` on `/vms/<vmid>` (resolved by PVE for a
 * not-yet-existing vmid, same as clone's target id), `Datastore.AllocateSpace` on every storage a
 * new volume is allocated on (disk, EFI disk, TPM state), and -- for an ISO -- PVE's own rule for
 * reading install media (`Datastore.Audit` OR `Datastore.AllocateSpace` on the ISO's storage). The
 * per-config `VM.Config.*` privileges are left to PVE, whose 403 is relayed.
 */

const NODE_NAME_RE = /^[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?$/;

/** Same shape/rationale as `STORAGE_ID_RE` in `diskRoutes.ts`: free of `:`, `,` and `=` so it can
 * only ever be one segment of a property string. */
const STORAGE_ID_RE = /^[A-Za-z][A-Za-z0-9._-]{0,63}$/;
const storageIdSchema = z.string().regex(STORAGE_ID_RE);

/** An ISO file name inside `<storage>:iso/`: no `/`, `,`, `;`, `=` or whitespace, never leading with
 * a dot, so it can only ever be one segment of the `ide2` property string. */
const ISO_FILE_RE = /^[A-Za-z0-9][A-Za-z0-9._+()@~-]{0,254}$/;

const POOL_RE = /^[A-Za-z][A-Za-z0-9_-]{0,62}$/;
const TAG_RE = /^[a-z0-9_][a-z0-9_\-+.]*$/i;
const MAX_TAGS = 32;
const MAX_TAG_LENGTH = 64;
const CPU_TYPE_RE = /^[A-Za-z0-9._+-]{1,64}$/;
const MAC_RE = /^[0-9A-Fa-f]{2}(:[0-9A-Fa-f]{2}){5}$/;
const BRIDGE_RE = /^[A-Za-z][A-Za-z0-9_.-]{0,14}$/;

/** `name` is capped at 63 characters in total, same as `optionsRoutes.ts`. */
const MAX_NAME_LENGTH = 63;
const DNS_LABEL_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/;
function isValidDnsName(value: string, maxLength: number): boolean {
  if (value.length === 0 || value.length > maxLength) return false;
  return value.split('.').every((label) => DNS_LABEL_RE.test(label));
}

/** Same enum as `OSTYPES` in `optionsRoutes.ts`. */
const OSTYPES = [
  'other',
  'wxp',
  'w2k',
  'w2k3',
  'w2k8',
  'wvista',
  'win7',
  'win8',
  'win10',
  'win11',
  'l24',
  'l26',
  'solaris',
] as const;

const MAX_SIZE_GIB = 65536;
const MAX_MEMORY_MIB = 4194304;
/** PVE's `mtu` range for a qemu NIC (`1` = use the bridge MTU, VirtIO only). */
const MTU_MAX = 65520;

const osSchema = z.discriminatedUnion('media', [
  z.object({ media: z.literal('iso'), storage: storageIdSchema, volid: z.string().max(400) }).strict(),
  z.object({ media: z.literal('none') }).strict(),
]);

const systemSchema = z
  .object({
    machine: z.enum(['q35', 'pc']).default('pc'),
    bios: z.enum(['seabios', 'ovmf']).default('seabios'),
    efiStorage: storageIdSchema.optional(),
    tpm: z.boolean().optional(),
    tpmStorage: storageIdSchema.optional(),
    scsihw: z.enum(['virtio-scsi-single', 'virtio-scsi-pci', 'lsi']).default('virtio-scsi-single'),
    vga: z.enum(['std', 'virtio', 'qxl', 'serial0', 'none']).optional(),
  })
  .strict();

const diskSchema = z
  .object({
    bus: z.enum(['scsi', 'virtio', 'sata', 'ide']),
    storage: storageIdSchema,
    sizeGiB: z.number().int().min(1).max(MAX_SIZE_GIB),
    format: z.enum(['raw', 'qcow2', 'vmdk']).optional(),
    discard: z.boolean().optional(),
    ssd: z.boolean().optional(),
    iothread: z.boolean().optional(),
    cache: z.enum(['none', 'writethrough', 'writeback', 'unsafe', 'directsync']).optional(),
  })
  .strict();

const cpuSchema = z
  .object({
    sockets: z.number().int().min(1).max(4),
    cores: z.number().int().min(1).max(128),
    type: z.string().regex(CPU_TYPE_RE).default('x86-64-v2-AES'),
    numa: z.boolean().optional(),
  })
  .strict();

const memorySchema = z
  .object({
    memoryMiB: z.number().int().min(16).max(MAX_MEMORY_MIB),
    balloonMiB: z.number().int().min(0).max(MAX_MEMORY_MIB).optional(),
  })
  .strict();

const netSchema = z
  .object({
    model: z.enum(['virtio', 'e1000', 'e1000e', 'vmxnet3', 'rtl8139']),
    bridge: z.string().regex(BRIDGE_RE),
    tag: z.number().int().min(1).max(4094).optional(),
    firewall: z.boolean().default(true),
    macaddr: z
      .string()
      .regex(MAC_RE)
      // A unicast MAC: the least-significant bit of the first byte (the multicast bit) is clear.
      .refine((mac) => (Number.parseInt(mac.slice(0, 2), 16) & 1) === 0, {
        message: 'Multicast MAC addresses are not allowed',
      })
      .optional(),
    mtu: z.number().int().min(1).max(MTU_MAX).optional(),
  })
  .strict();

// `.strict()`: an unknown key is a 400, same rationale as every other guest-action body schema.
const createBodySchema = z
  .object({
    vmid: z.number().int().min(100).max(999999999),
    name: z.string().refine((v) => isValidDnsName(v, MAX_NAME_LENGTH), { message: 'Invalid DNS name' }),
    pool: z.string().regex(POOL_RE).optional(),
    tags: z.array(z.string().max(MAX_TAG_LENGTH).regex(TAG_RE)).max(MAX_TAGS).optional(),
    start: z.boolean().default(false),
    os: osSchema,
    ostype: z.enum(OSTYPES).default('other'),
    agent: z.boolean().default(false),
    system: systemSchema.default({ machine: 'pc', bios: 'seabios', scsihw: 'virtio-scsi-single' }),
    disk: diskSchema.nullable(),
    cpu: cpuSchema,
    memory: memorySchema,
    net: netSchema.nullable(),
  })
  .strict();

type CreateBody = z.infer<typeof createBodySchema>;

/** Cross-field rules zod can't express per key; returns the 400 message, or `undefined` when valid. */
function crossFieldError(body: CreateBody): string | undefined {
  const { os, system, disk, memory } = body;
  if (os.media === 'iso' && !os.volid.startsWith(`${os.storage}:iso/`)) {
    return `volid must start with ${os.storage}:iso/`;
  }
  if (os.media === 'iso' && !ISO_FILE_RE.test(os.volid.slice(`${os.storage}:iso/`.length))) {
    return 'volid is not a valid ISO file name';
  }
  if (system.bios === 'ovmf' && system.efiStorage === undefined) return 'efiStorage is required with OVMF';
  if (system.bios !== 'ovmf' && system.efiStorage !== undefined) return 'efiStorage is only valid with OVMF';
  if (system.tpm === true && system.tpmStorage === undefined) return 'tpmStorage is required with a TPM';
  if (system.tpm !== true && system.tpmStorage !== undefined) return 'tpmStorage is only valid with a TPM';
  if (disk !== null) {
    if (disk.ssd === true && disk.bus === 'virtio') return 'ssd is not valid on a virtio disk';
    if (disk.iothread === true && disk.bus !== 'scsi' && disk.bus !== 'virtio') {
      return 'iothread is only valid on a scsi or virtio disk';
    }
  }
  if (memory.balloonMiB !== undefined && memory.balloonMiB > memory.memoryMiB) {
    return 'balloonMiB must not exceed memoryMiB';
  }
  return undefined;
}

/** The `<bus>0: <storage>:<size>[,format=][,discard=on][,ssd=1][,iothread=1][,cache=]` value. */
function composeDiskValue(disk: NonNullable<CreateBody['disk']>): string {
  const parts = [`${disk.storage}:${disk.sizeGiB}`];
  if (disk.format !== undefined) parts.push(`format=${disk.format}`);
  if (disk.discard === true) parts.push('discard=on');
  if (disk.ssd === true) parts.push('ssd=1');
  if (disk.iothread === true) parts.push('iothread=1');
  if (disk.cache !== undefined) parts.push(`cache=${disk.cache}`);
  return parts.join(',');
}

/** The full `POST /nodes/{node}/qemu` parameter map (everything but `node`), composed from a body
 * that already passed `crossFieldError`. Values are what PVE's form takes (numbers/booleans are
 * serialised by the client; property strings are composed here). */
export function composeCreateParams(body: CreateBody): Record<string, string | number | boolean> {
  const params: Record<string, string | number | boolean> = {
    vmid: body.vmid,
    name: body.name,
    ostype: body.ostype,
    bios: body.system.bios,
    scsihw: body.system.scsihw,
    cores: body.cpu.cores,
    sockets: body.cpu.sockets,
    cpu: body.cpu.type,
    memory: body.memory.memoryMiB,
    start: body.start,
  };
  // PVE's own default machine is i440fx, so `pc` sends nothing.
  if (body.system.machine === 'q35') params.machine = 'q35';
  if (body.agent) params.agent = 'enabled=1';
  if (body.cpu.numa !== undefined) params.numa = body.cpu.numa;
  if (body.memory.balloonMiB !== undefined) params.balloon = body.memory.balloonMiB;
  if (body.system.vga !== undefined) params.vga = body.system.vga;
  if (body.pool !== undefined) params.pool = body.pool;
  if (body.tags !== undefined && body.tags.length > 0) params.tags = body.tags.join(';');

  if (body.system.bios === 'ovmf' && body.system.efiStorage !== undefined) {
    params.efidisk0 = `${body.system.efiStorage}:1,efitype=4m,pre-enrolled-keys=1`;
  }
  if (body.system.tpm === true && body.system.tpmStorage !== undefined) {
    params.tpmstate0 = `${body.system.tpmStorage}:1,version=v2.0`;
  }

  const bootOrder: string[] = [];
  if (body.disk !== null) {
    const slot = `${body.disk.bus}0`;
    params[slot] = composeDiskValue(body.disk);
    bootOrder.push(slot);
  }
  if (body.os.media === 'iso') {
    params.ide2 = `${body.os.volid},media=cdrom`;
    bootOrder.push('ide2');
  }
  if (body.net !== null) {
    const nic: NicBody = {
      model: body.net.model,
      bridge: body.net.bridge,
      ...(body.net.tag !== undefined ? { vlan: body.net.tag } : {}),
      ...(body.net.firewall ? { firewall: true } : {}),
      ...(body.net.mtu !== undefined ? { mtu: body.net.mtu } : {}),
    };
    params.net0 = composeNetValue('qemu', 'net0', nic, body.net.macaddr);
    bootOrder.push('net0');
  }
  if (bootOrder.length > 0) params.boot = `order=${bootOrder.join(';')}`;
  return params;
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

interface ClusterResourceRow {
  type?: string;
  vmid?: number;
}

async function vmidTaken(client: PveClient, vmid: number): Promise<boolean> {
  const resources = (await client.get('/cluster/resources', {})) as ClusterResourceRow[];
  return resources.some((r) => (r.type === 'qemu' || r.type === 'lxc') && r.vmid === vmid);
}

export function registerCreateVmRoutes(
  app: FastifyInstance,
  guestActionsRateLimit: ReturnType<FastifyInstance['rateLimit']>,
): void {
  app.post('/api/actions/guest/:node/qemu/create', { onRequest: guestActionsRateLimit }, async (req, reply) => {
    const node = (req.params as Record<string, string>).node;
    if (!node || node.length > 63 || !NODE_NAME_RE.test(node)) {
      reply.code(400).send({ error: 'Invalid node' });
      return;
    }

    const parsed = createBodySchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      reply.code(400).send({ error: 'Invalid request body' });
      return;
    }
    const body = parsed.data;
    const invalid = crossFieldError(body);
    if (invalid !== undefined) {
      reply.code(400).send({ error: 'Invalid request body', message: invalid });
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

    // Privileges first, so a caller without VM.Allocate can't probe which vmids exist.
    try {
      if (!(await hasPrivilege(client, body.vmid, 'VM.Allocate'))) {
        reply.code(403).send({ error: 'forbidden', missing: 'VM.Allocate' });
        return;
      }

      const allocStorages = new Set<string>();
      if (body.disk !== null) allocStorages.add(body.disk.storage);
      if (body.system.bios === 'ovmf' && body.system.efiStorage !== undefined) allocStorages.add(body.system.efiStorage);
      if (body.system.tpm === true && body.system.tpmStorage !== undefined) allocStorages.add(body.system.tpmStorage);
      for (const storage of allocStorages) {
        if (!(await hasStoragePrivilege(client, storage, 'Datastore.AllocateSpace'))) {
          reply.code(403).send({ error: 'forbidden', missing: 'Datastore.AllocateSpace', storage });
          return;
        }
      }

      // Attaching an ISO needs read access to its storage: PVE accepts Datastore.Audit OR
      // Datastore.AllocateSpace there (a storage already checked above is not asked twice).
      if (body.os.media === 'iso' && !allocStorages.has(body.os.storage)) {
        const isoStorage = body.os.storage;
        const canRead =
          (await hasStoragePrivilege(client, isoStorage, 'Datastore.Audit')) ||
          (await hasStoragePrivilege(client, isoStorage, 'Datastore.AllocateSpace'));
        if (!canRead) {
          reply.code(403).send({ error: 'forbidden', missing: 'Datastore.Audit', storage: isoStorage });
          return;
        }
      }
    } catch (error) {
      app.log.warn({ err: error }, 'Failed to check permissions for VM create');
      reply.code(502).send({ error: 'pve-unreachable' });
      return;
    }

    try {
      if (await vmidTaken(client, body.vmid)) {
        reply.code(409).send({ error: 'vmid-taken', message: `VM ID ${body.vmid} is already in use` });
        return;
      }
    } catch (error) {
      app.log.warn({ err: error }, 'Failed to look up cluster state for VM create');
      reply.code(502).send({ error: 'pve-unreachable' });
      return;
    }

    let upid: string;
    try {
      upid = await client.post('/nodes/{node}/qemu', { node, ...composeCreateParams(body) } as never);
    } catch (error) {
      if (sendPveError(reply, error)) return;
      app.log.warn({ err: error }, 'VM create request failed');
      reply.code(502).send({ error: 'pve-unreachable' });
      return;
    }

    // One line per create; ids and placement only, never a config value.
    app.log.info({ username: identity.username, node, vmid: body.vmid, upid }, 'VM create requested');
    reply.code(202).send({ upid, vmid: body.vmid });
  });
}
