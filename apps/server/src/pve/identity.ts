import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Credentials, PveClient } from '@proxion/pve-api';
import { getSession } from '../auth/session.js';

/** The resolved PVE identity for one request: which client to call PVE with, and who it is (for logging/handshakes -- never the secret itself). */
export interface PveIdentity {
  client: PveClient;
  credentials: Credentials;
  /** `user@realm` for a session, or the token id for token mode. Safe to log. */
  username: string;
}

/**
 * The single place that decides *whose* PVE credentials a downstream call
 * uses: the caller's session ticket if they're logged in, otherwise the
 * shared service token if token mode is enabled and configured. Returns
 * `undefined` when neither applies (caller should respond 401).
 */
export async function resolveIdentity(
  app: FastifyInstance,
  req: FastifyRequest,
): Promise<PveIdentity | undefined> {
  const session = await getSession(app, req);
  if (session) {
    return {
      client: session.pveClient,
      credentials: { type: 'ticket', ticket: session.ticket, csrfToken: session.csrfToken },
      username: session.username,
    };
  }

  const config = app.proxionConfig;
  if (
    config.PROXION_ALLOW_TOKEN_MODE &&
    app.proxionTokenClient &&
    config.PVE_TOKEN_ID &&
    config.PVE_TOKEN_SECRET
  ) {
    return {
      client: app.proxionTokenClient,
      credentials: {
        type: 'token',
        tokenId: config.PVE_TOKEN_ID,
        tokenSecret: config.PVE_TOKEN_SECRET,
      },
      username: config.PVE_TOKEN_ID,
    };
  }

  return undefined;
}
