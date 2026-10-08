import { isIP } from 'node:net';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { PveApiError } from '@proxion/pve-api';
import { resolveIdentity } from '../pve/identity.js';
import { guestTypeSchema, vmidSchema, hasPrivilege, formatPveErrorMessage, sanitizeMessage } from './shared.js';

/**
 * Guest firewall aliases and IP sets (T73): the per-guest versions of the objects the datacenter
 * firewall already has (`clusterFirewallRoutes.ts`), on PVE's
 * `/nodes/{node}/{qemu|lxc}/{vmid}/firewall/{aliases,ipset}` endpoints. Registered from
 * `actionsRoutes` (`routes.ts`) so the routes share its rate limiter, same convention as
 * `registerFirewallRoutes`. The raw `/api/pve/*` proxy stays read-only (the lists, an IP set's
 * entries and `/firewall/refs` are read through it); every write goes through the typed, validated
 * bodies below.
 *
 * pve-firewall checks `VM.Config.Network` on `/vms/{vmid}` for every guest firewall write, the same
 * privilege `firewallRoutes.ts` requires for the rules and options. The body schemas, the name and
 * CIDR checks and the `rename` semantics are copied from `clusterFirewallRoutes.ts` (nothing there is
 * exported, and that file is intentionally untouched): `rename` on `PUT /aliases/:name` is the NEW
 * name (the path names the existing alias); the routes pass it through unchanged.
 *
 * A DELETE carries its optional `digest` (and an IP set's `force`) as a query parameter, like the
 * other firewall DELETEs, or as a JSON body; both forms reach PVE as the same parameter.
 */

const FIREWALL_PRIVILEGE = 'VM.Config.Network';

const ALIAS_NAME_RE = /^[A-Za-z][A-Za-z0-9_-]{1,63}$/;
const DIGEST_RE = /^[A-Za-z0-9_-]{1,128}$/;
const MAX_COMMENT_LENGTH = 1024;

function hasControlCharacter(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

/** An IPv4 / IPv6 address, or one with a `/prefix` of the matching width. */
function isAddressOrCidr(value: string): boolean {
  const slash = value.indexOf('/');
  const address = slash === -1 ? value : value.slice(0, slash);
  const family = isIP(address);
  if (family === 0) return false;
  if (slash === -1) return true;
  const prefix = value.slice(slash + 1);
  if (!/^\d{1,3}$/.test(prefix)) return false;
  return Number(prefix) <= (family === 4 ? 32 : 128);
}

const nameSchema = z.string().regex(ALIAS_NAME_RE);
const commentSchema = z
  .string()
  .max(MAX_COMMENT_LENGTH)
  .refine((v) => !hasControlCharacter(v), { message: 'Comment must be a single line' });
const digestSchema = z.string().regex(DIGEST_RE);
const cidrSchema = z.string().max(64).refine(isAddressOrCidr, { message: 'Invalid IP address or CIDR' });

// `.strict()`: an unknown key is a 400, same rationale as every other guest-action body schema.
const createAliasSchema = z
  .object({
    name: nameSchema,
    cidr: cidrSchema,
    comment: commentSchema.optional(),
  })
  .strict();

const updateAliasSchema = z
  .object({
    cidr: cidrSchema,
    comment: commentSchema.optional(),
    rename: nameSchema.optional(),
    digest: digestSchema.optional(),
  })
  .strict();

const createIpsetSchema = z
  .object({
    name: nameSchema,
    comment: commentSchema.optional(),
    rename: nameSchema.optional(),
    digest: digestSchema.optional(),
  })
  .strict();

const addIpsetEntrySchema = z
  .object({
    cidr: cidrSchema,
    nomatch: z.boolean().optional(),
    comment: commentSchema.optional(),
  })
  .strict();

const updateIpsetEntrySchema = z
  .object({
    nomatch: z.boolean().optional(),
    comment: commentSchema.optional(),
    digest: digestSchema.optional(),
  })
  .strict()
  .refine((body) => body.nomatch !== undefined || body.comment !== undefined, {
    message: 'At least one field to change is required',
  });

const forceSchema = z.union([z.boolean(), z.enum(['0', '1', 'true', 'false'])]);
const digestOnlySchema = z.object({ digest: digestSchema.optional() }).strict();
const ipsetDeleteSchema = z.object({ digest: digestSchema.optional(), force: forceSchema.optional() }).strict();

const flag = (value: boolean): 1 | 0 => (value ? 1 : 0);

type PveParamMap = Record<string, string | number>;

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
    allowed = await hasPrivilege(identity.client, vmid, FIREWALL_PRIVILEGE);
  } catch (error) {
    app.log.warn({ err: error }, 'Failed to check permissions for guest firewall alias/IP set update');
    reply.code(502).send({ error: 'pve-unreachable' });
    return undefined;
  }
  if (!allowed) {
    reply.code(403).send({ error: 'forbidden', missing: FIREWALL_PRIVILEGE });
    return undefined;
  }
  return identity;
}

/** One validated PVE call: the verb, the path suffix after `.../firewall` (with `{placeholders}`
 * filled from `params`), the HTTP status to answer with and the audit-log fields. */
interface Plan {
  verb: 'post' | 'put' | 'delete';
  suffix: string;
  params: PveParamMap;
  status: 200 | 201;
  what: string;
  log?: Record<string, unknown>;
}
type Planned = Plan | { error: string };

const BASE = '/api/actions/guest/:node/:type/:vmid/firewall';

export function registerGuestFirewallRefsRoutes(
  app: FastifyInstance,
  guestActionsRateLimit: ReturnType<FastifyInstance['rateLimit']>,
): void {
  /** Validates (400), authorizes (401/403), calls PVE (4xx/502 mapped) and answers `{ ok: true }`. */
  function write(
    method: 'POST' | 'PUT' | 'DELETE',
    url: string,
    plan: (req: FastifyRequest, guest: GuestRouteParams) => Planned,
  ): void {
    app.route({
      method,
      url: `${BASE}${url}`,
      onRequest: guestActionsRateLimit,
      handler: async (req, reply) => {
        const guest = parseGuestParams(req.params as Record<string, string>);
        if (!guest) {
          reply.code(400).send({ error: 'Invalid node/type/vmid' });
          return;
        }
        const planned = plan(req, guest);
        if ('error' in planned) {
          reply.code(400).send({ error: planned.error });
          return;
        }
        const identity = await authorize(app, req, reply, guest.vmid);
        if (!identity) return;

        try {
          // The generated client types each (verb, path) pair separately; the pair is composed from
          // validated pieces here, so the `never` casts only bridge that typing, not the values.
          const path = `/nodes/{node}/${guest.type}/{vmid}/firewall${planned.suffix}` as never;
          const params = { node: guest.node, vmid: guest.vmid, ...planned.params } as never;
          if (planned.verb === 'post') await identity.client.post(path, params);
          else if (planned.verb === 'put') await identity.client.put(path, params);
          else await identity.client.delete(path, params);
        } catch (error) {
          if (sendPveError(reply, error)) return;
          app.log.warn({ err: error }, `Guest firewall ${planned.what} request failed`);
          reply.code(502).send({ error: 'pve-unreachable' });
          return;
        }
        app.log.info(
          { username: identity.username, node: guest.node, type: guest.type, vmid: guest.vmid, ...planned.log },
          `Guest firewall ${planned.what}`,
        );
        reply.code(planned.status).send({ ok: true });
      },
    });
  }

  const bad = (message: string): { error: string } => ({ error: message });
  const params = (req: FastifyRequest) => req.params as Record<string, string>;

  /** Parses a value with a schema; `undefined` on failure. */
  const parse = <T>(schema: z.ZodType<T>, value: unknown): T | undefined => {
    const result = schema.safeParse(value);
    return result.success ? result.data : undefined;
  };

  /** The optional DELETE parameters, from the query string and/or a JSON body. A key sent in both
   * places with different values is refused rather than guessed at. */
  function deleteOptions<T extends z.ZodType<Record<string, unknown>>>(
    schema: T,
    req: FastifyRequest,
  ): z.infer<T> | undefined {
    const query = parse(schema, req.query ?? {});
    const body = parse(schema, req.body ?? {});
    if (!query || !body) return undefined;
    for (const key of Object.keys(body)) {
      if (key in query && query[key] !== body[key]) return undefined;
    }
    return { ...query, ...body } as z.infer<T>;
  }

  // --- aliases -----------------------------------------------------------------------------

  write('POST', '/aliases', (req) => {
    const body = parse(createAliasSchema, req.body ?? {});
    if (!body) return bad('Invalid request body');
    const pve: PveParamMap = { name: body.name, cidr: body.cidr };
    if (body.comment !== undefined) pve.comment = body.comment;
    return {
      verb: 'post',
      suffix: '/aliases',
      params: pve,
      status: 201,
      what: 'alias added',
      log: { alias: body.name },
    };
  });

  write('PUT', '/aliases/:name', (req) => {
    const name = parse(nameSchema, params(req).name);
    if (name === undefined) return bad('Invalid alias name');
    const body = parse(updateAliasSchema, req.body ?? {});
    if (!body) return bad('Invalid request body');
    const pve: PveParamMap = { name, cidr: body.cidr };
    if (body.comment !== undefined) pve.comment = body.comment;
    if (body.rename !== undefined) pve.rename = body.rename;
    if (body.digest !== undefined) pve.digest = body.digest;
    return {
      verb: 'put',
      suffix: '/aliases/{name}',
      params: pve,
      status: 200,
      what: body.rename !== undefined ? 'alias renamed' : 'alias updated',
      log: { alias: name },
    };
  });

  write('DELETE', '/aliases/:name', (req) => {
    const name = parse(nameSchema, params(req).name);
    if (name === undefined) return bad('Invalid alias name');
    const options = deleteOptions(digestOnlySchema, req);
    if (!options) return bad('Invalid request');
    return {
      verb: 'delete',
      suffix: '/aliases/{name}',
      params: { name, ...(options.digest !== undefined ? { digest: options.digest } : {}) },
      status: 200,
      what: 'alias removed',
      log: { alias: name },
    };
  });

  // --- IP sets -----------------------------------------------------------------------------

  write('POST', '/ipsets', (req) => {
    const body = parse(createIpsetSchema, req.body ?? {});
    if (!body) return bad('Invalid request body');
    const pve: PveParamMap = { name: body.name };
    if (body.comment !== undefined) pve.comment = body.comment;
    if (body.rename !== undefined) pve.rename = body.rename;
    if (body.digest !== undefined) pve.digest = body.digest;
    return {
      verb: 'post',
      suffix: '/ipset',
      params: pve,
      status: 201,
      what: body.rename !== undefined ? 'IP set renamed' : 'IP set added',
      log: { ipset: body.name },
    };
  });

  // PVE's DELETE .../firewall/ipset/{name} takes `force` (also drop the members), not a digest.
  write('DELETE', '/ipsets/:name', (req) => {
    const name = parse(nameSchema, params(req).name);
    if (name === undefined) return bad('Invalid IP set name');
    const options = deleteOptions(ipsetDeleteSchema, req);
    if (!options || options.digest !== undefined) return bad('Invalid request');
    const force = options.force === true || options.force === '1' || options.force === 'true';
    return {
      verb: 'delete',
      suffix: '/ipset/{name}',
      params: { name, ...(force ? { force: 1 } : {}) },
      status: 200,
      what: 'IP set removed',
      log: { ipset: name, force },
    };
  });

  write('POST', '/ipsets/:name', (req) => {
    const name = parse(nameSchema, params(req).name);
    if (name === undefined) return bad('Invalid IP set name');
    const body = parse(addIpsetEntrySchema, req.body ?? {});
    if (!body) return bad('Invalid request body');
    const pve: PveParamMap = { name, cidr: body.cidr };
    if (body.nomatch !== undefined) pve.nomatch = flag(body.nomatch);
    if (body.comment !== undefined) pve.comment = body.comment;
    return {
      verb: 'post',
      suffix: '/ipset/{name}',
      params: pve,
      status: 201,
      what: 'IP set entry added',
      log: { ipset: name, cidr: body.cidr },
    };
  });

  write('PUT', '/ipsets/:name/:cidr', (req) => {
    const name = parse(nameSchema, params(req).name);
    const cidr = parse(cidrSchema, params(req).cidr);
    if (name === undefined || cidr === undefined) return bad('Invalid IP set name or CIDR');
    const body = parse(updateIpsetEntrySchema, req.body ?? {});
    if (!body) return bad('Invalid request body');
    const pve: PveParamMap = { name, cidr };
    if (body.nomatch !== undefined) pve.nomatch = flag(body.nomatch);
    if (body.comment !== undefined) pve.comment = body.comment;
    if (body.digest !== undefined) pve.digest = body.digest;
    return {
      verb: 'put',
      suffix: '/ipset/{name}/{cidr}',
      params: pve,
      status: 200,
      what: 'IP set entry updated',
      log: { ipset: name, cidr },
    };
  });

  write('DELETE', '/ipsets/:name/:cidr', (req) => {
    const name = parse(nameSchema, params(req).name);
    const cidr = parse(cidrSchema, params(req).cidr);
    if (name === undefined || cidr === undefined) return bad('Invalid IP set name or CIDR');
    const options = deleteOptions(digestOnlySchema, req);
    if (!options) return bad('Invalid request');
    return {
      verb: 'delete',
      suffix: '/ipset/{name}/{cidr}',
      params: { name, cidr, ...(options.digest !== undefined ? { digest: options.digest } : {}) },
      status: 200,
      what: 'IP set entry removed',
      log: { ipset: name, cidr },
    };
  });
}
