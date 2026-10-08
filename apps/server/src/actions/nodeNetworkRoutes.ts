import { lookup } from 'node:dns/promises';
import { isIPv4, isIPv6 } from 'node:net';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { PveApiError, type PveClient } from '@proxion/pve-api';
import { resolveIdentity } from '../pve/identity.js';
import { formatPveErrorMessage, hasNodePrivilege, sanitizeMessage } from './shared.js';

/**
 * Node network editor (T69): create / edit / delete a bridge, bond or VLAN interface, edit a
 * physical interface's addressing, and apply or revert the pending network configuration. Six
 * more allow-listed calls this server performs against PVE, registered from `actionsRoutes`
 * (`routes.ts`) so they share its rate limiter, same convention as `registerNetworkRoutes`. The raw
 * `/api/pve/*` proxy stays read-only; the interface list and PVE's pending `changes` diff are read
 * through it (it forwards PVE's whole JSON body, so the top-level `changes` string beside `data`
 * reaches the browser).
 *
 * Every write needs `Sys.Modify` on `/nodes/{node}`. PVE stages these edits in
 * `/etc/network/interfaces.new`; nothing touches the live network until `POST .../apply`, which can
 * cut the node off the network if the configuration is wrong -- the browser asks for a typed
 * confirmation first.
 *
 * PVE's create/update API has no `method` parameter (it derives static vs manual from whether an
 * address is set), so `method` here is a validated intent only and is never forwarded: `static`
 * needs a `cidr`, `manual` means no address (an edit deletes `cidr`/`gateway`). `dhcp` cannot be
 * configured through this PVE endpoint and is refused with `400 dhcp-unsupported`.
 */

const NETWORK_PRIVILEGE = 'Sys.Modify';

const NODE_NAME_RE = /^[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?$/;
const nodeNameSchema = z.string().min(1).max(63).regex(NODE_NAME_RE);

const IFACE_RE = /^[A-Za-z0-9._-]{1,15}$/;
const BRIDGE_IFACE_RE = /^vmbr\d{1,4}$/;
const VLAN_DOTTED_RE = /^(.+)\.(\d{1,4})$/;
const PORT_LIST_RE = /^[A-Za-z0-9._ -]*$/;

const BOND_MODES = [
  'balance-rr',
  'active-backup',
  'balance-xor',
  'broadcast',
  '802.3ad',
  'balance-tlb',
  'balance-alb',
] as const;
const XMIT_POLICIES = ['layer2', 'layer2+3', 'layer3+4'] as const;

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

/** No C0 control characters or DEL (a comment ends up in /etc/network/interfaces). */
function hasNoControlChars(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) return false;
  }
  return true;
}

const ifaceSchema = z.string().regex(IFACE_RE);
const cidrSchema = z.string().refine(isIPv4Cidr, { message: 'Invalid IPv4 CIDR' });
const gatewaySchema = z.string().refine(isIPv4, { message: 'Invalid IPv4 gateway' });
const cidr6Schema = z.string().refine(isIPv6Cidr, { message: 'Invalid IPv6 CIDR' });
const gateway6Schema = z.string().refine(isIPv6, { message: 'Invalid IPv6 gateway' });
const mtuSchema = z.number().int().min(576).max(65520);
const commentsSchema = z.string().max(256).refine(hasNoControlChars, { message: 'Invalid characters' });
const portListSchema = z.string().max(256).regex(PORT_LIST_RE);
const vlanIdSchema = z.number().int().min(1).max(4094);

const METHODS = ['static', 'dhcp', 'manual'] as const;

const createBodySchema = z
  .object({
    type: z.enum(['bridge', 'bond', 'vlan']),
    iface: ifaceSchema,
    autostart: z.boolean().default(true),
    method: z.enum(METHODS).optional(),
    cidr: cidrSchema.optional(),
    gateway: gatewaySchema.optional(),
    cidr6: cidr6Schema.optional(),
    gateway6: gateway6Schema.optional(),
    mtu: mtuSchema.optional(),
    comments: commentsSchema.optional(),
    bridge_ports: portListSchema.optional(),
    bridge_vlan_aware: z.boolean().optional(),
    slaves: portListSchema.optional(),
    bond_mode: z.enum(BOND_MODES).optional(),
    bond_xmit_hash_policy: z.enum(XMIT_POLICIES).optional(),
    'bond-primary': ifaceSchema.optional(),
    'vlan-id': vlanIdSchema.optional(),
    'vlan-raw-device': ifaceSchema.optional(),
  })
  .strict();

type CreateBody = z.infer<typeof createBodySchema>;

/** Edit body: every field optional; an explicit `null` clears a clearable field (sent to PVE as
 * part of `delete`). `type` is accepted only to be checked against the interface's real type. */
const updateBodySchema = z
  .object({
    type: z.enum(['bridge', 'bond', 'vlan', 'eth']).optional(),
    autostart: z.boolean().optional(),
    method: z.enum(METHODS).optional(),
    cidr: cidrSchema.nullable().optional(),
    gateway: gatewaySchema.nullable().optional(),
    cidr6: cidr6Schema.nullable().optional(),
    gateway6: gateway6Schema.nullable().optional(),
    mtu: mtuSchema.nullable().optional(),
    comments: commentsSchema.nullable().optional(),
    bridge_ports: portListSchema.nullable().optional(),
    bridge_vlan_aware: z.boolean().optional(),
    slaves: portListSchema.optional(),
    bond_mode: z.enum(BOND_MODES).optional(),
    bond_xmit_hash_policy: z.enum(XMIT_POLICIES).nullable().optional(),
    'bond-primary': ifaceSchema.nullable().optional(),
    'vlan-id': vlanIdSchema.optional(),
    'vlan-raw-device': ifaceSchema.nullable().optional(),
  })
  .strict();

type UpdateBody = z.infer<typeof updateBodySchema>;

const emptyBodySchema = z.object({}).strict();

/** Fields valid for every interface type. */
const COMMON_FIELDS = ['autostart', 'method', 'cidr', 'gateway', 'cidr6', 'gateway6', 'mtu', 'comments'];
const TYPE_FIELDS: Record<string, readonly string[]> = {
  bridge: ['bridge_ports', 'bridge_vlan_aware'],
  bond: ['slaves', 'bond_mode', 'bond_xmit_hash_policy', 'bond-primary'],
  vlan: ['vlan-id', 'vlan-raw-device'],
  eth: [],
  alias: [],
};
const ALL_TYPE_SPECIFIC = Object.values(TYPE_FIELDS).flat();

/** Fields of `body` that are set but not valid for an interface of `type`. */
function wrongFieldsFor(type: string, body: Record<string, unknown>): string[] {
  const allowed = new Set([...COMMON_FIELDS, ...(TYPE_FIELDS[type] ?? [])]);
  return ALL_TYPE_SPECIFIC.filter((field) => body[field] !== undefined && !allowed.has(field));
}

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

function badBody(reply: FastifyReply, message?: string): void {
  reply.code(400).send(message === undefined ? { error: 'Invalid request body' } : { error: 'Invalid request body', message });
}

/** The shared session/token/`Sys.Modify` gate. Sends the failure reply itself and returns
 * `undefined`; otherwise returns the caller's identity. */
async function authorize(app: FastifyInstance, req: FastifyRequest, reply: FastifyReply, node: string) {
  const identity = await resolveIdentity(app, req);
  if (!identity) {
    reply.code(401).send({ error: 'Not authenticated' });
    return undefined;
  }
  if (identity.credentials.type === 'token') {
    reply.code(403).send({ error: 'writes-disabled-in-token-mode' });
    return undefined;
  }
  let allowed: boolean;
  try {
    allowed = await hasNodePrivilege(identity.client, node, NETWORK_PRIVILEGE);
  } catch (error) {
    if (sendPveError(reply, error)) return undefined;
    app.log.warn({ err: error }, 'Failed to check Sys.Modify permission for node network update');
    reply.code(502).send({ error: 'pve-unreachable' });
    return undefined;
  }
  if (!allowed) {
    reply.code(403).send({ error: 'forbidden', missing: NETWORK_PRIVILEGE });
    return undefined;
  }
  return identity;
}

/** One row of `GET /nodes/{node}/network` this route cares about. */
interface IfaceRow {
  iface: string;
  type: string;
  cidr?: string;
  cidr6?: string;
}

async function listInterfaces(client: PveClient, node: string): Promise<IfaceRow[]> {
  const rows: unknown = await client.get('/nodes/{node}/network', { node });
  return (Array.isArray(rows) ? rows : []) as IfaceRow[];
}

/**
 * The IPv4 addresses this server reaches PVE at: the `PVE_URL` host when it is an IPv4 literal, or
 * what it resolves to. Best effort -- `[]` when it cannot be determined (an IPv6/odd host, or DNS
 * failing), in which case the management-interface refusal is skipped.
 */
async function reachedAddresses(pveUrl: string): Promise<string[]> {
  let host: string;
  try {
    host = new URL(pveUrl).hostname;
  } catch {
    return [];
  }
  if (isIPv4(host)) return [host];
  try {
    const found = await lookup(host, { all: true, family: 4 });
    return found.map((entry) => entry.address);
  } catch {
    return [];
  }
}

/** The address part of a CIDR (`10.0.0.11/24` -> `10.0.0.11`). */
function cidrAddress(cidr: string | undefined): string | undefined {
  if (cidr === undefined) return undefined;
  const slash = cidr.indexOf('/');
  return slash === -1 ? cidr : cidr.slice(0, slash);
}

/** `delete` entries for fields the body set to an explicit `null` (or an empty port list). */
function deletionsFor(body: UpdateBody): string[] {
  const out: string[] = [];
  const clearable = [
    'cidr',
    'gateway',
    'cidr6',
    'gateway6',
    'mtu',
    'comments',
    'bridge_ports',
    'bond_xmit_hash_policy',
    'bond-primary',
    'vlan-raw-device',
  ] as const;
  for (const key of clearable) {
    const value = body[key];
    if (value === null || (key === 'bridge_ports' && value === '')) out.push(key);
  }
  return out;
}

/** Body fields to forward to PVE for an edit: every non-null, defined field except the intent-only
 * `method` and the verified-only `type`. */
function updateParams(body: UpdateBody): Record<string, string | number | boolean> {
  const params: Record<string, string | number | boolean> = {};
  for (const [key, value] of Object.entries(body)) {
    if (key === 'method' || key === 'type') continue;
    if (value === undefined || value === null) continue;
    if (key === 'bridge_ports' && value === '') continue;
    params[key] = value as string | number | boolean;
  }
  return params;
}

/** The checks shared by create and edit on the `method` intent. Returns an error message. */
function methodProblem(method: string | undefined, hasCidr: boolean): string | undefined {
  if (method === 'dhcp') return 'DHCP cannot be configured through the Proxmox VE network API; use a static or manual address.';
  if (method === 'static' && !hasCidr) return 'A static address needs a CIDR.';
  return undefined;
}

export function registerNodeNetworkRoutes(
  app: FastifyInstance,
  guestActionsRateLimit: ReturnType<FastifyInstance['rateLimit']>,
): void {
  app.post('/api/actions/node/:node/network', { onRequest: guestActionsRateLimit }, async (req, reply) => {
    const node = nodeNameSchema.safeParse((req.params as Record<string, string>).node);
    if (!node.success) {
      reply.code(400).send({ error: 'Invalid node' });
      return;
    }
    const parsed = createBodySchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      badBody(reply);
      return;
    }
    const body: CreateBody = parsed.data;

    if (body.type === 'bridge' && !BRIDGE_IFACE_RE.test(body.iface)) {
      badBody(reply, 'A bridge must be named vmbr<number>.');
      return;
    }
    const wrong = wrongFieldsFor(body.type, body);
    if (wrong.length > 0) {
      reply.code(400).send({
        error: 'invalid-field-for-type',
        message: `${wrong.join(', ')} ${wrong.length === 1 ? 'is' : 'are'} not valid for a ${body.type} interface.`,
      });
      return;
    }
    if (body.type === 'bond') {
      if (body.slaves === undefined || body.slaves.trim() === '') {
        badBody(reply, 'A bond needs at least one slave interface.');
        return;
      }
      if (body.bond_mode === undefined) {
        badBody(reply, 'A bond needs a bond mode.');
        return;
      }
    }
    if (body.type === 'vlan') {
      const dotted = VLAN_DOTTED_RE.exec(body.iface);
      const explicit = body['vlan-id'] !== undefined && body['vlan-raw-device'] !== undefined;
      if (!dotted && !explicit) {
        badBody(reply, 'A VLAN needs a <device>.<id> name, or both vlan-id and vlan-raw-device.');
        return;
      }
    }
    if (body.gateway !== undefined && body.cidr === undefined) {
      badBody(reply, 'A gateway needs a CIDR.');
      return;
    }
    if (body.gateway6 !== undefined && body.cidr6 === undefined) {
      badBody(reply, 'An IPv6 gateway needs an IPv6 CIDR.');
      return;
    }
    const methodError = methodProblem(body.method, body.cidr !== undefined);
    if (methodError !== undefined) {
      reply.code(400).send({ error: body.method === 'dhcp' ? 'dhcp-unsupported' : 'Invalid request body', message: methodError });
      return;
    }
    if (body.method === 'manual' && (body.cidr !== undefined || body.gateway !== undefined)) {
      badBody(reply, 'A manual interface has no address.');
      return;
    }

    const identity = await authorize(app, req, reply, node.data);
    if (!identity) return;

    // `method` is an intent check only (see the file comment); everything else is forwarded.
    const forwarded = Object.fromEntries(Object.entries(body).filter(([key]) => key !== 'method'));
    try {
      await identity.client.post('/nodes/{node}/network', { node: node.data, ...forwarded } as never);
    } catch (error) {
      if (sendPveError(reply, error)) return;
      app.log.warn({ err: error }, 'Node network create request failed');
      reply.code(502).send({ error: 'pve-unreachable' });
      return;
    }

    app.log.info(
      { username: identity.username, node: node.data, iface: body.iface, type: body.type },
      'Node network interface created (pending apply)',
    );
    reply.code(200).send({ ok: true, iface: body.iface });
  });

  app.put('/api/actions/node/:node/network/:iface', { onRequest: guestActionsRateLimit }, async (req, reply) => {
    const rawParams = req.params as Record<string, string>;
    const node = nodeNameSchema.safeParse(rawParams.node);
    const iface = ifaceSchema.safeParse(rawParams.iface);
    if (!node.success || !iface.success) {
      reply.code(400).send({ error: 'Invalid node/iface' });
      return;
    }
    // `apply`/`revert` are POST routes below; a PUT never targets them.
    const parsed = updateBodySchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      badBody(reply);
      return;
    }
    const body: UpdateBody = parsed.data;
    if (body.method === 'manual' && (body.cidr != null || body.gateway != null)) {
      badBody(reply, 'A manual interface has no address.');
      return;
    }

    const identity = await authorize(app, req, reply, node.data);
    if (!identity) return;

    let rows: IfaceRow[];
    try {
      rows = await listInterfaces(identity.client, node.data);
    } catch (error) {
      if (sendPveError(reply, error)) return;
      app.log.warn({ err: error }, 'Failed to read node network for update');
      reply.code(502).send({ error: 'pve-unreachable' });
      return;
    }
    const current = rows.find((row) => row.iface === iface.data);
    if (!current) {
      reply.code(404).send({ error: 'not-found', message: `${iface.data} does not exist on this node` });
      return;
    }
    if (body.type !== undefined && body.type !== current.type) {
      badBody(reply, `${iface.data} is a ${current.type} interface, not ${body.type}.`);
      return;
    }
    const wrong = wrongFieldsFor(current.type, body);
    if (wrong.length > 0) {
      reply.code(400).send({
        error: 'invalid-field-for-type',
        message: `${wrong.join(', ')} ${wrong.length === 1 ? 'is' : 'are'} not valid for a ${current.type} interface.`,
      });
      return;
    }

    // The CIDR the interface will hold after this edit decides whether a gateway is allowed.
    const hasCidr = body.cidr === undefined ? current.cidr !== undefined : body.cidr !== null;
    const hasCidr6 = body.cidr6 === undefined ? current.cidr6 !== undefined : body.cidr6 !== null;
    if (typeof body.gateway === 'string' && !hasCidr) {
      badBody(reply, 'A gateway needs a CIDR.');
      return;
    }
    if (typeof body.gateway6 === 'string' && !hasCidr6) {
      badBody(reply, 'An IPv6 gateway needs an IPv6 CIDR.');
      return;
    }
    const methodError = methodProblem(body.method, hasCidr);
    if (methodError !== undefined) {
      reply.code(400).send({ error: body.method === 'dhcp' ? 'dhcp-unsupported' : 'Invalid request body', message: methodError });
      return;
    }

    const deletions = deletionsFor(body);
    if (body.method === 'manual') {
      for (const key of ['cidr', 'gateway']) {
        if (!deletions.includes(key)) deletions.push(key);
      }
    }
    const params: Record<string, unknown> = {
      node: node.data,
      iface: iface.data,
      type: current.type,
      ...updateParams(body),
    };
    if (deletions.length > 0) params.delete = deletions.join(',');

    try {
      await identity.client.put('/nodes/{node}/network/{iface}', params as never);
    } catch (error) {
      if (sendPveError(reply, error)) return;
      app.log.warn({ err: error }, 'Node network update request failed');
      reply.code(502).send({ error: 'pve-unreachable' });
      return;
    }

    app.log.info(
      { username: identity.username, node: node.data, iface: iface.data },
      'Node network interface updated (pending apply)',
    );
    reply.code(200).send({ ok: true });
  });

  app.delete('/api/actions/node/:node/network/:iface', { onRequest: guestActionsRateLimit }, async (req, reply) => {
    const rawParams = req.params as Record<string, string>;
    const node = nodeNameSchema.safeParse(rawParams.node);
    const iface = ifaceSchema.safeParse(rawParams.iface);
    if (!node.success || !iface.success) {
      reply.code(400).send({ error: 'Invalid node/iface' });
      return;
    }

    const identity = await authorize(app, req, reply, node.data);
    if (!identity) return;

    try {
      const rows = await listInterfaces(identity.client, node.data);
      const current = rows.find((row) => row.iface === iface.data);
      if (!current) {
        reply.code(404).send({ error: 'not-found', message: `${iface.data} does not exist on this node` });
        return;
      }
      // Refuse deleting the interface that carries the address this server reaches PVE at: the
      // node could not be managed (or this app reached) after the apply. Best effort -- see
      // `reachedAddresses`; with no determinable address the refusal is skipped.
      const own = cidrAddress(current.cidr);
      if (own !== undefined) {
        const reached = await reachedAddresses(app.proxionConfig.PVE_URL);
        if (reached.includes(own)) {
          reply.code(400).send({
            error: 'management-interface',
            message: `${iface.data} carries the management address ${own}; deleting it would cut this node off the network.`,
          });
          return;
        }
      }
      await identity.client.delete('/nodes/{node}/network/{iface}', { node: node.data, iface: iface.data });
    } catch (error) {
      if (sendPveError(reply, error)) return;
      app.log.warn({ err: error }, 'Node network delete request failed');
      reply.code(502).send({ error: 'pve-unreachable' });
      return;
    }

    app.log.info(
      { username: identity.username, node: node.data, iface: iface.data },
      'Node network interface deleted (pending apply)',
    );
    reply.code(200).send({ ok: true });
  });

  app.post('/api/actions/node/:node/network/apply', { onRequest: guestActionsRateLimit }, async (req, reply) => {
    const node = nodeNameSchema.safeParse((req.params as Record<string, string>).node);
    if (!node.success) {
      reply.code(400).send({ error: 'Invalid node' });
      return;
    }
    if (!emptyBodySchema.safeParse(req.body ?? {}).success) {
      badBody(reply);
      return;
    }
    const identity = await authorize(app, req, reply, node.data);
    if (!identity) return;

    let upid: string;
    try {
      upid = (await identity.client.put('/nodes/{node}/network', { node: node.data })) as string;
    } catch (error) {
      if (sendPveError(reply, error)) return;
      app.log.warn({ err: error }, 'Node network apply request failed');
      reply.code(502).send({ error: 'pve-unreachable' });
      return;
    }

    app.log.info({ username: identity.username, node: node.data }, 'Node network configuration applied');
    reply.code(202).send({ upid });
  });

  app.post('/api/actions/node/:node/network/revert', { onRequest: guestActionsRateLimit }, async (req, reply) => {
    const node = nodeNameSchema.safeParse((req.params as Record<string, string>).node);
    if (!node.success) {
      reply.code(400).send({ error: 'Invalid node' });
      return;
    }
    if (!emptyBodySchema.safeParse(req.body ?? {}).success) {
      badBody(reply);
      return;
    }
    const identity = await authorize(app, req, reply, node.data);
    if (!identity) return;

    try {
      await identity.client.delete('/nodes/{node}/network', { node: node.data });
    } catch (error) {
      if (sendPveError(reply, error)) return;
      app.log.warn({ err: error }, 'Node network revert request failed');
      reply.code(502).send({ error: 'pve-unreachable' });
      return;
    }

    app.log.info({ username: identity.username, node: node.data }, 'Node network pending changes reverted');
    reply.code(200).send({ ok: true });
  });
}
