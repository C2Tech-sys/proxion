import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { PveApiError, type PveClient } from '@proxion/pve-api';
import { resolveIdentity } from '../pve/identity.js';
import { formatPveErrorMessage, sanitizeMessage } from './shared.js';

/**
 * Datacenter -> Permissions (T68): users, groups, ACL entries, API tokens and password changes.
 * Allow-listed calls this server performs against PVE's `/access/*` tree, registered from
 * `actionsRoutes` (`routes.ts`) so they share its rate limiter, same convention as
 * `registerNetworkRoutes`. The raw `/api/pve/*` proxy stays read-only; the browser lists users,
 * groups, roles, ACL, realms and tokens through it.
 *
 * PVE's own permission model is intricate (e.g. adding a user to a group also needs rights on that
 * group). Each route checks ONE sensible privilege before touching PVE and relays PVE's own 403 as
 * `pve-rejected` for anything finer.
 *
 * Secrets: a `password` / `confirmationPassword` is forwarded to PVE and never logged, echoed or
 * stored. A newly created API token's secret (`value`) is returned ONCE in the 200 body of the
 * create call (with `cache-control: no-store`) and never logged. No handler logs a request body.
 */

const USERS_PRIVILEGE = 'User.Modify';
const REALM_PRIVILEGE = 'Realm.AllocateUser';
const GROUP_PRIVILEGE = 'Group.Allocate';
const ACL_PRIVILEGE = 'Permissions.Modify';

const USERID_RE = /^[A-Za-z0-9._-]+@[A-Za-z0-9._-]+$/;
const GROUPID_RE = /^[A-Za-z0-9._-]{1,64}$/;
const ROLEID_RE = /^[A-Za-z0-9._-]{1,64}$/;
const TOKENID_RE = /^[A-Za-z0-9._-]{2,64}$/;
const FULL_TOKENID_RE = /^[A-Za-z0-9._-]+@[A-Za-z0-9._-]+![A-Za-z0-9._-]{2,64}$/;
const ACL_PATH_RE = /^\/[A-Za-z0-9/._-]*$/;
const BARE_EMAIL_RE = /^[^\s@,<>"]+@[^\s@,<>"]+\.[^\s@,<>"]+$/;
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS_RE = /[\x00-\x1f\x7f]/;

const useridSchema = z.string().min(3).max(128).regex(USERID_RE);
const groupidSchema = z.string().regex(GROUPID_RE);

/** A single-line free-text field: no control characters (so no newlines), bounded length. */
const singleLine = (max: number) =>
  z
    .string()
    .max(max)
    .refine((v) => !CONTROL_CHARS_RE.test(v), { message: 'must not contain control characters' });

const emailSchema = z.string().min(3).max(320).regex(BARE_EMAIL_RE, { message: 'must be a bare email address' });

/** Unix seconds, or `0` for "never expires". */
const expireSchema = z.number().int().min(0).max(4_102_444_800);

/** `.`/`..` segments never reach PVE's ACL path normalisation. */
function hasDotSegment(path: string): boolean {
  return path.split('/').some((segment) => segment === '.' || segment === '..');
}

const aclPathSchema = z
  .string()
  .max(256)
  .regex(ACL_PATH_RE)
  .refine((v) => !hasDotSegment(v), { message: 'path must not contain . or .. segments' });

const createUserSchema = z
  .object({
    userid: useridSchema,
    password: z.string().min(8).max(64).optional(),
    enable: z.boolean().optional(),
    expire: expireSchema.optional(),
    firstname: singleLine(128).optional(),
    lastname: singleLine(128).optional(),
    email: emailSchema.optional(),
    groups: z.array(groupidSchema).max(64).optional(),
    comment: singleLine(2048).optional(),
  })
  .strict();

const updateUserSchema = z
  .object({
    enable: z.boolean().optional(),
    expire: expireSchema.nullable().optional(),
    firstname: singleLine(128).nullable().optional(),
    lastname: singleLine(128).nullable().optional(),
    email: emailSchema.nullable().optional(),
    groups: z.array(groupidSchema).max(64).nullable().optional(),
    comment: singleLine(2048).nullable().optional(),
  })
  .strict();

const passwordSchema = z
  .object({
    userid: useridSchema,
    password: z.string().min(8).max(64),
    /** The signed-in user's CURRENT password; PVE 8.1+ requires it for a self-service change. */
    confirmationPassword: z.string().min(1).max(256).optional(),
  })
  .strict();

const createGroupSchema = z.object({ groupid: groupidSchema, comment: singleLine(2048).optional() }).strict();
const updateGroupSchema = z.object({ comment: singleLine(2048) }).strict();

const aclSchema = z
  .object({
    path: aclPathSchema,
    roles: z.array(z.string().regex(ROLEID_RE)).min(1).max(32),
    users: z.array(useridSchema).min(1).max(64).optional(),
    groups: z.array(groupidSchema).min(1).max(64).optional(),
    tokens: z.array(z.string().max(200).regex(FULL_TOKENID_RE)).min(1).max(64).optional(),
    propagate: z.boolean().default(true),
    remove: z.boolean().default(false),
  })
  .strict()
  .refine((v) => [v.users, v.groups, v.tokens].filter((x) => x !== undefined).length === 1, {
    message: 'exactly one of users, groups or tokens is required',
  });

const createTokenSchema = z
  .object({
    tokenid: z.string().regex(TOKENID_RE),
    comment: singleLine(2048).optional(),
    expire: expireSchema.optional(),
    privsep: z.boolean().default(true),
  })
  .strict();

const updateTokenSchema = z
  .object({
    comment: singleLine(2048).optional(),
    expire: expireSchema.optional(),
    privsep: z.boolean().optional(),
  })
  .strict();

/** Same `502`/`4xx` mapping every action route uses; `true` iff it sent a reply. */
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

/**
 * Whether the caller's own credentials hold `privilege` on an arbitrary ACL `path`, via
 * `GET /access/permissions?path=<path>` (real PVE nests the result under the requested path; falls
 * back to a flat map like `shared.ts`'s `hasPrivilege`). Local to this file -- same pattern as
 * `hasRootSysModify` in `notify/routes.ts`; the foreman unifies these later.
 */
async function hasPathPrivilege(client: PveClient, path: string, privilege: string): Promise<boolean> {
  const perms = (await client.get('/access/permissions', { path })) as Record<string, unknown>;
  const scoped = (perms[path] as Record<string, unknown> | undefined) ?? perms;
  return Boolean(scoped[privilege]);
}

/** Session gate: 401 / token-mode 403. Sends the failure reply itself and returns `undefined`. */
async function authenticate(app: FastifyInstance, req: FastifyRequest, reply: FastifyReply) {
  const identity = await resolveIdentity(app, req);
  if (!identity) {
    reply.code(401).send({ error: 'Not authenticated' });
    return undefined;
  }
  if (identity.credentials.type === 'token') {
    reply.code(403).send({ error: 'writes-disabled-in-token-mode' });
    return undefined;
  }
  return identity;
}

type Identity = NonNullable<Awaited<ReturnType<typeof authenticate>>>;

/** `true` when `identity` holds `privilege` on `path`; otherwise sends the 403/502 and returns `false`. */
async function requirePrivilege(
  app: FastifyInstance,
  reply: FastifyReply,
  identity: Identity,
  path: string,
  privilege: string,
): Promise<boolean> {
  let allowed: boolean;
  try {
    allowed = await hasPathPrivilege(identity.client, path, privilege);
  } catch (error) {
    if (sendPveError(reply, error)) return false;
    app.log.warn({ err: error }, 'Failed to check permissions for access change');
    reply.code(502).send({ error: 'pve-unreachable' });
    return false;
  }
  if (!allowed) {
    reply.code(403).send({ error: 'forbidden', missing: privilege });
    return false;
  }
  return true;
}

const flag = (value: boolean): 0 | 1 => (value ? 1 : 0);

export function registerAccessRoutes(
  app: FastifyInstance,
  guestActionsRateLimit: ReturnType<FastifyInstance['rateLimit']>,
): void {
  const BASE = '/api/actions/datacenter/access';

  /** Runs one PVE call, relaying PVE errors; `true` on success, `false` once a reply was sent. */
  async function relay(reply: FastifyReply, what: string, run: () => Promise<unknown>): Promise<boolean> {
    try {
      await run();
      return true;
    } catch (error) {
      if (sendPveError(reply, error)) return false;
      // The error object is logged, never the request body (it may hold a password).
      app.log.warn({ err: error }, `${what} request failed`);
      reply.code(502).send({ error: 'pve-unreachable' });
      return false;
    }
  }

  function parseUserid(reply: FastifyReply, raw: unknown): string | undefined {
    const parsed = useridSchema.safeParse(raw);
    if (!parsed.success) {
      reply.code(400).send({ error: 'Invalid userid' });
      return undefined;
    }
    return parsed.data;
  }

  // ---- users -----------------------------------------------------------------------------------

  app.post(`${BASE}/users`, { onRequest: guestActionsRateLimit }, async (req, reply) => {
    const parsed = createUserSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      reply.code(400).send({ error: 'Invalid request body' });
      return;
    }
    const body = parsed.data;
    const realm = body.userid.slice(body.userid.lastIndexOf('@') + 1);
    if (body.password !== undefined && realm !== 'pve') {
      reply.code(400).send({ error: 'password-only-for-pve-realm', message: 'Only users of the pve realm have a password.' });
      return;
    }

    const identity = await authenticate(app, req, reply);
    if (!identity) return;
    if (!(await requirePrivilege(app, reply, identity, `/access/realm/${realm}`, REALM_PRIVILEGE))) return;

    const params: Record<string, string | number> = { userid: body.userid };
    if (body.password !== undefined) params.password = body.password;
    if (body.enable !== undefined) params.enable = flag(body.enable);
    if (body.expire !== undefined) params.expire = body.expire;
    if (body.firstname !== undefined) params.firstname = body.firstname;
    if (body.lastname !== undefined) params.lastname = body.lastname;
    if (body.email !== undefined) params.email = body.email;
    if (body.groups !== undefined) params.groups = body.groups.join(',');
    if (body.comment !== undefined) params.comment = body.comment;

    if (!(await relay(reply, 'Access user create', () => identity.client.post('/access/users', params as never)))) return;
    app.log.info({ username: identity.username, userid: body.userid }, 'Access user created');
    reply.code(200).send({ ok: true, userid: body.userid });
  });

  app.put(`${BASE}/users/:userid`, { onRequest: guestActionsRateLimit }, async (req, reply) => {
    const userid = parseUserid(reply, (req.params as Record<string, string>).userid);
    if (userid === undefined) return;
    const parsed = updateUserSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      reply.code(400).send({ error: 'Invalid request body' });
      return;
    }
    const body = parsed.data;
    const fields = Object.keys(body).filter((k) => (body as Record<string, unknown>)[k] !== undefined);
    if (fields.length === 0) {
      reply.code(400).send({ error: 'no-changes', message: 'Nothing to change.' });
      return;
    }

    const identity = await authenticate(app, req, reply);
    if (!identity) return;
    if (!(await requirePrivilege(app, reply, identity, '/access', USERS_PRIVILEGE))) return;

    // PVE's user update has no `delete` list: an explicit `null` clears the field by sending it
    // empty (`expire=0` for "never expires", `groups=` for no groups).
    const params: Record<string, string | number> = { userid };
    if (body.enable !== undefined) params.enable = flag(body.enable);
    if (body.expire !== undefined) params.expire = body.expire ?? 0;
    if (body.firstname !== undefined) params.firstname = body.firstname ?? '';
    if (body.lastname !== undefined) params.lastname = body.lastname ?? '';
    if (body.email !== undefined) params.email = body.email ?? '';
    if (body.groups !== undefined) params.groups = (body.groups ?? []).join(',');
    if (body.comment !== undefined) params.comment = body.comment ?? '';

    if (!(await relay(reply, 'Access user update', () => identity.client.put('/access/users/{userid}', params as never)))) return;
    app.log.info({ username: identity.username, userid, fields }, 'Access user updated');
    reply.code(200).send({ ok: true });
  });

  app.delete(`${BASE}/users/:userid`, { onRequest: guestActionsRateLimit }, async (req, reply) => {
    const userid = parseUserid(reply, (req.params as Record<string, string>).userid);
    if (userid === undefined) return;

    const identity = await authenticate(app, req, reply);
    if (!identity) return;
    if (userid === 'root@pam') {
      reply.code(400).send({ error: 'cannot-delete-root', message: 'root@pam cannot be deleted.' });
      return;
    }
    if (userid === identity.username) {
      reply.code(400).send({ error: 'cannot-delete-self', message: 'You cannot delete the account you are signed in with.' });
      return;
    }
    if (!(await requirePrivilege(app, reply, identity, '/access', USERS_PRIVILEGE))) return;

    if (!(await relay(reply, 'Access user delete', () => identity.client.delete('/access/users/{userid}', { userid })))) return;
    app.log.info({ username: identity.username, userid }, 'Access user deleted');
    reply.code(200).send({ ok: true });
  });

  // ---- password --------------------------------------------------------------------------------

  app.put(`${BASE}/password`, { onRequest: guestActionsRateLimit }, async (req, reply) => {
    const parsed = passwordSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      reply.code(400).send({ error: 'Invalid request body' });
      return;
    }
    const body = parsed.data;

    const identity = await authenticate(app, req, reply);
    if (!identity) return;
    // PVE lets a user change their own password; anyone else's needs User.Modify on /access.
    if (body.userid !== identity.username) {
      if (!(await requirePrivilege(app, reply, identity, '/access', USERS_PRIVILEGE))) return;
    }

    const params: Record<string, string> = { userid: body.userid, password: body.password };
    if (body.confirmationPassword !== undefined) params['confirmation-password'] = body.confirmationPassword;

    if (!(await relay(reply, 'Access password change', () => identity.client.put('/access/password', params as never)))) return;
    // The userid only -- never the password(s).
    app.log.info({ username: identity.username, userid: body.userid }, 'Access password changed');
    reply.code(200).send({ ok: true });
  });

  // ---- groups ----------------------------------------------------------------------------------

  app.post(`${BASE}/groups`, { onRequest: guestActionsRateLimit }, async (req, reply) => {
    const parsed = createGroupSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      reply.code(400).send({ error: 'Invalid request body' });
      return;
    }
    const body = parsed.data;
    const identity = await authenticate(app, req, reply);
    if (!identity) return;
    if (!(await requirePrivilege(app, reply, identity, '/access/groups', GROUP_PRIVILEGE))) return;

    const params: Record<string, string> = { groupid: body.groupid };
    if (body.comment !== undefined) params.comment = body.comment;
    if (!(await relay(reply, 'Access group create', () => identity.client.post('/access/groups', params as never)))) return;
    app.log.info({ username: identity.username, groupid: body.groupid }, 'Access group created');
    reply.code(200).send({ ok: true, groupid: body.groupid });
  });

  app.put(`${BASE}/groups/:groupid`, { onRequest: guestActionsRateLimit }, async (req, reply) => {
    const groupid = groupidSchema.safeParse((req.params as Record<string, string>).groupid);
    if (!groupid.success) {
      reply.code(400).send({ error: 'Invalid groupid' });
      return;
    }
    const parsed = updateGroupSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      reply.code(400).send({ error: 'Invalid request body' });
      return;
    }
    const identity = await authenticate(app, req, reply);
    if (!identity) return;
    if (!(await requirePrivilege(app, reply, identity, '/access/groups', GROUP_PRIVILEGE))) return;

    const params = { groupid: groupid.data, comment: parsed.data.comment };
    if (!(await relay(reply, 'Access group update', () => identity.client.put('/access/groups/{groupid}', params)))) return;
    app.log.info({ username: identity.username, groupid: groupid.data }, 'Access group updated');
    reply.code(200).send({ ok: true });
  });

  app.delete(`${BASE}/groups/:groupid`, { onRequest: guestActionsRateLimit }, async (req, reply) => {
    const groupid = groupidSchema.safeParse((req.params as Record<string, string>).groupid);
    if (!groupid.success) {
      reply.code(400).send({ error: 'Invalid groupid' });
      return;
    }
    const identity = await authenticate(app, req, reply);
    if (!identity) return;
    if (!(await requirePrivilege(app, reply, identity, '/access/groups', GROUP_PRIVILEGE))) return;

    if (!(await relay(reply, 'Access group delete', () => identity.client.delete('/access/groups/{groupid}', { groupid: groupid.data })))) return;
    app.log.info({ username: identity.username, groupid: groupid.data }, 'Access group deleted');
    reply.code(200).send({ ok: true });
  });

  // ---- ACL -------------------------------------------------------------------------------------

  app.post(`${BASE}/acl`, { onRequest: guestActionsRateLimit }, async (req, reply) => {
    const parsed = aclSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      reply.code(400).send({ error: 'Invalid request body' });
      return;
    }
    const body = parsed.data;
    const identity = await authenticate(app, req, reply);
    if (!identity) return;
    if (!(await requirePrivilege(app, reply, identity, body.path, ACL_PRIVILEGE))) return;

    const params: Record<string, string | number> = {
      path: body.path,
      roles: body.roles.join(','),
      propagate: flag(body.propagate),
      delete: flag(body.remove),
    };
    if (body.users !== undefined) params.users = body.users.join(',');
    if (body.groups !== undefined) params.groups = body.groups.join(',');
    if (body.tokens !== undefined) params.tokens = body.tokens.join(',');

    if (!(await relay(reply, 'Access ACL change', () => identity.client.put('/access/acl', params as never)))) return;
    app.log.info(
      { username: identity.username, path: body.path, roles: body.roles, remove: body.remove },
      body.remove ? 'Access permission removed' : 'Access permission added',
    );
    reply.code(200).send({ ok: true });
  });

  // ---- API tokens ------------------------------------------------------------------------------

  /** Token calls on someone else's account need `User.Modify`; a caller's own tokens do not. */
  async function authorizeTokenCall(req: FastifyRequest, reply: FastifyReply, userid: string) {
    const identity = await authenticate(app, req, reply);
    if (!identity) return undefined;
    if (userid !== identity.username) {
      if (!(await requirePrivilege(app, reply, identity, '/access', USERS_PRIVILEGE))) return undefined;
    }
    return identity;
  }

  app.post(`${BASE}/users/:userid/tokens`, { onRequest: guestActionsRateLimit }, async (req, reply) => {
    const userid = parseUserid(reply, (req.params as Record<string, string>).userid);
    if (userid === undefined) return;
    const parsed = createTokenSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      reply.code(400).send({ error: 'Invalid request body' });
      return;
    }
    const body = parsed.data;
    const identity = await authorizeTokenCall(req, reply, userid);
    if (!identity) return;

    const params: Record<string, string | number> = { userid, tokenid: body.tokenid, privsep: flag(body.privsep) };
    if (body.comment !== undefined) params.comment = body.comment;
    if (body.expire !== undefined) params.expire = body.expire;

    let created: { 'full-tokenid': string; info?: unknown; value: string };
    try {
      created = await identity.client.post('/access/users/{userid}/token/{tokenid}', params as never);
    } catch (error) {
      if (sendPveError(reply, error)) return;
      app.log.warn({ err: error }, 'Access token create request failed');
      reply.code(502).send({ error: 'pve-unreachable' });
      return;
    }
    // The token id only: the secret in `created.value` is returned to the caller once, below.
    app.log.info({ username: identity.username, userid, tokenid: body.tokenid }, 'Access API token created');
    reply
      .code(200)
      .header('cache-control', 'no-store')
      .send({ ok: true, fullTokenid: created['full-tokenid'], value: created.value });
  });

  app.put(`${BASE}/users/:userid/tokens/:tokenid`, { onRequest: guestActionsRateLimit }, async (req, reply) => {
    const rawParams = req.params as Record<string, string>;
    const userid = parseUserid(reply, rawParams.userid);
    if (userid === undefined) return;
    const tokenid = z.string().regex(TOKENID_RE).safeParse(rawParams.tokenid);
    if (!tokenid.success) {
      reply.code(400).send({ error: 'Invalid tokenid' });
      return;
    }
    const parsed = updateTokenSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      reply.code(400).send({ error: 'Invalid request body' });
      return;
    }
    const body = parsed.data;
    if (Object.values(body).every((v) => v === undefined)) {
      reply.code(400).send({ error: 'no-changes', message: 'Nothing to change.' });
      return;
    }
    const identity = await authorizeTokenCall(req, reply, userid);
    if (!identity) return;

    const params: Record<string, string | number> = { userid, tokenid: tokenid.data };
    if (body.comment !== undefined) params.comment = body.comment;
    if (body.expire !== undefined) params.expire = body.expire;
    if (body.privsep !== undefined) params.privsep = flag(body.privsep);

    if (!(await relay(reply, 'Access token update', () => identity.client.put('/access/users/{userid}/token/{tokenid}', params as never)))) return;
    app.log.info({ username: identity.username, userid, tokenid: tokenid.data }, 'Access API token updated');
    reply.code(200).send({ ok: true });
  });

  app.delete(`${BASE}/users/:userid/tokens/:tokenid`, { onRequest: guestActionsRateLimit }, async (req, reply) => {
    const rawParams = req.params as Record<string, string>;
    const userid = parseUserid(reply, rawParams.userid);
    if (userid === undefined) return;
    const tokenid = z.string().regex(TOKENID_RE).safeParse(rawParams.tokenid);
    if (!tokenid.success) {
      reply.code(400).send({ error: 'Invalid tokenid' });
      return;
    }
    const identity = await authorizeTokenCall(req, reply, userid);
    if (!identity) return;

    if (
      !(await relay(reply, 'Access token delete', () =>
        identity.client.delete('/access/users/{userid}/token/{tokenid}', { userid, tokenid: tokenid.data }),
      ))
    )
      return;
    app.log.info({ username: identity.username, userid, tokenid: tokenid.data }, 'Access API token deleted');
    reply.code(200).send({ ok: true });
  });
}
