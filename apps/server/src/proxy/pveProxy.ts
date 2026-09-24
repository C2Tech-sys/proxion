import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Credentials } from '@proxion/pve-api';
import { dispatcherFetch } from '../pve/dispatcher.js';
import { resolveIdentity } from '../pve/identity.js';

/**
 * Gates write (non-GET) support for `/api/pve/*`. This raw proxy stays
 * read-only permanently -- every non-GET request is rejected with 405,
 * regardless of the caller's identity or permissions. Writes this app does
 * support go only through the small, allow-listed routes in `../actions/`
 * (guest power actions: start/stop/shutdown/reboot/reset/suspend/resume),
 * each with its own validation, permission check and error mapping -- never
 * through a generic pass-through of arbitrary PVE write endpoints.
 */
export const WRITE_ENABLED = false;

const HOP_BY_HOP_HEADERS = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'content-encoding',
  'content-length',
]);

function authHeaders(credentials: Credentials): Record<string, string> {
  if (credentials.type === 'token') {
    return { authorization: `PVEAPIToken=${credentials.tokenId}=${credentials.tokenSecret}` };
  }
  // Matches the stock UI: the ticket is stored (and sent back) URL-encoded; PVE URI-unescapes it.
  return { cookie: `PVEAuthCookie=${encodeURIComponent(credentials.ticket)}` };
}

const API2_JSON_PREFIX = '/api2/json/';

/** Everything after `/api/pve` in the request URL, including a leading `/` and any query string. */
function upstreamSuffix(req: FastifyRequest): string {
  const url = req.raw.url ?? req.url;
  const suffix = url.slice('/api/pve'.length);
  return suffix.length > 0 ? suffix : '/';
}

/**
 * Resolves `/api/pve/<suffix>` against `${PVE_URL}/api2/json/` and requires
 * the result to still be inside `/api2/json/` -- guards against `..`
 * segments (plain or percent-encoded -- the URL Standard normalizes both the
 * same way) or a protocol-relative (`//host/...`) suffix escaping onto a
 * different path, or host, on the PVE side. Returns `undefined` when the
 * suffix doesn't resolve to a safe `/api2/json/...` URL.
 */
export function buildUpstreamUrl(pveUrl: string, req: FastifyRequest): URL | undefined {
  const suffix = upstreamSuffix(req);
  // A `//`-prefixed relative reference is "network-path": resolving it against a
  // base would replace the *host*, not just the path. Reject outright.
  if (suffix.startsWith('//')) return undefined;

  let base: URL;
  let url: URL;
  try {
    base = new URL(pveUrl);
    // Strip the leading `/` so the suffix resolves *relative to* the `/api2/json/`
    // directory instead of relative to the origin (which a leading `/` would do).
    url = new URL(suffix.replace(/^\/+/, ''), `${pveUrl}${API2_JSON_PREFIX}`);
  } catch {
    return undefined;
  }

  if (url.origin !== base.origin) return undefined;
  if (url.pathname !== '/api2/json' && !url.pathname.startsWith(API2_JSON_PREFIX)) return undefined;
  return url;
}

export default async function pveProxyRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/pve/*', async (req, reply) => {
    const identity = await resolveIdentity(app, req);
    if (!identity) {
      reply.code(401).send({ error: 'Not authenticated' });
      return;
    }

    const url = buildUpstreamUrl(app.proxionConfig.PVE_URL, req);
    if (!url) {
      reply.code(400).send({ error: 'Invalid PVE API path' });
      return;
    }

    await forwardGet(app, url, reply, identity.credentials);
  });

  // WRITE_ENABLED gates real handling for a future phase; every non-GET call is rejected today.
  app.route({
    method: ['POST', 'PUT', 'DELETE', 'PATCH'],
    url: '/api/pve/*',
    handler: async (_req, reply) => {
      reply.code(405).send({ error: 'Read-only proxy: write methods are not enabled' });
    },
  });
}

async function forwardGet(
  app: FastifyInstance,
  url: URL,
  reply: FastifyReply,
  credentials: Credentials,
): Promise<void> {
  const fetchImpl = dispatcherFetch(app.pveDispatcher);

  let upstream;
  try {
    // Never forward the browser's own cookies (or any other inbound header) upstream --
    // headers are built fresh from the resolved PVE identity only.
    upstream = await fetchImpl(url, { method: 'GET', headers: authHeaders(credentials) });
  } catch (error) {
    app.log.warn({ err: error }, 'PVE proxy request failed');
    reply.code(502).send({ error: 'Failed to reach Proxmox VE' });
    return;
  }

  const body = await upstream.text();
  reply.code(upstream.status);
  for (const [key, value] of upstream.headers) {
    if (!HOP_BY_HOP_HEADERS.has(key.toLowerCase())) {
      reply.header(key, value);
    }
  }
  reply.send(body);
}
