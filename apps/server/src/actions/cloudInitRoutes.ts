import { isIPv4, isIPv6 } from 'node:net';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { PveApiError, type PveClient } from '@proxion/pve-api';
import { resolveIdentity } from '../pve/identity.js';
import { guestTypeSchema, vmidSchema, hasPrivilege, formatPveErrorMessage, sanitizeMessage } from './shared.js';

/**
 * VM Cloud-Init (T54): edit a qemu guest's cloud-init settings and regenerate its cloud-init
 * image. Two more allow-listed calls this server performs against PVE, registered from
 * `actionsRoutes` (`routes.ts`) so they share its rate limiter, same convention as
 * `registerNetworkRoutes`. The raw `/api/pve/*` proxy stays read-only; the `ciuser` /
 * `cipassword` / `sshkeys` / `nameserver` / `searchdomain` / `ciupgrade` / `citype` /
 * `ipconfig<n>` config values are composed here from a validated, typed body.
 *
 * Every write needs `VM.Config.Cloudinit` (PVE 8+/9).
 *
 * The password is secret material: it travels browser -> this server -> PVE (which hashes it)
 * and is never logged, never echoed in a response, and never part of an error message. No log
 * call in this file is handed the request body -- only the NAMES of the fields that changed.
 */

const CLOUDINIT_PRIVILEGE = 'VM.Config.Cloudinit';

/** `net0` .. `net31`. */
const NET_SLOT_RE = /^net(\d|[12]\d|3[01])$/;

const USER_RE = /^[a-z_][a-z0-9_-]*$/;

/** One OpenSSH public key line: `<type> <base64> [comment]`. */
const SSH_KEY_RE =
  /^(ssh-(rsa|ed25519|dss)|ecdsa-sha2-nistp(256|384|521)|sk-ssh-ed25519@openssh\.com|sk-ecdsa-sha2-nistp256@openssh\.com) [A-Za-z0-9+/=]+( [^\r\n]{0,256})?$/;

/** PVE caps the stored (URL-encoded) `sshkeys` value at 40 KiB. */
const MAX_SSHKEYS_ENCODED = 40960;
const MAX_SSH_KEYS = 64;
const MAX_SSH_KEY_LENGTH = 8192;
const MAX_NAMESERVERS = 3;

/** An RFC 1123 style DNS name: dot-separated labels of letters, digits and inner hyphens. */
const DNS_NAME_RE = /^(?=.{1,255}$)[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*$/;

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

const ipConfigSchema = z
  .object({
    ip: z
      .string()
      .refine((v) => v === 'dhcp' || isIPv4Cidr(v), { message: 'Invalid IPv4 address' })
      .optional(),
    gw: z.string().refine(isIPv4, { message: 'Invalid IPv4 gateway' }).optional(),
    ip6: z
      .string()
      .refine((v) => v === 'auto' || v === 'dhcp' || isIPv6Cidr(v), { message: 'Invalid IPv6 address' })
      .optional(),
    gw6: z.string().refine(isIPv6, { message: 'Invalid IPv6 gateway' }).optional(),
  })
  .strict()
  .refine((v) => Object.keys(v).length > 0, { message: 'An empty ipconfig entry; use null to remove it' });

export type IpConfigBody = z.infer<typeof ipConfigSchema>;

// `.strict()`: an unknown key is a 400, same rationale as every other guest-action body schema.
// A `null` is "delete this setting"; an absent key is "leave it alone".
const cloudInitBodySchema = z
  .object({
    user: z.string().max(64).regex(USER_RE).nullable().optional(),
    password: z.string().min(1).max(256).nullable().optional(),
    sshKeys: z.array(z.string().max(MAX_SSH_KEY_LENGTH).regex(SSH_KEY_RE)).max(MAX_SSH_KEYS).optional(),
    nameserver: z
      .array(z.string().refine((v) => isIPv4(v) || isIPv6(v), { message: 'Invalid IP address' }))
      .max(MAX_NAMESERVERS)
      .optional(),
    searchdomain: z.string().regex(DNS_NAME_RE).nullable().optional(),
    upgrade: z.boolean().optional(),
    type: z.enum(['nocloud', 'configdrive2', 'opennebula']).nullable().optional(),
    ipconfig: z.record(z.string().regex(NET_SLOT_RE), ipConfigSchema.nullable()).optional(),
  })
  .strict()
  .refine((v) => Object.values(v).some((field) => field !== undefined), { message: 'Nothing to change' });

export type CloudInitBody = z.infer<typeof cloudInitBodySchema>;

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

/** What `composeCloudInitConfig` produces: the config keys to set and the ones to delete. */
export interface CloudInitChange {
  set: Record<string, string>;
  remove: string[];
}

/** `ip=10.0.0.5/24,gw=10.0.0.1,ip6=auto,gw6=...`, keys in PVE's documented order. */
export function composeIpConfig(value: IpConfigBody): string {
  const parts: string[] = [];
  if (value.ip !== undefined) parts.push(`ip=${value.ip}`);
  if (value.gw !== undefined) parts.push(`gw=${value.gw}`);
  if (value.ip6 !== undefined) parts.push(`ip6=${value.ip6}`);
  if (value.gw6 !== undefined) parts.push(`gw6=${value.gw6}`);
  return parts.join(',');
}

/**
 * Maps the typed body onto PVE's config keys. Pure: the `net<n>` existence check and the
 * gateway-needs-static-address check live in the handler / `ipConfigProblem`.
 */
export function composeCloudInitConfig(body: CloudInitBody): CloudInitChange {
  const set: Record<string, string> = {};
  const remove: string[] = [];

  if (body.user === null) remove.push('ciuser');
  else if (body.user !== undefined) set.ciuser = body.user;

  if (body.password === null) remove.push('cipassword');
  else if (body.password !== undefined) set.cipassword = body.password;

  if (body.sshKeys !== undefined) {
    if (body.sshKeys.length === 0) remove.push('sshkeys');
    else set.sshkeys = encodeURIComponent(body.sshKeys.join('\n'));
  }

  if (body.nameserver !== undefined) {
    if (body.nameserver.length === 0) remove.push('nameserver');
    else set.nameserver = body.nameserver.join(' ');
  }

  if (body.searchdomain === null) remove.push('searchdomain');
  else if (body.searchdomain !== undefined) set.searchdomain = body.searchdomain;

  if (body.upgrade !== undefined) set.ciupgrade = body.upgrade ? '1' : '0';

  if (body.type === null) remove.push('citype');
  else if (body.type !== undefined) set.citype = body.type;

  for (const [slot, value] of Object.entries(body.ipconfig ?? {})) {
    const key = `ipconfig${slot.slice(3)}`;
    if (value === null) remove.push(key);
    else set[key] = composeIpConfig(value);
  }

  return { set, remove };
}

/** A gateway only makes sense next to a static address of its own family. */
function ipConfigProblem(ipconfig: CloudInitBody['ipconfig']): string | undefined {
  for (const [slot, value] of Object.entries(ipconfig ?? {})) {
    if (value === null) continue;
    if (value.gw !== undefined && !(value.ip !== undefined && isIPv4Cidr(value.ip))) {
      return `${slot}: gw needs a static ip (CIDR)`;
    }
    if (value.gw6 !== undefined && !(value.ip6 !== undefined && isIPv6Cidr(value.ip6))) {
      return `${slot}: gw6 needs a static ip6 (CIDR)`;
    }
  }
  return undefined;
}

interface CloudInitRow {
  key: string;
  pending?: unknown;
  delete?: unknown;
}

/** The keys PVE reports as having a pending value or a pending delete. A failure to read the list
 * never fails the (already applied) change -- it just reports none. */
async function pendingKeys(app: FastifyInstance, client: PveClient, params: GuestRouteParams): Promise<string[]> {
  try {
    const rows: unknown = await client.get('/nodes/{node}/qemu/{vmid}/cloudinit', {
      node: params.node,
      vmid: params.vmid,
    });
    return (Array.isArray(rows) ? (rows as CloudInitRow[]) : [])
      .filter((row) => row.pending !== undefined || (row.delete !== undefined && Boolean(row.delete)))
      .map((row) => row.key);
  } catch (error) {
    app.log.warn({ err: error }, 'Failed to read pending cloud-init values after update');
    return [];
  }
}

/** The shared session/token/privilege gate. Sends the failure reply itself and returns
 * `undefined`; otherwise returns the caller's identity. */
async function authorize(app: FastifyInstance, req: FastifyRequest, reply: FastifyReply, vmid: number) {
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
    allowed = await hasPrivilege(identity.client, vmid, CLOUDINIT_PRIVILEGE);
  } catch (error) {
    app.log.warn({ err: error }, 'Failed to check permissions for cloud-init update');
    reply.code(502).send({ error: 'pve-unreachable' });
    return undefined;
  }
  if (!allowed) {
    reply.code(403).send({ error: 'forbidden', missing: CLOUDINIT_PRIVILEGE });
    return undefined;
  }
  return identity;
}

export function registerCloudInitRoutes(
  app: FastifyInstance,
  guestActionsRateLimit: ReturnType<FastifyInstance['rateLimit']>,
): void {
  app.patch(
    '/api/actions/guest/:node/:type/:vmid/cloud-init',
    { onRequest: guestActionsRateLimit },
    async (req, reply) => {
      const params = parseGuestParams(req.params as Record<string, string>);
      if (!params) {
        reply.code(400).send({ error: 'Invalid node/type/vmid' });
        return;
      }
      if (params.type !== 'qemu') {
        reply.code(400).send({ error: 'not-applicable', message: 'Cloud-Init is only available on qemu guests' });
        return;
      }

      // Never echo a validation failure's detail: the body holds the password.
      const parsed = cloudInitBodySchema.safeParse(req.body ?? {});
      if (!parsed.success) {
        reply.code(400).send({ error: 'Invalid request body' });
        return;
      }
      const body = parsed.data;

      const ipProblem = ipConfigProblem(body.ipconfig);
      if (ipProblem !== undefined) {
        reply.code(400).send({ error: 'Invalid request body', message: ipProblem });
        return;
      }
      const { set, remove } = composeCloudInitConfig(body);
      if (set.sshkeys !== undefined && set.sshkeys.length > MAX_SSHKEYS_ENCODED) {
        reply.code(400).send({ error: 'Invalid request body', message: 'sshKeys is too large' });
        return;
      }

      const identity = await authorize(app, req, reply, params.vmid);
      if (!identity) return;
      const client = identity.client;

      // An ipconfig can only be set for a NIC the guest has.
      const setSlots = Object.entries(body.ipconfig ?? {})
        .filter(([, value]) => value !== null)
        .map(([slot]) => slot);
      if (setSlots.length > 0) {
        let current: Record<string, unknown>;
        try {
          current = ((await client.get('/nodes/{node}/qemu/{vmid}/config', {
            node: params.node,
            vmid: params.vmid,
          })) ?? {}) as Record<string, unknown>;
        } catch (error) {
          if (sendPveError(reply, error)) return;
          app.log.warn({ err: error }, 'Failed to read current config for cloud-init update');
          reply.code(502).send({ error: 'pve-unreachable' });
          return;
        }
        const missing = setSlots.find((slot) => current[slot] === undefined || current[slot] === null);
        if (missing !== undefined) {
          reply.code(400).send({ error: 'unknown-device', message: `${missing} does not exist on this guest` });
          return;
        }
      }

      const payload: Record<string, string> = { ...set };
      if (remove.length > 0) payload.delete = remove.join(',');
      try {
        await client.put('/nodes/{node}/qemu/{vmid}/config', {
          node: params.node,
          vmid: params.vmid,
          ...payload,
        } as never);
      } catch (error) {
        if (sendPveError(reply, error)) return;
        app.log.warn({ err: error }, 'Cloud-init update request failed');
        reply.code(502).send({ error: 'pve-unreachable' });
        return;
      }

      const pending = await pendingKeys(app, client, params);
      // One line per update: which settings changed, never their values.
      app.log.info(
        {
          username: identity.username,
          node: params.node,
          vmid: params.vmid,
          fields: Object.keys(body),
          pending,
        },
        'Guest cloud-init settings saved',
      );
      reply.code(200).send({ ok: true, pending });
    },
  );

  app.post(
    '/api/actions/guest/:node/:type/:vmid/cloud-init/regenerate',
    { onRequest: guestActionsRateLimit },
    async (req, reply) => {
      const params = parseGuestParams(req.params as Record<string, string>);
      if (!params) {
        reply.code(400).send({ error: 'Invalid node/type/vmid' });
        return;
      }
      if (params.type !== 'qemu') {
        reply.code(400).send({ error: 'not-applicable', message: 'Cloud-Init is only available on qemu guests' });
        return;
      }

      const identity = await authorize(app, req, reply, params.vmid);
      if (!identity) return;

      try {
        await identity.client.put('/nodes/{node}/qemu/{vmid}/cloudinit', { node: params.node, vmid: params.vmid });
      } catch (error) {
        if (sendPveError(reply, error)) return;
        app.log.warn({ err: error }, 'Cloud-init regenerate request failed');
        reply.code(502).send({ error: 'pve-unreachable' });
        return;
      }

      app.log.info(
        { username: identity.username, node: params.node, vmid: params.vmid },
        'Guest cloud-init image regenerated',
      );
      reply.code(200).send({ ok: true });
    },
  );
}
