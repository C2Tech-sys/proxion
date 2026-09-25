import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import { PveApiError } from '@proxion/pve-api';
import { resolveIdentity } from '../pve/identity.js';
import { hasNodePrivilege, sanitizeMessage } from './shared.js';

/**
 * A PVE node name: `[A-Za-z0-9]`, optionally with inner `-` (never leading/trailing), 1-63
 * characters -- same shape/rationale as `NODE_NAME_RE` in `migrateRoutes.ts` (kept local rather
 * than shared, since `:node` here is a routed path segment fastify already constrains no further
 * than a generic string, so this route still validates it explicitly before it goes into a PVE
 * API call).
 */
const NODE_NAME_RE = /^[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?$/;
const nodeNameSchema = z.string().min(1).max(63).regex(NODE_NAME_RE);

const commandSchema = z.enum(['reboot', 'shutdown']);

// `.strict()` + optional/empty body: an unknown key is a 400, same rationale as every other
// guest-action body schema in this app (see `shared.ts`'s doc comment, `routes.ts`,
// `migrateRoutes.ts`). This route takes no body fields at all today.
const nodeActionBodySchema = z.object({}).strict();

/** Maps a PVE call failure to the same `502`/`4xx` response shape every guest-action route uses
 * (mirrors `migrateRoutes.ts`'s own `sendPveError`); returns `true` iff it sent a reply. */
function sendPveError(reply: FastifyReply, error: unknown): boolean {
  if (error instanceof PveApiError) {
    if (error.status >= 500) {
      reply.code(502).send({ error: 'pve-unreachable' });
    } else {
      reply.code(error.status).send({ error: 'pve-rejected', message: sanitizeMessage(error.message) });
    }
    return true;
  }
  return false;
}

/**
 * Node power actions (reboot/shutdown) -- one more allow-listed write this server performs
 * against PVE, registered from `actionsRoutes` (`routes.ts`) so it shares its rate limiter, same
 * convention as `registerSnapshotRoutes`/`registerMigrateRoutes`. `POST /nodes/{node}/status`
 * returns nothing useful on success (see the generated endpoint table) -- unlike guest actions,
 * there is no UPID to report, so this responds `202 { ok: true }` directly.
 */
export function registerNodeRoutes(
  app: FastifyInstance,
  guestActionsRateLimit: ReturnType<FastifyInstance['rateLimit']>,
): void {
  app.post(
    '/api/actions/node/:node/:command',
    { onRequest: guestActionsRateLimit },
    async (req, reply) => {
      const params = req.params as Record<string, string>;
      const node = nodeNameSchema.safeParse(params.node);
      const command = commandSchema.safeParse(params.command);

      if (!node.success || !command.success) {
        reply.code(400).send({ error: 'Invalid node/command' });
        return;
      }

      const body = nodeActionBodySchema.safeParse(req.body ?? {});
      if (!body.success) {
        reply.code(400).send({ error: 'Invalid request body' });
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

      let allowed: boolean;
      try {
        allowed = await hasNodePrivilege(identity.client, node.data, 'Sys.PowerMgmt');
      } catch (error) {
        app.log.warn({ err: error }, 'Failed to check Sys.PowerMgmt permission for node action');
        reply.code(502).send({ error: 'pve-unreachable' });
        return;
      }
      if (!allowed) {
        reply.code(403).send({ error: 'forbidden', missing: 'Sys.PowerMgmt' });
        return;
      }

      try {
        await identity.client.post('/nodes/{node}/status', { node: node.data, command: command.data });
      } catch (error) {
        if (sendPveError(reply, error)) return;
        app.log.warn({ err: error }, 'Node action request failed');
        reply.code(502).send({ error: 'pve-unreachable' });
        return;
      }

      app.log.info(
        { username: identity.username, node: node.data, command: command.data },
        'Node action executed',
      );
      reply.code(202).send({ ok: true });
    },
  );
}
