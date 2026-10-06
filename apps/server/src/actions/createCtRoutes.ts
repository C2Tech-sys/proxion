import { isIPv4, isIPv6 } from 'node:net';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import { PveApiError, type PveClient } from '@proxion/pve-api';
import { resolveIdentity } from '../pve/identity.js';
import { hasPrivilege, hasStoragePrivilege, formatPveErrorMessage, sanitizeMessage } from './shared.js';
import { composeNetValue, type NicBody } from './networkRoutes.js';

/**
 * Create container (T62): `POST /api/actions/guest/:node/lxc/create`, one more allow-listed write
 * this server performs against PVE (`POST /nodes/{node}/lxc`), registered from `actionsRoutes`
 * (`routes.ts`) so it shares its rate limiter, same convention as `registerCloneRoutes`. The raw
 * `/api/pve/*` proxy stays read-only; every PVE parameter is composed here from a validated, typed
 * body -- the caller never hands PVE a free-form property string.
 *
 * Privileges, checked BEFORE the POST: `VM.Allocate` on `/vms/<vmid>` and `Datastore.AllocateSpace`
 * on the root disk's storage. The template's own storage is left to PVE (it checks read access to
 * the volume itself) and its refusal is relayed.
 *
 * The root password is secret material: it travels browser -> this server -> PVE (which hashes it)
 * and is never logged, never echoed in a response, and never part of an error message. No log call
 * in this file is handed the request body or anything derived from it but the vmid.
 */

/** PVE's own vmid range (100-999999999), same as `newIdSchema` in `cloneRoutes.ts`. */
const vmidBodySchema = z.number().int().min(100).max(999999999);

const NODE_NAME_RE = /^[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?$/;
const STORAGE_ID_RE = /^[A-Za-z][A-Za-z0-9._-]{0,63}$/;
const BRIDGE_RE = /^[A-Za-z][A-Za-z0-9_.-]{0,14}$/;
const LXC_IFNAME_RE = /^eth\d{1,3}$/;
const MAC_RE = /^[0-9A-Fa-f]{2}(:[0-9A-Fa-f]{2}){5}$/;
const POOL_RE = /^[A-Za-z0-9._-]{1,64}$/;
const TAG_RE = /^[a-z0-9_][a-z0-9_\-+.]*$/i;
const MAX_TAGS = 32;
const MAX_TAG_LENGTH = 64;
/** A template file name on a `vztmpl` storage (never a path). */
const TEMPLATE_FILE_RE = /^[A-Za-z0-9][A-Za-z0-9._+~-]{0,254}$/;

/** An RFC 1123 style DNS name: dot-separated labels of letters, digits and inner hyphens. */
const DNS_NAME_RE = /^(?=.{1,255}$)[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*$/;

/** One OpenSSH public key line: `<type> <base64> [comment]` (same rule as the cloud-init route). */
const SSH_KEY_RE =
  /^(ssh-(rsa|ed25519|dss)|ecdsa-sha2-nistp(256|384|521)|sk-ssh-ed25519@openssh\.com|sk-ecdsa-sha2-nistp256@openssh\.com) [A-Za-z0-9+/=]+( [^\r\n]{0,256})?$/;
const MAX_SSH_KEYS = 64;
const MAX_SSH_KEY_LENGTH = 8192;
const MAX_NAMESERVERS = 3;

/** `a.b.c.d/n`, n in 0..32. */
function isIPv4Cidr(value: string): boolean {
  const slash = value.indexOf('/');
  if (slash === -1) return false;
  const prefix = value.slice(slash + 1);
  return isIPv4(value.slice(0, slash)) && /^\d{1,2}$/.test(prefix) && Number(prefix) <= 32;
}

/** `<ipv6>/n`, n in 0..128. */
function isIPv6Cidr(value: string): boolean {
  const slash = value.indexOf('/');
  if (slash === -1) return false;
  const prefix = value.slice(slash + 1);
  return isIPv6(value.slice(0, slash)) && /^\d{1,3}$/.test(prefix) && Number(prefix) <= 128;
}

/** A unicast MAC: the least-significant bit of the first byte (the multicast bit) is clear. */
function isUnicastMac(mac: string): boolean {
  return (Number.parseInt(mac.slice(0, 2), 16) & 1) === 0;
}

const storageIdSchema = z.string().regex(STORAGE_ID_RE);

const templateSchema = z
  .object({
    storage: storageIdSchema,
    volid: z.string().max(512),
  })
  .strict()
  .refine(
    (t) => {
      const prefix = `${t.storage}:vztmpl/`;
      return t.volid.startsWith(prefix) && TEMPLATE_FILE_RE.test(t.volid.slice(prefix.length));
    },
    { message: 'volid must be a template on the given storage' },
  );

const rootfsSchema = z
  .object({
    storage: storageIdSchema,
    sizeGiB: z.number().int().min(1).max(65536),
    acl: z.boolean().optional(),
    quota: z.boolean().optional(),
  })
  .strict();

const cpuSchema = z
  .object({
    cores: z.number().int().min(1).max(128),
    cpulimit: z.number().min(0).max(128).optional(),
    cpuunits: z.number().int().min(0).max(100000).optional(),
  })
  .strict();

const memorySchema = z
  .object({
    memoryMiB: z.number().int().min(16).max(4194304),
    swapMiB: z.number().int().min(0).max(4194304),
  })
  .strict();

const netSchema = z
  .object({
    name: z.string().regex(LXC_IFNAME_RE).default('eth0'),
    bridge: z.string().regex(BRIDGE_RE),
    ip: z
      .string()
      .refine((v) => v === 'dhcp' || v === 'manual' || isIPv4Cidr(v), { message: 'Invalid IPv4 address' })
      .optional(),
    gw: z.string().refine(isIPv4, { message: 'Invalid IPv4 gateway' }).optional(),
    ip6: z
      .string()
      .refine((v) => v === 'auto' || v === 'dhcp' || v === 'manual' || isIPv6Cidr(v), {
        message: 'Invalid IPv6 address',
      })
      .optional(),
    gw6: z.string().refine(isIPv6, { message: 'Invalid IPv6 gateway' }).optional(),
    tag: z.number().int().min(1).max(4094).optional(),
    firewall: z.boolean().default(true),
    hwaddr: z
      .string()
      .regex(MAC_RE)
      .refine(isUnicastMac, { message: 'Multicast MAC addresses are not allowed' })
      .optional(),
    mtu: z.number().int().min(64).max(65535).optional(),
  })
  .strict();

const dnsSchema = z
  .object({
    nameserver: z
      .array(z.string().refine((v) => isIPv4(v) || isIPv6(v), { message: 'Invalid IP address' }))
      .max(MAX_NAMESERVERS)
      .optional(),
    searchdomain: z.string().regex(DNS_NAME_RE).optional(),
  })
  .strict();

// `.strict()`: an unknown key is a 400, same rationale as every other guest-action body schema.
// Validation failures are never echoed in detail: the body holds the root password.
const createCtBodySchema = z
  .object({
    vmid: vmidBodySchema,
    hostname: z.string().regex(DNS_NAME_RE),
    pool: z.string().regex(POOL_RE).optional(),
    tags: z.array(z.string().max(MAX_TAG_LENGTH).regex(TAG_RE)).max(MAX_TAGS).optional(),
    start: z.boolean().default(false),
    unprivileged: z.boolean().default(true),
    nesting: z.boolean().default(true),
    password: z.string().min(5).max(256).optional(),
    sshKeys: z.array(z.string().max(MAX_SSH_KEY_LENGTH).regex(SSH_KEY_RE)).max(MAX_SSH_KEYS).optional(),
    template: templateSchema,
    rootfs: rootfsSchema,
    cpu: cpuSchema,
    memory: memorySchema,
    net: netSchema.nullable(),
    dns: dnsSchema.optional(),
  })
  .strict();

export type CreateCtBody = z.infer<typeof createCtBodySchema>;

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

/** A gateway only makes sense next to a static address of its own family. */
function netProblem(net: NonNullable<CreateCtBody['net']>): string | undefined {
  if (net.gw !== undefined && !(net.ip !== undefined && isIPv4Cidr(net.ip))) return 'gw needs a static ip (CIDR)';
  if (net.gw6 !== undefined && !(net.ip6 !== undefined && isIPv6Cidr(net.ip6))) return 'gw6 needs a static ip6 (CIDR)';
  return undefined;
}

/** `<storage>:<sizeGiB>[,acl=1][,quota=1]` -- PVE allocates a new volume of that many GiB. */
function composeRootfs(rootfs: CreateCtBody['rootfs']): string {
  const parts = [`${rootfs.storage}:${rootfs.sizeGiB}`];
  if (rootfs.acl === true) parts.push('acl=1');
  if (rootfs.quota === true) parts.push('quota=1');
  return parts.join(',');
}

/**
 * Maps the typed body onto `POST /nodes/{node}/lxc`'s parameters (pure). Keys PVE would take its
 * own default for are left out: no `ostype` (PVE detects it from the template), no NIC / DNS
 * settings the body does not carry (the container then inherits the host's resolver settings).
 * `ssh-public-keys` is the keys joined by a newline and sent as-is -- unlike a VM's `sshkeys`
 * config value, the container create parameter is NOT URL-encoded (the form transport encodes it).
 */
export function composeCreateCtParams(body: CreateCtBody): Record<string, string | number | boolean> {
  const params: Record<string, string | number | boolean> = {
    vmid: body.vmid,
    hostname: body.hostname,
    ostemplate: body.template.volid,
  };
  if (body.password !== undefined) params.password = body.password;
  if (body.sshKeys !== undefined && body.sshKeys.length > 0) params['ssh-public-keys'] = body.sshKeys.join('\n');
  params.unprivileged = body.unprivileged;
  if (body.nesting) params.features = 'nesting=1';
  params.rootfs = composeRootfs(body.rootfs);
  params.cores = body.cpu.cores;
  if (body.cpu.cpulimit !== undefined) params.cpulimit = body.cpu.cpulimit;
  if (body.cpu.cpuunits !== undefined) params.cpuunits = body.cpu.cpuunits;
  params.memory = body.memory.memoryMiB;
  params.swap = body.memory.swapMiB;

  if (body.net !== null) {
    const nic: NicBody = { name: body.net.name, bridge: body.net.bridge, firewall: body.net.firewall };
    if (body.net.ip !== undefined) nic.ip = body.net.ip;
    if (body.net.gw !== undefined) nic.gw = body.net.gw;
    if (body.net.ip6 !== undefined) nic.ip6 = body.net.ip6;
    if (body.net.gw6 !== undefined) nic.gw6 = body.net.gw6;
    if (body.net.tag !== undefined) nic.vlan = body.net.tag;
    if (body.net.mtu !== undefined) nic.mtu = body.net.mtu;
    params.net0 = composeNetValue('lxc', 'net0', nic, body.net.hwaddr);
  }

  if (body.dns?.nameserver !== undefined && body.dns.nameserver.length > 0) {
    params.nameserver = body.dns.nameserver.join(' ');
  }
  if (body.dns?.searchdomain !== undefined) params.searchdomain = body.dns.searchdomain;
  if (body.pool !== undefined) params.pool = body.pool;
  if (body.tags !== undefined && body.tags.length > 0) params.tags = body.tags.join(';');
  params.start = body.start;
  return params;
}

interface ClusterResourceRow {
  type?: string;
  vmid?: number;
}

async function vmidInUse(client: PveClient, vmid: number): Promise<boolean> {
  const resources = (await client.get('/cluster/resources', {})) as ClusterResourceRow[];
  return resources.some((r) => (r.type === 'qemu' || r.type === 'lxc') && r.vmid === vmid);
}

export function registerCreateCtRoutes(
  app: FastifyInstance,
  guestActionsRateLimit: ReturnType<FastifyInstance['rateLimit']>,
): void {
  app.post('/api/actions/guest/:node/lxc/create', { onRequest: guestActionsRateLimit }, async (req, reply) => {
    const node = (req.params as Record<string, string>).node;
    if (!node || !NODE_NAME_RE.test(node)) {
      reply.code(400).send({ error: 'Invalid node' });
      return;
    }

    // Never echo a validation failure's detail: the body holds the root password.
    const parsed = createCtBodySchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      reply.code(400).send({ error: 'Invalid request body' });
      return;
    }
    const body = parsed.data;

    if (body.password === undefined && (body.sshKeys === undefined || body.sshKeys.length === 0)) {
      reply.code(400).send({ error: 'Invalid request body', message: 'A root password or an SSH public key is required' });
      return;
    }
    if (body.net !== null) {
      const problem = netProblem(body.net);
      if (problem !== undefined) {
        reply.code(400).send({ error: 'Invalid request body', message: problem });
        return;
      }
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

    let hasAllocate: boolean;
    let hasAllocateSpace: boolean;
    try {
      [hasAllocate, hasAllocateSpace] = await Promise.all([
        hasPrivilege(client, body.vmid, 'VM.Allocate'),
        hasStoragePrivilege(client, body.rootfs.storage, 'Datastore.AllocateSpace'),
      ]);
    } catch (error) {
      app.log.warn({ err: error }, 'Failed to check permissions for container create');
      reply.code(502).send({ error: 'pve-unreachable' });
      return;
    }
    if (!hasAllocate) {
      reply.code(403).send({ error: 'forbidden', missing: 'VM.Allocate' });
      return;
    }
    if (!hasAllocateSpace) {
      reply.code(403).send({ error: 'forbidden', missing: 'Datastore.AllocateSpace' });
      return;
    }

    try {
      if (await vmidInUse(client, body.vmid)) {
        reply.code(409).send({ error: 'vmid-taken', message: `ID ${body.vmid} is already in use` });
        return;
      }
    } catch (error) {
      app.log.warn({ err: error }, 'Failed to look up cluster state for container create');
      reply.code(502).send({ error: 'pve-unreachable' });
      return;
    }

    let upid: string;
    try {
      upid = await client.post('/nodes/{node}/lxc', { node, ...composeCreateCtParams(body) } as never);
    } catch (error) {
      if (sendPveError(reply, error)) return;
      app.log.warn({ err: error }, 'Container create request failed');
      reply.code(502).send({ error: 'pve-unreachable' });
      return;
    }

    // One line per create: who, where, which id -- never the body (it holds the root password).
    app.log.info({ username: identity.username, node, vmid: body.vmid, upid }, 'Container create requested');
    reply.code(202).send({ upid, vmid: body.vmid });
  });
}
