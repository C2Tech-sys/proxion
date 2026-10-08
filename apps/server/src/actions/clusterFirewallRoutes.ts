import { isIP } from 'node:net';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { PveApiError, type PveClient } from '@proxion/pve-api';
import { resolveIdentity } from '../pve/identity.js';
import { formatPveErrorMessage, sanitizeMessage } from './shared.js';

/**
 * Datacenter firewall (T67): the cluster-wide rules, the firewall options, security groups (and the
 * rules inside them), aliases and IP sets -- PVE's Datacenter -> Firewall panel. Registered from
 * `actionsRoutes` (`routes.ts`) so the routes share its rate limiter, same convention as
 * `registerFirewallRoutes`. The raw `/api/pve/*` proxy stays read-only (the lists are read through
 * it); every write goes through the typed, validated bodies below, so the caller never hands PVE a
 * free-form field.
 *
 * pve-firewall checks `Sys.Modify` on `/` for every cluster-level firewall write, which is what each
 * route requires here. Enabling the datacenter firewall with an inbound DROP policy can lock the
 * operator out of every node; that confirmation lives in the web UI, the route only validates.
 *
 * The rule body contract is the guest firewall's (`firewallRoutes.ts`); it is duplicated here
 * (that file is intentionally untouched). A security group's own rules are `in`/`out` only -- PVE
 * does not nest groups.
 *
 * `rename` on `POST /groups` and `POST /ipsets` is PVE's own update-in-place field: `group`/`name` is
 * the (new) name and `rename` the EXISTING one; setting both to the same value updates the comment.
 * On `PUT /aliases/:name` it is the other way round (the path names the existing alias, `rename` the
 * new name). The routes pass these through unchanged.
 */

const FIREWALL_PRIVILEGE = 'Sys.Modify';

const RULE_TYPES = ['in', 'out', 'group'] as const;
const GROUP_RULE_TYPES = ['in', 'out'] as const;
const VERDICTS = ['ACCEPT', 'DROP', 'REJECT'] as const;
const LOG_LEVELS = ['emerg', 'alert', 'crit', 'err', 'warning', 'notice', 'info', 'debug', 'nolog'] as const;

const GROUP_NAME_RE = /^[A-Za-z][A-Za-z0-9_-]{1,19}$/;
const ALIAS_NAME_RE = /^[A-Za-z][A-Za-z0-9_-]{1,63}$/;
const MACRO_RE = /^[A-Za-z0-9_-]{1,64}$/;
const NAMED_PROTOS = ['tcp', 'udp', 'icmp', 'icmpv6', 'ipv6-icmp'] as const;
const PROTO_NUMBER_RE = /^\d{1,3}$/;
const ADDRESS_RE = /^[A-Za-z0-9_.:+/\-, ]+$/;
const PORT_ITEM = String.raw`(?:\d{1,5}(?::\d{1,5})?|[a-z][a-z0-9-]{1,30})`;
const PORTS_RE = new RegExp(`^${PORT_ITEM}(?:,${PORT_ITEM})*$`);
const IFACE_RE = /^net([0-9]|[12][0-9]|3[01])$/;
const ICMP_TYPE_RE = /^[A-Za-z0-9_-]{1,32}$/;
const DIGEST_RE = /^[A-Za-z0-9_-]{1,128}$/;
const RATE_RE = /^[1-9][0-9]{0,8}\/(?:second|minute|hour|day)$/;
const MAX_ADDRESS_LENGTH = 512;
const MAX_COMMENT_LENGTH = 1024;

/** The string fields a PUT may clear through PVE's `delete` list, keyed by the API field name this
 * route accepts; the value is the PVE parameter name. */
const CLEARABLE_FIELDS = {
  macro: 'macro',
  proto: 'proto',
  source: 'source',
  dest: 'dest',
  sport: 'sport',
  dport: 'dport',
  iface: 'iface',
  log: 'log',
  comment: 'comment',
  icmpType: 'icmp-type',
} as const;
type ClearableField = keyof typeof CLEARABLE_FIELDS;
const CLEARABLE_KEYS = Object.keys(CLEARABLE_FIELDS) as [ClearableField, ...ClearableField[]];

function hasControlCharacter(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

/** Every numeric port in a (comma list of) port or port-range is 0..65535. */
function portsInRange(value: string): boolean {
  return value.split(/[,:]/).every((part) => !/^\d+$/.test(part) || Number(part) <= 65535);
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

const protoSchema = z.string().refine(
  (v) => (NAMED_PROTOS as readonly string[]).includes(v) || (PROTO_NUMBER_RE.test(v) && Number(v) <= 255),
  { message: 'Invalid protocol' },
);
const addressSchema = z.string().max(MAX_ADDRESS_LENGTH).regex(ADDRESS_RE);
const portsSchema = z.string().regex(PORTS_RE).refine(portsInRange, { message: 'Port out of range' });
const commentSchema = z
  .string()
  .max(MAX_COMMENT_LENGTH)
  .refine((v) => !hasControlCharacter(v), { message: 'Comment must be a single line' });
const digestSchema = z.string().regex(DIGEST_RE);
const cidrSchema = z.string().max(64).refine(isAddressOrCidr, { message: 'Invalid IP address or CIDR' });
const posSchema = z.coerce.number().int().min(0).max(1_000_000);

/** The fields a rule body can carry, all required here; per-route requirements are layered on. */
const ruleShape = {
  action: z.string(),
  enable: z.boolean(),
  macro: z.string().regex(MACRO_RE),
  proto: protoSchema,
  source: addressSchema,
  dest: addressSchema,
  sport: portsSchema,
  dport: portsSchema,
  iface: z.string().regex(IFACE_RE),
  log: z.enum(LOG_LEVELS),
  comment: commentSchema,
  icmpType: z.string().regex(ICMP_TYPE_RE),
};

function isVerdict(action: string): boolean {
  return (VERDICTS as readonly string[]).includes(action);
}

/** `in`/`out` take a verdict; `group` takes a security-group name (which is never a bare verdict). */
function actionMatchesType(type: string, action: string): boolean {
  return type === 'group' ? GROUP_NAME_RE.test(action) && !isVerdict(action) : isVerdict(action);
}

function makeCreateRuleSchema(types: readonly [string, ...string[]]) {
  return z
    .object({
      type: z.enum(types as [string, ...string[]]),
      action: ruleShape.action,
      enable: ruleShape.enable.default(true),
      macro: ruleShape.macro.optional(),
      proto: ruleShape.proto.optional(),
      source: ruleShape.source.optional(),
      dest: ruleShape.dest.optional(),
      sport: ruleShape.sport.optional(),
      dport: ruleShape.dport.optional(),
      iface: ruleShape.iface.optional(),
      log: ruleShape.log.optional(),
      comment: ruleShape.comment.optional(),
      icmpType: ruleShape.icmpType.optional(),
      pos: z.number().int().min(0).optional(),
      digest: digestSchema.optional(),
    })
    .strict()
    .refine((body) => actionMatchesType(body.type, body.action), {
      message: 'action does not match type',
      path: ['action'],
    });
}

function makeUpdateRuleSchema(types: readonly [string, ...string[]], allowGroupAction: boolean) {
  return z
    .object({
      type: z.enum(types as [string, ...string[]]).optional(),
      action: ruleShape.action.optional(),
      enable: ruleShape.enable.optional(),
      macro: ruleShape.macro.optional(),
      proto: ruleShape.proto.optional(),
      source: ruleShape.source.optional(),
      dest: ruleShape.dest.optional(),
      sport: ruleShape.sport.optional(),
      dport: ruleShape.dport.optional(),
      iface: ruleShape.iface.optional(),
      log: ruleShape.log.optional(),
      comment: ruleShape.comment.optional(),
      icmpType: ruleShape.icmpType.optional(),
      moveto: z.number().int().min(0).optional(),
      delete: z.array(z.enum(CLEARABLE_KEYS)).min(1).max(CLEARABLE_KEYS.length).optional(),
      digest: digestSchema.optional(),
    })
    .strict()
    .refine((body) => Object.keys(body).some((key) => key !== 'digest'), {
      message: 'At least one field to change is required',
    })
    .refine(
      (body) =>
        body.action === undefined ||
        (body.type !== undefined
          ? actionMatchesType(body.type, body.action)
          : isVerdict(body.action) || (allowGroupAction && GROUP_NAME_RE.test(body.action))),
      { message: 'action does not match type', path: ['action'] },
    )
    .refine((body) => !(body.delete ?? []).some((key) => body[key] !== undefined), {
      message: 'A field cannot be both set and deleted',
      path: ['delete'],
    });
}

const clusterCreateRuleSchema = makeCreateRuleSchema(RULE_TYPES);
const clusterUpdateRuleSchema = makeUpdateRuleSchema(RULE_TYPES, true);
const groupCreateRuleSchema = makeCreateRuleSchema(GROUP_RULE_TYPES);
const groupUpdateRuleSchema = makeUpdateRuleSchema(GROUP_RULE_TYPES, false);

const policySchema = z.enum(VERDICTS);

const optionsSchema = z
  .object({
    enable: z.boolean().optional(),
    policy_in: policySchema.optional(),
    policy_out: policySchema.optional(),
    ebtables: z.boolean().optional(),
    log_ratelimit: z
      .object({
        enabled: z.boolean(),
        burst: z.number().int().min(0).max(1_000_000).optional(),
        rate: z.string().regex(RATE_RE).optional(),
      })
      .strict()
      .optional(),
    digest: digestSchema.optional(),
  })
  .strict()
  .refine((body) => Object.keys(body).some((key) => key !== 'digest'), {
    message: 'At least one option to change is required',
  });

const createGroupSchema = z
  .object({
    group: z.string().regex(GROUP_NAME_RE),
    comment: commentSchema.optional(),
    rename: z.string().regex(GROUP_NAME_RE).optional(),
    digest: digestSchema.optional(),
  })
  .strict();

const createAliasSchema = z
  .object({
    name: z.string().regex(ALIAS_NAME_RE),
    cidr: cidrSchema,
    comment: commentSchema.optional(),
  })
  .strict();

const updateAliasSchema = z
  .object({
    cidr: cidrSchema,
    comment: commentSchema.optional(),
    rename: z.string().regex(ALIAS_NAME_RE).optional(),
    digest: digestSchema.optional(),
  })
  .strict();

const createIpsetSchema = z
  .object({
    name: z.string().regex(ALIAS_NAME_RE),
    comment: commentSchema.optional(),
    rename: z.string().regex(ALIAS_NAME_RE).optional(),
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

const emptyQuerySchema = z.object({}).strict();
const digestQuerySchema = z.object({ digest: digestSchema.optional() }).strict();
const ipsetDeleteQuerySchema = z
  .object({
    digest: digestSchema.optional(),
    force: z.enum(['0', '1', 'true', 'false']).optional(),
  })
  .strict();

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

/** Whether the caller's own credentials hold `priv` on the ACL `path`, via
 * `GET /access/permissions?path=<path>` (real PVE nests the result under the requested path; falls
 * back to a flat map like `shared.ts`'s `hasPrivilege`). Local to this file, same pattern as
 * `notify/routes.ts`'s `hasRootSysModify`. */
async function hasPathPrivilege(client: PveClient, path: string, priv: string): Promise<boolean> {
  const perms = (await client.get('/access/permissions', { path })) as Record<string, unknown>;
  const scoped = (perms[path] as Record<string, unknown> | undefined) ?? perms;
  return Boolean(scoped[priv]);
}

/** The shared session/token/privilege gate. Sends the failure reply itself and returns
 * `undefined`; otherwise returns the caller's identity. */
async function authorize(app: FastifyInstance, req: FastifyRequest, reply: FastifyReply) {
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
    allowed = await hasPathPrivilege(identity.client, '/', FIREWALL_PRIVILEGE);
  } catch (error) {
    if (sendPveError(reply, error)) return undefined;
    app.log.warn({ err: error }, 'Failed to check permissions for datacenter firewall update');
    reply.code(502).send({ error: 'pve-unreachable' });
    return undefined;
  }
  if (!allowed) {
    reply.code(403).send({ error: 'forbidden', missing: FIREWALL_PRIVILEGE });
    return undefined;
  }
  return identity;
}

const flag = (value: boolean): 1 | 0 => (value ? 1 : 0);

type PveParamMap = Record<string, string | number>;

interface RuleFields {
  type?: string | undefined;
  action?: string | undefined;
  enable?: boolean | undefined;
  macro?: string | undefined;
  proto?: string | undefined;
  source?: string | undefined;
  dest?: string | undefined;
  sport?: string | undefined;
  dport?: string | undefined;
  iface?: string | undefined;
  log?: string | undefined;
  comment?: string | undefined;
  icmpType?: string | undefined;
}

/** The PVE rule parameters for the fields a body carries (unset fields omitted). */
function ruleParams(body: RuleFields): PveParamMap {
  const params: PveParamMap = {};
  if (body.type !== undefined) params.type = body.type;
  if (body.action !== undefined) params.action = body.action;
  if (body.enable !== undefined) params.enable = flag(body.enable);
  if (body.macro !== undefined) params.macro = body.macro;
  if (body.proto !== undefined) params.proto = body.proto;
  if (body.source !== undefined) params.source = body.source;
  if (body.dest !== undefined) params.dest = body.dest;
  if (body.sport !== undefined) params.sport = body.sport;
  if (body.dport !== undefined) params.dport = body.dport;
  if (body.iface !== undefined) params.iface = body.iface;
  if (body.log !== undefined) params.log = body.log;
  if (body.comment !== undefined) params.comment = body.comment;
  if (body.icmpType !== undefined) params['icmp-type'] = body.icmpType;
  return params;
}

interface RuleCreateBody extends RuleFields {
  pos?: number | undefined;
  digest?: string | undefined;
}
interface RuleUpdateBody extends RuleFields {
  moveto?: number | undefined;
  delete?: ClearableField[] | undefined;
  digest?: string | undefined;
}

function createRuleParams(body: RuleCreateBody): PveParamMap {
  const pve = ruleParams(body);
  if (body.pos !== undefined) pve.pos = body.pos;
  if (body.digest !== undefined) pve.digest = body.digest;
  return pve;
}

function updateRuleParams(body: RuleUpdateBody): PveParamMap {
  const pve = ruleParams(body);
  if (body.moveto !== undefined) pve.moveto = body.moveto;
  if (body.delete !== undefined) {
    pve.delete = [...new Set(body.delete)].map((key) => CLEARABLE_FIELDS[key]).join(',');
  }
  if (body.digest !== undefined) pve.digest = body.digest;
  return pve;
}

/** `enable=1,burst=5,rate=1/second` -- PVE's property-string form of the log rate limit. */
function composeLogRatelimit(value: { enabled: boolean; burst?: number | undefined; rate?: string | undefined }): string {
  const parts = [`enable=${flag(value.enabled)}`];
  if (value.burst !== undefined) parts.push(`burst=${value.burst}`);
  if (value.rate !== undefined) parts.push(`rate=${value.rate}`);
  return parts.join(',');
}

/** One validated PVE call: the verb, the path template (with `{placeholders}` filled from
 * `params`), the HTTP status to answer with and the audit-log fields. */
interface Plan {
  verb: 'post' | 'put' | 'delete';
  path: string;
  params: PveParamMap;
  status: 200 | 201;
  what: string;
  log?: Record<string, unknown>;
}
type Planned = Plan | { error: string };

const BASE = '/api/actions/datacenter/firewall';

export function registerClusterFirewallRoutes(
  app: FastifyInstance,
  guestActionsRateLimit: ReturnType<FastifyInstance['rateLimit']>,
): void {
  /** Validates (400), authorizes (401/403), calls PVE (4xx/502 mapped) and answers `{ ok: true }`. */
  function write(
    method: 'POST' | 'PUT' | 'DELETE',
    url: string,
    plan: (req: FastifyRequest) => Planned,
  ): void {
    app.route({
      method,
      url: `${BASE}${url}`,
      onRequest: guestActionsRateLimit,
      handler: async (req, reply) => {
        const planned = plan(req);
        if ('error' in planned) {
          reply.code(400).send({ error: planned.error });
          return;
        }
        const identity = await authorize(app, req, reply);
        if (!identity) return;

        try {
          // The generated client types each (verb, path) pair separately; the pair is composed from
          // validated pieces here, so the `never` casts only bridge that typing, not the values.
          const path = planned.path as never;
          const params = planned.params as never;
          if (planned.verb === 'post') await identity.client.post(path, params);
          else if (planned.verb === 'put') await identity.client.put(path, params);
          else await identity.client.delete(path, params);
        } catch (error) {
          if (sendPveError(reply, error)) return;
          app.log.warn({ err: error }, `Datacenter firewall ${planned.what} request failed`);
          reply.code(502).send({ error: 'pve-unreachable' });
          return;
        }
        app.log.info({ username: identity.username, ...planned.log }, `Datacenter firewall ${planned.what}`);
        reply.code(planned.status).send({ ok: true });
      },
    });
  }

  const bad = (message: string): { error: string } => ({ error: message });
  const params = (req: FastifyRequest) => req.params as Record<string, string>;

  /** Parses a path param with a schema; `undefined` on failure. */
  const parse = <T>(schema: z.ZodType<T>, value: unknown): T | undefined => {
    const result = schema.safeParse(value);
    return result.success ? result.data : undefined;
  };

  // --- rules -------------------------------------------------------------------------------

  write('POST', '/rules', (req) => {
    const body = parse(clusterCreateRuleSchema, req.body ?? {});
    if (!body) return bad('Invalid request body');
    return {
      verb: 'post',
      path: '/cluster/firewall/rules',
      params: createRuleParams(body),
      status: 201,
      what: 'rule added',
      log: { ruleType: body.type },
    };
  });

  write('PUT', '/rules/:pos', (req) => {
    const pos = parse(posSchema, params(req).pos);
    if (pos === undefined) return bad('Invalid pos');
    const body = parse(clusterUpdateRuleSchema, req.body ?? {});
    if (!body) return bad('Invalid request body');
    return {
      verb: 'put',
      path: '/cluster/firewall/rules/{pos}',
      params: { ...updateRuleParams(body), pos },
      status: 200,
      what: 'rule updated',
      log: { pos },
    };
  });

  write('DELETE', '/rules/:pos', (req) => {
    const pos = parse(posSchema, params(req).pos);
    if (pos === undefined) return bad('Invalid pos');
    const query = parse(digestQuerySchema, req.query ?? {});
    if (!query) return bad('Invalid request query');
    return {
      verb: 'delete',
      path: '/cluster/firewall/rules/{pos}',
      params: { pos, ...(query.digest !== undefined ? { digest: query.digest } : {}) },
      status: 200,
      what: 'rule removed',
      log: { pos },
    };
  });

  // --- options -----------------------------------------------------------------------------

  write('PUT', '/options', (req) => {
    const body = parse(optionsSchema, req.body ?? {});
    if (!body) return bad('Invalid request body');
    const pve: PveParamMap = {};
    if (body.enable !== undefined) pve.enable = flag(body.enable);
    if (body.policy_in !== undefined) pve.policy_in = body.policy_in;
    if (body.policy_out !== undefined) pve.policy_out = body.policy_out;
    if (body.ebtables !== undefined) pve.ebtables = flag(body.ebtables);
    if (body.log_ratelimit !== undefined) pve.log_ratelimit = composeLogRatelimit(body.log_ratelimit);
    if (body.digest !== undefined) pve.digest = body.digest;
    return {
      verb: 'put',
      path: '/cluster/firewall/options',
      params: pve,
      status: 200,
      what: 'options saved',
      log: { options: Object.keys(pve).filter((key) => key !== 'digest') },
    };
  });

  // --- security groups ---------------------------------------------------------------------

  write('POST', '/groups', (req) => {
    const body = parse(createGroupSchema, req.body ?? {});
    if (!body) return bad('Invalid request body');
    const pve: PveParamMap = { group: body.group };
    if (body.comment !== undefined) pve.comment = body.comment;
    if (body.rename !== undefined) pve.rename = body.rename;
    if (body.digest !== undefined) pve.digest = body.digest;
    return {
      verb: 'post',
      path: '/cluster/firewall/groups',
      params: pve,
      status: 201,
      what: body.rename !== undefined ? 'security group renamed' : 'security group saved',
      log: { group: body.group },
    };
  });

  // PVE's DELETE /cluster/firewall/groups/{group} takes no digest, so the query must be empty.
  write('DELETE', '/groups/:group', (req) => {
    const group = parse(z.string().regex(GROUP_NAME_RE), params(req).group);
    if (group === undefined) return bad('Invalid group');
    if (!parse(emptyQuerySchema, req.query ?? {})) return bad('Invalid request query');
    return {
      verb: 'delete',
      path: '/cluster/firewall/groups/{group}',
      params: { group },
      status: 200,
      what: 'security group removed',
      log: { group },
    };
  });

  write('POST', '/groups/:group/rules', (req) => {
    const group = parse(z.string().regex(GROUP_NAME_RE), params(req).group);
    if (group === undefined) return bad('Invalid group');
    const body = parse(groupCreateRuleSchema, req.body ?? {});
    if (!body) return bad('Invalid request body');
    return {
      verb: 'post',
      path: '/cluster/firewall/groups/{group}',
      params: { ...createRuleParams(body), group },
      status: 201,
      what: 'security group rule added',
      log: { group, ruleType: body.type },
    };
  });

  write('PUT', '/groups/:group/rules/:pos', (req) => {
    const group = parse(z.string().regex(GROUP_NAME_RE), params(req).group);
    const pos = parse(posSchema, params(req).pos);
    if (group === undefined || pos === undefined) return bad('Invalid group/pos');
    const body = parse(groupUpdateRuleSchema, req.body ?? {});
    if (!body) return bad('Invalid request body');
    return {
      verb: 'put',
      path: '/cluster/firewall/groups/{group}/{pos}',
      params: { ...updateRuleParams(body), group, pos },
      status: 200,
      what: 'security group rule updated',
      log: { group, pos },
    };
  });

  write('DELETE', '/groups/:group/rules/:pos', (req) => {
    const group = parse(z.string().regex(GROUP_NAME_RE), params(req).group);
    const pos = parse(posSchema, params(req).pos);
    if (group === undefined || pos === undefined) return bad('Invalid group/pos');
    const query = parse(digestQuerySchema, req.query ?? {});
    if (!query) return bad('Invalid request query');
    return {
      verb: 'delete',
      path: '/cluster/firewall/groups/{group}/{pos}',
      params: { group, pos, ...(query.digest !== undefined ? { digest: query.digest } : {}) },
      status: 200,
      what: 'security group rule removed',
      log: { group, pos },
    };
  });

  // --- aliases -----------------------------------------------------------------------------

  write('POST', '/aliases', (req) => {
    const body = parse(createAliasSchema, req.body ?? {});
    if (!body) return bad('Invalid request body');
    const pve: PveParamMap = { name: body.name, cidr: body.cidr };
    if (body.comment !== undefined) pve.comment = body.comment;
    return {
      verb: 'post',
      path: '/cluster/firewall/aliases',
      params: pve,
      status: 201,
      what: 'alias added',
      log: { alias: body.name },
    };
  });

  write('PUT', '/aliases/:name', (req) => {
    const name = parse(z.string().regex(ALIAS_NAME_RE), params(req).name);
    if (name === undefined) return bad('Invalid alias name');
    const body = parse(updateAliasSchema, req.body ?? {});
    if (!body) return bad('Invalid request body');
    const pve: PveParamMap = { name, cidr: body.cidr };
    if (body.comment !== undefined) pve.comment = body.comment;
    if (body.rename !== undefined) pve.rename = body.rename;
    if (body.digest !== undefined) pve.digest = body.digest;
    return {
      verb: 'put',
      path: '/cluster/firewall/aliases/{name}',
      params: pve,
      status: 200,
      what: body.rename !== undefined ? 'alias renamed' : 'alias updated',
      log: { alias: name },
    };
  });

  write('DELETE', '/aliases/:name', (req) => {
    const name = parse(z.string().regex(ALIAS_NAME_RE), params(req).name);
    if (name === undefined) return bad('Invalid alias name');
    const query = parse(digestQuerySchema, req.query ?? {});
    if (!query) return bad('Invalid request query');
    return {
      verb: 'delete',
      path: '/cluster/firewall/aliases/{name}',
      params: { name, ...(query.digest !== undefined ? { digest: query.digest } : {}) },
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
      path: '/cluster/firewall/ipset',
      params: pve,
      status: 201,
      what: body.rename !== undefined ? 'IP set renamed' : 'IP set added',
      log: { ipset: body.name },
    };
  });

  // PVE's DELETE /cluster/firewall/ipset/{name} takes `force` (also drop the members), not a digest.
  write('DELETE', '/ipsets/:name', (req) => {
    const name = parse(z.string().regex(ALIAS_NAME_RE), params(req).name);
    if (name === undefined) return bad('Invalid IP set name');
    const query = parse(ipsetDeleteQuerySchema, req.query ?? {});
    if (!query) return bad('Invalid request query');
    const force = query.force === '1' || query.force === 'true';
    return {
      verb: 'delete',
      path: '/cluster/firewall/ipset/{name}',
      params: { name, ...(force ? { force: 1 } : {}) },
      status: 200,
      what: 'IP set removed',
      log: { ipset: name, force },
    };
  });

  write('POST', '/ipsets/:name', (req) => {
    const name = parse(z.string().regex(ALIAS_NAME_RE), params(req).name);
    if (name === undefined) return bad('Invalid IP set name');
    const body = parse(addIpsetEntrySchema, req.body ?? {});
    if (!body) return bad('Invalid request body');
    const pve: PveParamMap = { name, cidr: body.cidr };
    if (body.nomatch !== undefined) pve.nomatch = flag(body.nomatch);
    if (body.comment !== undefined) pve.comment = body.comment;
    return {
      verb: 'post',
      path: '/cluster/firewall/ipset/{name}',
      params: pve,
      status: 201,
      what: 'IP set entry added',
      log: { ipset: name, cidr: body.cidr },
    };
  });

  write('PUT', '/ipsets/:name/:cidr', (req) => {
    const name = parse(z.string().regex(ALIAS_NAME_RE), params(req).name);
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
      path: '/cluster/firewall/ipset/{name}/{cidr}',
      params: pve,
      status: 200,
      what: 'IP set entry updated',
      log: { ipset: name, cidr },
    };
  });

  write('DELETE', '/ipsets/:name/:cidr', (req) => {
    const name = parse(z.string().regex(ALIAS_NAME_RE), params(req).name);
    const cidr = parse(cidrSchema, params(req).cidr);
    if (name === undefined || cidr === undefined) return bad('Invalid IP set name or CIDR');
    const query = parse(digestQuerySchema, req.query ?? {});
    if (!query) return bad('Invalid request query');
    return {
      verb: 'delete',
      path: '/cluster/firewall/ipset/{name}/{cidr}',
      params: { name, cidr, ...(query.digest !== undefined ? { digest: query.digest } : {}) },
      status: 200,
      what: 'IP set entry removed',
      log: { ipset: name, cidr },
    };
  });
}
