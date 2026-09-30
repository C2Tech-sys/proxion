import type { FastifyInstance, FastifyRequest } from 'fastify';
import { resolveIdentity } from '../pve/identity.js';
import { SESSION_COOKIE } from '../auth/session.js';

/** Same bucketing rationale as `prefsRoutes.ts`'s own `rateLimitKey`: per-session (not per-IP),
 *  so one browser's test clicks never eat into another signed-in user's quota. */
function rateLimitKey(req: FastifyRequest): string {
  return (req.cookies as Record<string, string | undefined>)[SESSION_COOKIE] ?? req.ip;
}

const TEST_RATE_LIMIT = { max: 5, timeWindow: '1 minute' } as const;

export interface NotifyStatusResponse {
  configured: { webhook: boolean; email: boolean };
  minSeverity: 'warning' | 'error';
  includeResolved: boolean;
}

/**
 * `GET /api/notify/status` (any authenticated identity, including token mode -- no secrets in
 * the response, just which channels exist) and `POST /api/notify/test` (session only; a service
 * token is a shared, unattended identity, same rationale as every other write route's
 * `writes-disabled-in-token-mode`). `app.notifier` is only decorated when at least one channel is
 * configured (see `app.ts`), so `not-configured` here is simply "no notifier at all".
 */
export default async function notifyRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/notify/status', async (req, reply) => {
    const identity = await resolveIdentity(app, req);
    if (!identity) {
      reply.code(401).send({ error: 'Not authenticated' });
      return;
    }

    const config = app.proxionConfig;
    const body: NotifyStatusResponse = {
      configured: {
        webhook: Boolean(config.PROXION_NOTIFY_WEBHOOK_URL),
        email: Boolean(config.PROXION_NOTIFY_SMTP_URL),
      },
      minSeverity: config.PROXION_NOTIFY_MIN_SEVERITY,
      includeResolved: config.PROXION_NOTIFY_INCLUDE_RESOLVED,
    };
    reply.send(body);
  });

  app.post(
    '/api/notify/test',
    { config: { rateLimit: { ...TEST_RATE_LIMIT, keyGenerator: rateLimitKey } } },
    async (req, reply) => {
      const identity = await resolveIdentity(app, req);
      if (!identity) {
        reply.code(401).send({ error: 'Not authenticated' });
        return;
      }
      if (identity.credentials.type === 'token') {
        reply.code(403).send({ error: 'writes-disabled-in-token-mode' });
        return;
      }
      if (!app.notifier) {
        reply.code(400).send({ error: 'not-configured' });
        return;
      }

      const results = await app.notifier.sendTest();
      reply.send({ results });
    },
  );
}
