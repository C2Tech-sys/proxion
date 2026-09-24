import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { SessionData } from './sessionStore.js';
import { renewTicket, TicketAuthError } from './ticketClient.js';
import { buildPveClient } from '../pve/client.js';

export const SESSION_COOKIE = 'proxion.sid';
const ONE_HOUR_MS = 60 * 60 * 1000;

function cookieOptions(app: FastifyInstance) {
  return {
    signed: true,
    httpOnly: true,
    sameSite: 'lax' as const,
    secure: app.proxionConfig.PROXION_COOKIE_SECURE,
    path: '/',
  };
}

export function setSessionCookie(app: FastifyInstance, reply: FastifyReply, sid: string): void {
  reply.cookie(SESSION_COOKIE, sid, cookieOptions(app));
}

export function clearSessionCookie(app: FastifyInstance, reply: FastifyReply): void {
  reply.clearCookie(SESSION_COOKIE, { path: '/' });
}

function readSid(req: FastifyRequest): string | undefined {
  const raw = req.cookies[SESSION_COOKIE];
  if (!raw) return undefined;
  const unsigned = req.unsignCookie(raw);
  if (!unsigned.valid || !unsigned.value) return undefined;
  return unsigned.value;
}

/**
 * Resolves the caller's session from the signed `proxion.sid` cookie,
 * transparently renewing the PVE ticket when the session is older than an
 * hour. Returns `undefined` when there is no session or the cookie is
 * invalid.
 *
 * Renewal failure is split by cause: PVE actually rejecting the ticket
 * (`TicketAuthError`) logs the session out, since it is genuinely no longer
 * valid. A transport failure (PVE unreachable, TLS error, 5xx, timeout) does
 * *not* log the user out -- the session and its (still unexpired, just not
 * yet re-issued) ticket are kept as-is, so the same renewal is simply
 * retried on the next request.
 */
export async function getSession(
  app: FastifyInstance,
  req: FastifyRequest,
): Promise<SessionData | undefined> {
  const sid = readSid(req);
  if (!sid) return undefined;

  const session = app.sessionStore.get(sid);
  if (!session) return undefined;

  if (Date.now() - session.lastRenewedAt < ONE_HOUR_MS) {
    return session;
  }

  try {
    const renewed = await renewTicket(app.proxionConfig, app.pveDispatcher, {
      username: session.username,
      ticket: session.ticket,
    });
    const updated: SessionData = {
      ...session,
      ticket: renewed.ticket,
      csrfToken: renewed.csrfToken,
      capabilities: renewed.capabilities,
      pveClient: buildPveClient(
        app.proxionConfig,
        { type: 'ticket', ticket: renewed.ticket, csrfToken: renewed.csrfToken },
        app.pveDispatcher,
      ),
      lastRenewedAt: Date.now(),
    };
    app.sessionStore.set(sid, updated);
    return updated;
  } catch (error) {
    if (error instanceof TicketAuthError) {
      app.sessionStore.delete(sid);
      app.log.warn({ err: error }, 'PVE ticket renewal rejected; session logged out');
      return undefined;
    }

    // Transport failure: keep the session (lastRenewedAt is untouched, so the
    // next request retries renewal) and log the cause, never the ticket/password.
    app.log.warn({ err: error }, 'PVE ticket renewal failed (transport); session kept, will retry');
    return session;
  }
}
