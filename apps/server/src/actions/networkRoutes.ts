import { isIPv4, isIPv6 } from 'node:net';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { PveApiError, type PveClient } from '@proxion/pve-api';
import { resolveIdentity } from '../pve/identity.js';
import { guestTypeSchema, vmidSchema, hasPrivilege, formatPveErrorMessage, sanitizeMessage } from './shared.js';

/**
 * Guest network devices (T50): add, edit and remove a `net<n>` device. Three more allow-listed
 * calls this server performs against PVE, registered from `actionsRoutes` (`routes.ts`) so they
 * share its rate limiter, same convention as `registerHardwareRoutes`. The raw `/api/pve/*` proxy
 * stays read-only; the `net<n>` property string is composed here from a validated, typed body --
 * the caller never hands PVE a free-form string. See "Guest actions" in README.md.
 *
 * PVE additionally checks `SDN.Use` on the chosen bridge for non-root callers; that is left to
 * PVE and its error is relayed (via `sendPveError`).
 */

const NIC_PRIVILEGE = 'VM.Config.Network';

/** `net0` .. `net31`. */
const NET_SLOT_RE = /^net(\d|[12]\d|3[01])$/;
const MAX_NET_SLOTS = 32;

/** The qemu NIC models this route accepts (PVE has a few more; these are the common ones). */
const QEMU_MODELS = [
  'virtio',
  'e1000',
  'e1000e',
  'rtl8139',
  'vmxnet3',
  'e1000-82540em',
  'e1000-82544gc',
  'e1000-82545em',
] as const;

const MAC_RE = /^[0-9A-Fa-f]{2}(:[0-9A-Fa-f]{2}){5}$/;
const BRIDGE_RE = /^[A-Za-z][A-Za-z0-9_.-]{0,14}$/;
const LXC_IFNAME_RE = /^eth\d{1,3}$/;

/** A unicast MAC: the least-significant bit of the first byte (the multicast bit) is clear. */
function isUnicastMac(mac: string): boolean {
  return (Number.parseInt(mac.slice(0, 2), 16) & 1) === 0;
}

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

const macSchema = z
  .string()
  .regex(MAC_RE)
  .refine(isUnicastMac, { message: 'Multicast MAC addresses are not allowed' });

// `.strict()`: an unknown key is a 400, same rationale as every other guest-action body schema.
// One superset schema for both guest types; the per-type field guards (qemu-only `model`/
// `linkDown` vs lxc-only `name`/`ip`/`gw`/`ip6`/`gw6`) live in the handler, where `type` is known.
const nicBodySchema = z
  .object({
    model: z.enum(QEMU_MODELS).optional(),
    name: z.string().regex(LXC_IFNAME_RE).optional(),
    mac: macSchema.optional(),
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
    vlan: z.number().int().min(1).max(4094).optional(),
    firewall: z.boolean().optional(),
    rateMbps: z.number().positive().max(100000).optional(),
    linkDown: z.boolean().optional(),
    // Superset bounds; the per-type range (`MTU_RANGE`) is checked in the handler.
    mtu: z.number().int().min(1).max(65535).optional(),
  })
  .strict();

export type NicBody = z.infer<typeof nicBodySchema>;

/** PVE's own `mtu` ranges: qemu-server 1..65520 (`1` = use the bridge MTU, VirtIO only),
 * pve-container 64..65535. */
const MTU_RANGE = { qemu: [1, 65520], lxc: [64, 65535] } as const;

/** The `net<n>` keys this route models per guest type. A key=value pair of an existing device
 * whose key is NOT listed here is carried over unchanged on an edit (queues, trunks, ...). */
const MODELED_KEYS = {
  qemu: new Set(['model', 'macaddr', 'bridge', 'tag', 'firewall', 'rate', 'link_down', 'mtu']),
  lxc: new Set(['name', 'bridge', 'hwaddr', 'ip', 'gw', 'ip6', 'gw6', 'tag', 'firewall', 'rate', 'mtu']),
} as const;

const QEMU_ONLY_FIELDS = ['model', 'linkDown'] as const;
const LXC_ONLY_FIELDS = ['name', 'ip', 'gw', 'ip6', 'gw6'] as const;

interface GuestRouteParams {
  node: string;
  type: 'qemu' | 'lxc';
  vmid: number;
}

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

/** The MAC a current `net<n>` holds: qemu `<model>=<MAC>`, lxc `hwaddr=<MAC>`. */
function existingMac(type: 'qemu' | 'lxc', raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined;
  for (const part of raw.split(',')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    const key = part.slice(0, eq);
    const value = part.slice(eq + 1);
    if (!MAC_RE.test(value)) continue;
    if (type === 'lxc' ? key === 'hwaddr' : key !== 'hwaddr') return value;
  }
  return undefined;
}

/**
 * The key=value pairs of an existing `net<n>` value that this route does not model for `type`
 * (qemu `queues`/`trunks`, lxc `link_down`/`trunks`/`type`, anything PVE adds later), verbatim and
 * in their original order. Keys the body models are never carried over, even when the body omits
 * them. The first qemu part is the `<model>[=<MAC>]` head and is always modeled.
 */
export function unmodeledNetParts(type: 'qemu' | 'lxc', raw: unknown): string[] {
  if (typeof raw !== 'string') return [];
  const modeled: ReadonlySet<string> = MODELED_KEYS[type];
  return raw.split(',').filter((part, index) => {
    if (part === '' || (type === 'qemu' && index === 0)) return false;
    const eq = part.indexOf('=');
    return !modeled.has(eq === -1 ? part : part.slice(0, eq));
  });
}

/**
 * Composes the PVE `net<n>` property string, keys in the order PVE documents them, unset fields
 * omitted. `mac` is the address to pin (already resolved against the existing device by the
 * caller); without one qemu gets the bare model (PVE generates a MAC) and lxc gets no `hwaddr`.
 * `extras` (an edit's unmodeled options, see `unmodeledNetParts`) are appended unchanged.
 */
export function composeNetValue(
  type: 'qemu' | 'lxc',
  slot: string,
  body: NicBody,
  mac: string | undefined,
  extras: readonly string[] = [],
): string {
  const parts: string[] = [];
  if (type === 'qemu') {
    const model = body.model ?? 'virtio';
    parts.push(mac !== undefined ? `${model}=${mac}` : model);
    parts.push(`bridge=${body.bridge}`);
  } else {
    parts.push(`name=${body.name ?? `eth${slot.slice(3)}`}`);
    parts.push(`bridge=${body.bridge}`);
    if (mac !== undefined) parts.push(`hwaddr=${mac}`);
    if (body.ip !== undefined) parts.push(`ip=${body.ip}`);
    if (body.gw !== undefined) parts.push(`gw=${body.gw}`);
    if (body.ip6 !== undefined) parts.push(`ip6=${body.ip6}`);
    if (body.gw6 !== undefined) parts.push(`gw6=${body.gw6}`);
  }
  if (body.vlan !== undefined) parts.push(`tag=${body.vlan}`);
  if (body.firewall !== undefined) parts.push(`firewall=${body.firewall ? 1 : 0}`);
  if (body.rateMbps !== undefined) parts.push(`rate=${body.rateMbps}`);
  if (type === 'qemu' && body.linkDown !== undefined) parts.push(`link_down=${body.linkDown ? 1 : 0}`);
  if (body.mtu !== undefined) parts.push(`mtu=${body.mtu}`);
  parts.push(...extras);
  return parts.join(',');
}

async function fetchGuestConfig(
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

async function callConfigUpdate(
  client: PveClient,
  type: 'qemu' | 'lxc',
  node: string,
  vmid: number,
  config: Record<string, string>,
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

/** `[slot]` when PVE is holding it back until the guest restarts, else `[]`. A failure to read the
 * pending list never fails the (already applied) change -- it just reports none. */
async function pendingFor(
  app: FastifyInstance,
  client: PveClient,
  params: GuestRouteParams,
  slot: string,
): Promise<string[]> {
  try {
    const rows: unknown =
      params.type === 'qemu'
        ? await client.get('/nodes/{node}/qemu/{vmid}/pending', { node: params.node, vmid: params.vmid })
        : await client.get('/nodes/{node}/lxc/{vmid}/pending', { node: params.node, vmid: params.vmid });
    const held = (Array.isArray(rows) ? (rows as PendingRow[]) : []).some(
      (row) => row.key === slot && (row.pending !== undefined || (row.delete !== undefined && Boolean(row.delete))),
    );
    return held ? [slot] : [];
  } catch (error) {
    app.log.warn({ err: error }, 'Failed to read pending config after guest network update');
    return [];
  }
}

/** The shared session/token/privilege gate. Sends the failure reply itself and returns
 * `undefined`; otherwise returns the caller's identity. */
async function authorize(
  app: FastifyInstance,
  req: FastifyRequest,
  reply: FastifyReply,
  vmid: number,
  privilege: string | undefined,
) {
  const identity = await resolveIdentity(app, req);
  if (!identity) {
    reply.code(401).send({ error: 'Not authenticated' });
    return undefined;
  }
  if (identity.credentials.type === 'token') {
    reply.code(403).send({ error: 'writes-disabled-in-token-mode' });
    return undefined;
  }
  if (privilege !== undefined) {
    let allowed: boolean;
    try {
      allowed = await hasPrivilege(identity.client, vmid, privilege);
    } catch (error) {
      app.log.warn({ err: error }, 'Failed to check permissions for guest network update');
      reply.code(502).send({ error: 'pve-unreachable' });
      return undefined;
    }
    if (!allowed) {
      reply.code(403).send({ error: 'forbidden', missing: privilege });
      return undefined;
    }
  }
  return identity;
}

export function registerNetworkRoutes(
  app: FastifyInstance,
  guestActionsRateLimit: ReturnType<FastifyInstance['rateLimit']>,
): void {
  app.put(
    '/api/actions/guest/:node/:type/:vmid/network/:slot',
    { onRequest: guestActionsRateLimit },
    async (req, reply) => {
      const rawParams = req.params as Record<string, string>;
      const params = parseGuestParams(rawParams);
      const slot = rawParams.slot ?? '';
      if (!params || !NET_SLOT_RE.test(slot)) {
        reply.code(400).send({ error: 'Invalid node/type/vmid/slot' });
        return;
      }

      const parsed = nicBodySchema.safeParse(req.body ?? {});
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
      if (params.type === 'qemu' && body.model === undefined) {
        reply.code(400).send({ error: 'Invalid request body' });
        return;
      }
      const [mtuMin, mtuMax] = MTU_RANGE[params.type];
      if (body.mtu !== undefined && (body.mtu < mtuMin || body.mtu > mtuMax)) {
        reply.code(400).send({ error: 'Invalid request body', message: `mtu must be ${mtuMin}..${mtuMax} for a ${params.type} guest` });
        return;
      }
      if (body.gw !== undefined && !(body.ip !== undefined && isIPv4Cidr(body.ip))) {
        reply.code(400).send({ error: 'Invalid request body', message: 'gw needs a static ip (CIDR)' });
        return;
      }
      if (body.gw6 !== undefined && !(body.ip6 !== undefined && isIPv6Cidr(body.ip6))) {
        reply.code(400).send({ error: 'Invalid request body', message: 'gw6 needs a static ip6 (CIDR)' });
        return;
      }

      const identity = await authorize(app, req, reply, params.vmid, NIC_PRIVILEGE);
      if (!identity) return;
      const client = identity.client;

      // The current config decides create-vs-edit: an edit that omits `mac` keeps the existing
      // address (never silently re-rolled), every other omitted field is dropped.
      let current: Record<string, unknown>;
      try {
        current = await fetchGuestConfig(client, params.type, params.node, params.vmid);
      } catch (error) {
        if (sendPveError(reply, error)) return;
        app.log.warn({ err: error }, 'Failed to read current config for guest network update');
        reply.code(502).send({ error: 'pve-unreachable' });
        return;
      }
      const mac = body.mac ?? existingMac(params.type, current[slot]);
      const value = composeNetValue(params.type, slot, body, mac, unmodeledNetParts(params.type, current[slot]));

      try {
        await callConfigUpdate(client, params.type, params.node, params.vmid, { [slot]: value });
      } catch (error) {
        if (sendPveError(reply, error)) return;
        app.log.warn({ err: error }, 'Guest network update request failed');
        reply.code(502).send({ error: 'pve-unreachable' });
        return;
      }

      const pending = await pendingFor(app, client, params, slot);
      // One line per update; the slot only, never the addressing.
      app.log.info(
        { username: identity.username, node: params.node, type: params.type, vmid: params.vmid, slot, pending },
        'Guest network device saved',
      );
      reply.code(200).send({ ok: true, slot, pending });
    },
  );

  app.delete(
    '/api/actions/guest/:node/:type/:vmid/network/:slot',
    { onRequest: guestActionsRateLimit },
    async (req, reply) => {
      const rawParams = req.params as Record<string, string>;
      const params = parseGuestParams(rawParams);
      const slot = rawParams.slot ?? '';
      if (!params || !NET_SLOT_RE.test(slot)) {
        reply.code(400).send({ error: 'Invalid node/type/vmid/slot' });
        return;
      }

      const identity = await authorize(app, req, reply, params.vmid, NIC_PRIVILEGE);
      if (!identity) return;
      const client = identity.client;

      try {
        const current = await fetchGuestConfig(client, params.type, params.node, params.vmid);
        if (current[slot] === undefined || current[slot] === null) {
          reply.code(404).send({ error: 'not-found', message: `${slot} does not exist on this guest` });
          return;
        }
        await callConfigUpdate(client, params.type, params.node, params.vmid, { delete: slot });
      } catch (error) {
        if (sendPveError(reply, error)) return;
        app.log.warn({ err: error }, 'Guest network device removal failed');
        reply.code(502).send({ error: 'pve-unreachable' });
        return;
      }

      const pending = await pendingFor(app, client, params, slot);
      app.log.info(
        { username: identity.username, node: params.node, type: params.type, vmid: params.vmid, slot, pending },
        'Guest network device removed',
      );
      reply.code(200).send({ ok: true, pending });
    },
  );

  app.get(
    '/api/actions/guest/:node/:type/:vmid/network/next-slot',
    { onRequest: guestActionsRateLimit },
    async (req, reply) => {
      const params = parseGuestParams(req.params as Record<string, string>);
      if (!params) {
        reply.code(400).send({ error: 'Invalid node/type/vmid' });
        return;
      }
      const identity = await authorize(app, req, reply, params.vmid, undefined);
      if (!identity) return;

      let current: Record<string, unknown>;
      try {
        current = await fetchGuestConfig(identity.client, params.type, params.node, params.vmid);
      } catch (error) {
        if (sendPveError(reply, error)) return;
        app.log.warn({ err: error }, 'Failed to read current config for next network slot');
        reply.code(502).send({ error: 'pve-unreachable' });
        return;
      }
      for (let n = 0; n < MAX_NET_SLOTS; n++) {
        if (current[`net${n}`] === undefined) {
          reply.code(200).send({ slot: `net${n}` });
          return;
        }
      }
      reply.code(409).send({ error: 'no-free-slot', message: 'All 32 network device slots are in use' });
    },
  );
}
