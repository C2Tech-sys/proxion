import type { FastifyInstance, FastifyRequest } from 'fastify';
import { resolveIdentity } from '../pve/identity.js';
import { SESSION_COOKIE } from '../auth/session.js';
import { PREFS_DEFAULTS, type PrefsResponse } from './schema.js';

/** Buckets the write rate limit by session (the signed cookie value, raw -- it doesn't need to be
 *  unsigned to serve as a bucketing key) rather than by IP, so one browser's writes never eat
 *  into another signed-in user's quota behind the same NAT/proxy; falls back to the request IP
 *  for token mode (no session cookie at all -- effectively one shared bucket, matching that it's
 *  already one shared identity). */
function rateLimitKey(req: FastifyRequest): string {
  return (req.cookies as Record<string, string | undefined>)[SESSION_COOKIE] ?? req.ip;
}

const WRITE_RATE_LIMIT = { max: 20, timeWindow: '1 minute' } as const;

export default async function prefsRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/prefs', async (req, reply) => {
    const identity = await resolveIdentity(app, req);
    if (!identity) {
      reply.code(401).send({ error: 'Not authenticated' });
      return;
    }

    // A shared service token is not a person -- everyone in token mode would otherwise read
    // (and could write) the same one file. Read-only defaults instead; see the `PUT`/`PATCH`
    // handlers below for the write-side 403.
    if (identity.credentials.type === 'token') {
      const body: PrefsResponse = { ...PREFS_DEFAULTS, readOnly: true };
      reply.send(body);
      return;
    }

    const prefs = await app.prefsStore.get(identity.username, req.log);
    const body: PrefsResponse = { ...prefs, readOnly: false };
    reply.send(body);
  });

  app.put(
    '/api/prefs',
    { config: { rateLimit: { ...WRITE_RATE_LIMIT, keyGenerator: rateLimitKey } } },
    async (req, reply) => {
      const identity = await resolveIdentity(app, req);
      if (!identity) {
        reply.code(401).send({ error: 'Not authenticated' });
        return;
      }
      if (identity.credentials.type === 'token') {
        reply.code(403).send({ error: 'prefs-read-only-in-token-mode' });
        return;
      }

      const result = await app.prefsStore.replace(identity.username, req.body);
      if (!result.ok) {
        reply.code(400).send({ error: `Invalid preferences: ${result.message}` });
        return;
      }
      const body: PrefsResponse = { ...result.prefs, readOnly: false };
      reply.send(body);
    },
  );

  app.patch(
    '/api/prefs',
    { config: { rateLimit: { ...WRITE_RATE_LIMIT, keyGenerator: rateLimitKey } } },
    async (req, reply) => {
      const identity = await resolveIdentity(app, req);
      if (!identity) {
        reply.code(401).send({ error: 'Not authenticated' });
        return;
      }
      if (identity.credentials.type === 'token') {
        reply.code(403).send({ error: 'prefs-read-only-in-token-mode' });
        return;
      }

      const result = await app.prefsStore.merge(identity.username, req.body);
      if (!result.ok) {
        reply.code(400).send({ error: `Invalid preferences: ${result.message}` });
        return;
      }
      const body: PrefsResponse = { ...result.prefs, readOnly: false };
      reply.send(body);
    },
  );
}
