import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { PveApiError } from '@proxion/pve-api';
import { resolveIdentity } from '../pve/identity.js';
import { guestTypeSchema, vmidSchema, hasPrivilege, formatPveErrorMessage, sanitizeMessage } from './shared.js';

/**
 * Guest firewall (T56): add / edit / delete / reorder a guest firewall rule, and edit the guest's
 * firewall options. Four more allow-listed calls this server performs against PVE, registered from
 * `actionsRoutes` (`routes.ts`) so they share its rate limiter, same convention as
 * `registerNetworkRoutes`. The raw `/api/pve/*` proxy stays read-only (the rule list and the
 * options are read through it); every write goes through the typed, validated bodies below, so the
 * caller never hands PVE a free-form field. Aliases, IP sets, the firewall log and the
 * datacenter/node firewall are out of scope. See "Guest actions" in README.md.
 *
 * pve-firewall checks `VM.Config.Network` on `/vms/{vmid}` for both the guest's rules and its
 * options. PVE validates the real source/dest grammar (IP, CIDR, range, alias, `+ipset`, comma
 * lists); this route only keeps the characters inside that grammar's alphabet.
 */

const FIREWALL_PRIVILEGE = 'VM.Config.Network';

const RULE_TYPES = ['in', 'out', 'group'] as const;
const VERDICTS = ['ACCEPT', 'DROP', 'REJECT'] as const;
const LOG_LEVELS = ['emerg', 'alert', 'crit', 'err', 'warning', 'notice', 'info', 'debug', 'nolog'] as const;

const GROUP_NAME_RE = /^[A-Za-z][A-Za-z0-9_-]{1,19}$/;
const MACRO_RE = /^[A-Za-z0-9_-]{1,64}$/;
const NAMED_PROTOS = ['tcp', 'udp', 'icmp', 'icmpv6', 'ipv6-icmp'] as const;
const PROTO_NUMBER_RE = /^\d{1,3}$/;
const ADDRESS_RE = /^[A-Za-z0-9_.:+/\-, ]+$/;
const PORT_ITEM = String.raw`(?:\d{1,5}(?::\d{1,5})?|[a-z][a-z0-9-]{1,30})`;
const PORTS_RE = new RegExp(`^${PORT_ITEM}(?:,${PORT_ITEM})*$`);
const IFACE_RE = /^net([0-9]|[12][0-9]|3[01])$/;
const ICMP_TYPE_RE = /^[A-Za-z0-9_-]{1,32}$/;
const DIGEST_RE = /^[A-Za-z0-9_-]{1,128}$/;
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
  return value
    .split(/[,:]/)
    .every((part) => !/^\d+$/.test(part) || Number(part) <= 65535);
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

/** The fields a rule body can carry, all optional here; per-route requirements are layered on. */
const ruleShape = {
  type: z.enum(RULE_TYPES),
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
function actionMatchesType(type: (typeof RULE_TYPES)[number], action: string): boolean {
  return type === 'group' ? GROUP_NAME_RE.test(action) && !isVerdict(action) : isVerdict(action);
}

// `.strict()`: an unknown key is a 400, same rationale as every other guest-action body schema.
const createRuleSchema = z
  .object({
    ...ruleShape,
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
  })
  .strict()
  .refine((body) => actionMatchesType(body.type, body.action), {
    message: 'action does not match type',
    path: ['action'],
  });

const updateRuleSchema = z
  .object({
    type: ruleShape.type.optional(),
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
        : isVerdict(body.action) || GROUP_NAME_RE.test(body.action)),
    { message: 'action does not match type', path: ['action'] },
  )
  .refine((body) => !(body.delete ?? []).some((key) => body[key] !== undefined), {
    message: 'A field cannot be both set and deleted',
    path: ['delete'],
  });

const policySchema = z.enum(VERDICTS);

const optionsSchema = z
  .object({
    enable: z.boolean().optional(),
    dhcp: z.boolean().optional(),
    ndp: z.boolean().optional(),
    radv: z.boolean().optional(),
    macfilter: z.boolean().optional(),
    ipfilter: z.boolean().optional(),
    policy_in: policySchema.optional(),
    policy_out: policySchema.optional(),
    log_level_in: z.enum(LOG_LEVELS).optional(),
    log_level_out: z.enum(LOG_LEVELS).optional(),
    digest: digestSchema.optional(),
  })
  .strict()
  .refine((body) => Object.keys(body).some((key) => key !== 'digest'), {
    message: 'At least one option to change is required',
  });

const deleteQuerySchema = z.object({ digest: digestSchema.optional() }).strict();

const posSchema = z.coerce.number().int().min(0).max(1_000_000);

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
    app.log.warn({ err: error }, 'Failed to check permissions for guest firewall update');
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

/** The PVE rule parameters for the fields a body carries (unset fields omitted). */
function ruleParams(body: {
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
}): Record<string, string | number> {
  const params: Record<string, string | number> = {};
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

type PveCall = (verb: 'post' | 'put' | 'delete', params: Record<string, string | number>) => Promise<unknown>;

/** Dispatches to the typed per-guest-type endpoint; `suffix` is `rules`, `rules/{pos}` or `options`. */
function callFirewall(
  identity: NonNullable<Awaited<ReturnType<typeof authorize>>>,
  params: GuestRouteParams,
  suffix: 'rules' | 'rules/{pos}' | 'options',
): PveCall {
  const client = identity.client;
  const base = { node: params.node, vmid: params.vmid };
  return (verb, extra) => {
    const merged = { ...base, ...extra } as never;
    // The generated client types each (verb, path) pair separately; the pair is composed from
    // validated pieces here, so the `never` casts only bridge that typing, not the values.
    const path = `/nodes/{node}/${params.type}/{vmid}/firewall/${suffix}` as never;
    if (verb === 'post') return client.post(path, merged);
    if (verb === 'put') return client.put(path, merged);
    return client.delete(path, merged);
  };
}

export function registerFirewallRoutes(
  app: FastifyInstance,
  guestActionsRateLimit: ReturnType<FastifyInstance['rateLimit']>,
): void {
  const BASE = '/api/actions/guest/:node/:type/:vmid/firewall';

  async function relay(
    reply: FastifyReply,
    what: string,
    run: () => Promise<unknown>,
    onOk: () => void,
  ): Promise<void> {
    try {
      await run();
    } catch (error) {
      if (sendPveError(reply, error)) return;
      app.log.warn({ err: error }, `Guest firewall ${what} request failed`);
      reply.code(502).send({ error: 'pve-unreachable' });
      return;
    }
    onOk();
  }

  app.post(`${BASE}/rules`, { onRequest: guestActionsRateLimit }, async (req, reply) => {
    const params = parseGuestParams(req.params as Record<string, string>);
    if (!params) {
      reply.code(400).send({ error: 'Invalid node/type/vmid' });
      return;
    }
    const parsed = createRuleSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      reply.code(400).send({ error: 'Invalid request body' });
      return;
    }
    const body = parsed.data;

    const identity = await authorize(app, req, reply, params.vmid);
    if (!identity) return;

    const pve = ruleParams(body);
    if (body.pos !== undefined) pve.pos = body.pos;
    await relay(
      reply,
      'rule create',
      () => callFirewall(identity, params, 'rules')('post', pve),
      () => {
        app.log.info(
          { username: identity.username, node: params.node, type: params.type, vmid: params.vmid, ruleType: body.type },
          'Guest firewall rule added',
        );
        reply.code(201).send({ ok: true });
      },
    );
  });

  app.put(`${BASE}/rules/:pos`, { onRequest: guestActionsRateLimit }, async (req, reply) => {
    const rawParams = req.params as Record<string, string>;
    const params = parseGuestParams(rawParams);
    const pos = posSchema.safeParse(rawParams.pos);
    if (!params || !pos.success) {
      reply.code(400).send({ error: 'Invalid node/type/vmid/pos' });
      return;
    }
    const parsed = updateRuleSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      reply.code(400).send({ error: 'Invalid request body' });
      return;
    }
    const body = parsed.data;

    const identity = await authorize(app, req, reply, params.vmid);
    if (!identity) return;

    const pve: Record<string, string | number> = { ...ruleParams(body), pos: pos.data };
    if (body.moveto !== undefined) pve.moveto = body.moveto;
    if (body.delete !== undefined) {
      pve.delete = [...new Set(body.delete)].map((key) => CLEARABLE_FIELDS[key]).join(',');
    }
    if (body.digest !== undefined) pve.digest = body.digest;
    await relay(
      reply,
      'rule update',
      () => callFirewall(identity, params, 'rules/{pos}')('put', pve),
      () => {
        app.log.info(
          { username: identity.username, node: params.node, type: params.type, vmid: params.vmid, pos: pos.data },
          'Guest firewall rule updated',
        );
        reply.code(200).send({ ok: true });
      },
    );
  });

  app.delete(`${BASE}/rules/:pos`, { onRequest: guestActionsRateLimit }, async (req, reply) => {
    const rawParams = req.params as Record<string, string>;
    const params = parseGuestParams(rawParams);
    const pos = posSchema.safeParse(rawParams.pos);
    const query = deleteQuerySchema.safeParse(req.query ?? {});
    if (!params || !pos.success) {
      reply.code(400).send({ error: 'Invalid node/type/vmid/pos' });
      return;
    }
    if (!query.success) {
      reply.code(400).send({ error: 'Invalid request query' });
      return;
    }

    const identity = await authorize(app, req, reply, params.vmid);
    if (!identity) return;

    const pve: Record<string, string | number> = { pos: pos.data };
    if (query.data.digest !== undefined) pve.digest = query.data.digest;
    await relay(
      reply,
      'rule delete',
      () => callFirewall(identity, params, 'rules/{pos}')('delete', pve),
      () => {
        app.log.info(
          { username: identity.username, node: params.node, type: params.type, vmid: params.vmid, pos: pos.data },
          'Guest firewall rule removed',
        );
        reply.code(200).send({ ok: true });
      },
    );
  });

  app.put(`${BASE}/options`, { onRequest: guestActionsRateLimit }, async (req, reply) => {
    const params = parseGuestParams(req.params as Record<string, string>);
    if (!params) {
      reply.code(400).send({ error: 'Invalid node/type/vmid' });
      return;
    }
    const parsed = optionsSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      reply.code(400).send({ error: 'Invalid request body' });
      return;
    }
    const body = parsed.data;

    const identity = await authorize(app, req, reply, params.vmid);
    if (!identity) return;

    const pve: Record<string, string | number> = {};
    for (const [key, value] of Object.entries(body)) {
      if (value === undefined) continue;
      pve[key] = typeof value === 'boolean' ? flag(value) : value;
    }
    await relay(
      reply,
      'options update',
      () => callFirewall(identity, params, 'options')('put', pve),
      () => {
        app.log.info(
          {
            username: identity.username,
            node: params.node,
            type: params.type,
            vmid: params.vmid,
            options: Object.keys(pve).filter((key) => key !== 'digest'),
          },
          'Guest firewall options saved',
        );
        reply.code(200).send({ ok: true });
      },
    );
  });
}
