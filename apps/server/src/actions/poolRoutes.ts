import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { PveApiError, type PveClient } from '@proxion/pve-api';
import { resolveIdentity } from '../pve/identity.js';
import { formatPveErrorMessage, sanitizeMessage } from './shared.js';

/**
 * Datacenter -> Pools (T70): create a pool, change its comment, add or remove members (guests and
 * storages) and delete it. Three allow-listed calls this server performs against PVE
 * (`POST /pools`, `PUT /pools/{poolid}`, `DELETE /pools/{poolid}`), registered from `actionsRoutes`
 * (`routes.ts`) so they share its rate limiter. Reads (the pool list and a pool's members) go
 * through the read-only `/api/pve/*` proxy.
 *
 * Privilege: `Pool.Allocate` on `/pool` to create, on `/pool/<id>` to edit or delete. PVE
 * additionally checks the rights on each guest/storage being added or removed; its error is relayed.
 */

const POOL_PRIVILEGE = 'Pool.Allocate';

const POOL_ID_RE = /^[A-Za-z0-9._-]{1,64}$/;
const STORAGE_NAME_RE = /^[A-Za-z][A-Za-z0-9._-]{0,63}$/;

// A single line; PVE stores it as-is. Control characters (newlines included) are rejected.
// eslint-disable-next-line no-control-regex
const SINGLE_LINE_RE = /^[^\x00-\x1f\x7f]*$/;
const commentSchema = z.string().max(255).regex(SINGLE_LINE_RE);

const createBodySchema = z
  .object({
    poolid: z.string().regex(POOL_ID_RE),
    comment: commentSchema.optional(),
  })
  .strict();

const updateBodySchema = z
  .object({
    comment: commentSchema.optional(),
    vms: z.array(z.number().int().min(100).max(999_999_999)).min(1).max(1000).optional(),
    storage: z.array(z.string().regex(STORAGE_NAME_RE)).min(1).max(256).optional(),
    /** Remove the listed `vms`/`storage` from the pool instead of adding them. */
    remove: z.boolean().optional(),
    /** Add guests that already belong to another pool (moves them). Only meaningful when adding. */
    'allow-move': z.boolean().optional(),
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

/** Whether the caller's own credentials hold `privilege` on an ACL `path` (`/pool`, `/pool/<id>`),
 * via `GET /access/permissions?path=`. Real PVE nests the result under the requested path; falls
 * back to a flat map. Local to this file. */
async function hasPathPrivilege(client: PveClient, path: string, privilege: string): Promise<boolean> {
  const perms = (await client.get('/access/permissions', { path })) as Record<string, unknown>;
  const scoped = (perms[path] as Record<string, unknown> | undefined) ?? perms;
  return Boolean(scoped[privilege]);
}

/** The shared session/token/privilege gate. Sends the failure reply itself and returns
 * `undefined`; otherwise returns the caller's identity. */
async function authorize(app: FastifyInstance, req: FastifyRequest, reply: FastifyReply, aclPath: string) {
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
    allowed = await hasPathPrivilege(identity.client, aclPath, POOL_PRIVILEGE);
  } catch (error) {
    if (sendPveError(reply, error)) return undefined;
    app.log.warn({ err: error }, 'Failed to check permissions for pool management');
    reply.code(502).send({ error: 'pve-unreachable' });
    return undefined;
  }
  if (!allowed) {
    reply.code(403).send({ error: 'forbidden', missing: POOL_PRIVILEGE });
    return undefined;
  }
  return identity;
}

export function registerPoolRoutes(
  app: FastifyInstance,
  guestActionsRateLimit: ReturnType<FastifyInstance['rateLimit']>,
): void {
  app.post('/api/actions/datacenter/pools', { onRequest: guestActionsRateLimit }, async (req, reply) => {
    const parsed = createBodySchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      reply.code(400).send({ error: 'Invalid request body' });
      return;
    }
    const body = parsed.data;

    const identity = await authorize(app, req, reply, '/pool');
    if (!identity) return;

    try {
      await identity.client.post('/pools', {
        poolid: body.poolid,
        ...(body.comment !== undefined && body.comment !== '' ? { comment: body.comment } : {}),
      });
    } catch (error) {
      if (sendPveError(reply, error)) return;
      app.log.warn({ err: error }, 'Pool create request failed');
      reply.code(502).send({ error: 'pve-unreachable' });
      return;
    }

    app.log.info({ username: identity.username, poolid: body.poolid }, 'Pool created');
    reply.code(200).send({ ok: true, poolid: body.poolid });
  });

  app.put('/api/actions/datacenter/pools/:poolid', { onRequest: guestActionsRateLimit }, async (req, reply) => {
    const poolid = (req.params as Record<string, string>).poolid ?? '';
    if (!POOL_ID_RE.test(poolid)) {
      reply.code(400).send({ error: 'Invalid pool id' });
      return;
    }
    const parsed = updateBodySchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      reply.code(400).send({ error: 'Invalid request body' });
      return;
    }
    const body = parsed.data;
    const hasMembers = body.vms !== undefined || body.storage !== undefined;
    if (body.comment === undefined && !hasMembers) {
      reply.code(400).send({ error: 'Invalid request body', message: 'Nothing to change' });
      return;
    }
    if ((body.remove !== undefined || body['allow-move'] !== undefined) && !hasMembers) {
      reply.code(400).send({ error: 'Invalid request body', message: 'remove/allow-move need vms or storage' });
      return;
    }
    if (body.remove === true && body['allow-move'] === true) {
      reply.code(400).send({ error: 'Invalid request body', message: 'allow-move only applies when adding members' });
      return;
    }

    const identity = await authorize(app, req, reply, `/pool/${poolid}`);
    if (!identity) return;

    const form: Record<string, string | number | boolean> = { poolid };
    if (body.comment !== undefined) form.comment = body.comment;
    if (body.vms !== undefined) form.vms = body.vms.join(',');
    if (body.storage !== undefined) form.storage = body.storage.join(',');
    if (body.remove === true) form.delete = true;
    if (body['allow-move'] === true) form['allow-move'] = true;

    try {
      await identity.client.put('/pools/{poolid}', form as never);
    } catch (error) {
      if (sendPveError(reply, error)) return;
      app.log.warn({ err: error }, 'Pool update request failed');
      reply.code(502).send({ error: 'pve-unreachable' });
      return;
    }

    app.log.info(
      {
        username: identity.username,
        poolid,
        comment: body.comment !== undefined,
        vms: body.vms?.length ?? 0,
        storage: body.storage?.length ?? 0,
        remove: body.remove === true,
      },
      'Pool updated',
    );
    reply.code(200).send({ ok: true, poolid });
  });

  app.delete('/api/actions/datacenter/pools/:poolid', { onRequest: guestActionsRateLimit }, async (req, reply) => {
    const poolid = (req.params as Record<string, string>).poolid ?? '';
    if (!POOL_ID_RE.test(poolid)) {
      reply.code(400).send({ error: 'Invalid pool id' });
      return;
    }

    const identity = await authorize(app, req, reply, `/pool/${poolid}`);
    if (!identity) return;

    try {
      // PVE refuses a pool that still has members; its error is relayed as-is.
      await identity.client.delete('/pools/{poolid}', { poolid });
    } catch (error) {
      if (sendPveError(reply, error)) return;
      app.log.warn({ err: error }, 'Pool delete request failed');
      reply.code(502).send({ error: 'pve-unreachable' });
      return;
    }

    app.log.info({ username: identity.username, poolid }, 'Pool deleted');
    reply.code(200).send({ ok: true });
  });
}
