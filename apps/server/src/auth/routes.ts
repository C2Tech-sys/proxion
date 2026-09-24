import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requestTicket, TicketAuthError, TicketTransportError } from './ticketClient.js';
import { buildPveClient } from '../pve/client.js';
import { getSession, setSessionCookie, clearSessionCookie, SESSION_COOKIE } from './session.js';

const loginBodySchema = z.object({
  username: z.string().min(1),
  password: z.string().min(1),
  realm: z.string().min(1).optional(),
});

function fullUsername(
  username: string,
  realm: string | undefined,
): { full: string; realm: string } {
  if (username.includes('@')) {
    const parts = username.split('@');
    return { full: username, realm: parts[1] ?? realm ?? 'pam' };
  }
  const resolvedRealm = realm ?? 'pam';
  return { full: `${username}@${resolvedRealm}`, realm: resolvedRealm };
}

export default async function authRoutes(app: FastifyInstance): Promise<void> {
  app.post(
    '/api/auth/login',
    { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } },
    async (req, reply) => {
      const body = loginBodySchema.safeParse(req.body);
      if (!body.success) {
        reply.code(400).send({ error: 'Invalid login request' });
        return;
      }

      const { full, realm } = fullUsername(body.data.username, body.data.realm);

      let result;
      try {
        result = await requestTicket(app.proxionConfig, app.pveDispatcher, {
          username: full,
          password: body.data.password,
        });
      } catch (error) {
        if (error instanceof TicketAuthError) {
          reply.code(401).send({ error: 'Invalid credentials' });
          return;
        }
        if (error instanceof TicketTransportError) {
          req.log.warn({ err: error }, 'Proxmox VE unreachable during login');
          reply.code(502).send({ error: 'Proxmox VE unreachable' });
          return;
        }
        throw error;
      }

      const pveClient = buildPveClient(
        app.proxionConfig,
        { type: 'ticket', ticket: result.ticket, csrfToken: result.csrfToken },
        app.pveDispatcher,
      );

      const now = Date.now();
      const session = app.sessionStore.create({
        username: result.username,
        realm,
        ticket: result.ticket,
        csrfToken: result.csrfToken,
        capabilities: result.capabilities,
        pveClient,
        createdAt: now,
        lastRenewedAt: now,
      });

      setSessionCookie(app, reply, session.sid);
      reply.send({
        username: session.username,
        realm: session.realm,
        capabilities: session.capabilities,
      });
    },
  );

  app.get('/api/auth/me', async (req, reply) => {
    const session = await getSession(app, req);
    if (session) {
      reply.send({
        username: session.username,
        realm: session.realm,
        capabilities: session.capabilities,
        mode: 'session',
      });
      return;
    }

    // No session: in token mode, with a service token actually configured, the caller is
    // implicitly that token's identity (see `src/pve/identity.ts`'s `resolveIdentity`, the same
    // rule `/api/pve/*` and the console-start endpoints use). Mirrored here so the web client can
    // tell "signed in via the shared token" apart from "not authenticated at all" without having
    // to infer it from a `/api/pve/*` call succeeding.
    const config = app.proxionConfig;
    if (config.PROXION_ALLOW_TOKEN_MODE && config.PVE_TOKEN_ID && config.PVE_TOKEN_SECRET) {
      reply.send({
        username: config.PVE_TOKEN_ID,
        realm: 'token',
        capabilities: {},
        mode: 'token',
      });
      return;
    }

    reply.code(401).send({ error: 'Not authenticated' });
  });

  app.post('/api/auth/logout', async (req, reply) => {
    const raw = req.cookies[SESSION_COOKIE];
    if (raw) {
      const unsigned = req.unsignCookie(raw);
      if (unsigned.valid && unsigned.value) {
        app.sessionStore.delete(unsigned.value);
      }
    }
    clearSessionCookie(app, reply);
    reply.send({ ok: true });
  });
}
