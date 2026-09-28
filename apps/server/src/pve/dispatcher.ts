import { fetch as undiciFetch, type Agent, type RequestInit } from 'undici';
import { createTlsAgent, createPinnedHttpsAgent, type PveTlsOptions } from '@proxion/pve-api';
import * as https from 'node:https';
import type { Config } from '../config.js';

/** Derive `@proxion/pve-api`'s `PveTlsOptions` from our env-driven config. */
export function tlsOptionsFromConfig(config: Config): PveTlsOptions | undefined {
  if (config.PVE_TLS_FINGERPRINT) return { fingerprint: config.PVE_TLS_FINGERPRINT };
  if (config.PVE_TLS_INSECURE) return { insecure: true };
  return undefined;
}

/**
 * Builds the single undici `Agent` (connection pool + TLS policy) shared by
 * every `PveHttp` instance for the lifetime of the process.
 *
 * `PveHttp` (as vendored at cf7aca4) builds its own private `Agent` per
 * instance whenever `tls` options are passed, and has no `close()` -- so a
 * naive `pveForRequest()` that constructs a fresh `PveHttp` per request (or
 * per credential) would leak one connection pool per call. Instead, this is
 * called exactly once at boot; every `PveHttp` is then built with this same
 * `Agent` passed as its own `dispatcher` option (`buildPveClient`, in
 * `client.ts`), so it never builds one of its own. (T34: this used to be
 * injected via a custom `fetch` instead -- see `dispatcherFetch`'s own doc
 * comment for why that broke `PveHttp.stream()`, used by storage uploads,
 * even though `dispatcherFetch` itself is still exactly right for the two
 * plain-`fetch()` callers below, `ticketClient.ts` and `pveProxy.ts`, which
 * never go through `PveHttp` at all.)
 */
export function createPveDispatcher(config: Config): Agent | undefined {
  return createTlsAgent(tlsOptionsFromConfig(config));
}

/**
 * A plain `fetch` that always routes through the given shared dispatcher -- for callers that make
 * their own `fetch()` calls directly (`ticketClient.ts`'s login round-trip, `pveProxy.ts`'s
 * pass-through proxy), never for building a `PveHttp` (see `client.ts`'s `buildPveClient`, which
 * passes the same dispatcher via `PveHttpOptions.dispatcher` instead -- T34: `PveHttp.stream()`
 * bypasses `fetch` entirely and cannot see a dispatcher hidden inside one of these).
 */
export function dispatcherFetch(dispatcher: Agent | undefined): typeof undiciFetch {
  return ((url: string | URL, init: RequestInit = {}) =>
    undiciFetch(url, { ...init, ...(dispatcher ? { dispatcher } : {}) })) as typeof undiciFetch;
}

/**
 * The single `https.Agent` shared by every upstream `ws` client (VNC/term
 * bridges), built once at boot from the same TLS policy as the HTTP
 * transport. `ws` cannot use an undici dispatcher (it drives its own
 * `node:https`/`node:tls`), so this is a separate agent from
 * `createPveDispatcher`, but follows the same "build once, reuse" rule.
 */
export function createPveWsAgent(config: Config): https.Agent | undefined {
  if (config.PVE_TLS_FINGERPRINT) return createPinnedHttpsAgent(config.PVE_TLS_FINGERPRINT);
  if (config.PVE_TLS_INSECURE) return new https.Agent({ rejectUnauthorized: false });
  return undefined;
}
