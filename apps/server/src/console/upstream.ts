import type * as https from 'node:https';
import WebSocket from 'ws';
import type { Credentials } from '@proxion/pve-api';
import type { Config } from '../config.js';

/** `Cookie`/`Authorization` header for an upstream PVE websocket, built fresh -- never the browser's own headers. */
function authHeaders(credentials: Credentials): Record<string, string> {
  if (credentials.type === 'token') {
    return { Authorization: `PVEAPIToken=${credentials.tokenId}=${credentials.tokenSecret}` };
  }
  // Matches the stock UI: the ticket is stored (and sent back) URL-encoded; PVE URI-unescapes it.
  return { Cookie: `PVEAuthCookie=${encodeURIComponent(credentials.ticket)}` };
}

function wsUrl(pveUrl: string, path: string, query: Record<string, string>): string {
  const httpUrl = new URL(pveUrl);
  const protocol = httpUrl.protocol === 'https:' ? 'wss:' : 'ws:';
  const search = new URLSearchParams(query).toString();
  return `${protocol}//${httpUrl.host}/api2/json${path}?${search}`;
}

/**
 * Opens an upstream websocket to a PVE `vncwebsocket` endpoint, with the
 * caller's credentials as headers and the same TLS policy as the HTTP
 * transport (the shared `wsAgent`, built once at boot -- see
 * `pve/dispatcher.ts`). `ws` cannot use an undici dispatcher, hence the
 * separate `https.Agent`.
 */
export function openUpstreamConsoleSocket(
  config: Config,
  wsAgent: https.Agent | undefined,
  credentials: Credentials,
  path: string,
  query: { port: number; vncticket: string },
): WebSocket {
  const url = wsUrl(config.PVE_URL, path, { port: String(query.port), vncticket: query.vncticket });
  return new WebSocket(url, ['binary'], {
    headers: authHeaders(credentials),
    ...(wsAgent ? { agent: wsAgent } : {}),
  });
}
