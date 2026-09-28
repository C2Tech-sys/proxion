import type { Agent } from 'undici';
import { PveClient, PveHttp, type Credentials } from '@proxion/pve-api';
import type { Config } from '../config.js';

/**
 * Builds a `PveClient` for one set of credentials, routed through the
 * shared, single dispatcher (see `dispatcher.ts`) rather than letting
 * `PveHttp` build its own connection pool. Callers cache the result (on a
 * session, or once for the service token) rather than calling this per
 * request.
 *
 * Passed as `dispatcher` (`PveHttpOptions.dispatcher`) -- `PveHttp`'s own first-class way to share
 * one already-built dispatcher across many instances -- and NOT wrapped into a custom `fetch`
 * (T34: a previous version of this function did `fetch: dispatcherFetch(dispatcher)` instead).
 * That looked equivalent for `PveClient.get/post/put/delete`, which all go through `PveHttp`'s own
 * `fetch`-based `request()` -- but `PveHttp.stream()` (used for storage uploads) bypasses `fetch()`
 * entirely for its own reasons (per-call timeouts; see `http.ts`) and resolves its dispatcher from
 * `this.dispatcher` directly, which a dispatcher hidden inside a custom `fetch` closure is
 * invisible to. With no `tls`/`dispatcher` option, `PveHttp` had nothing to give `stream()`, so it
 * silently fell back to undici's global dispatcher -- default certificate verification, which
 * fails outright against Proxmox's self-signed certificate. Every real upload 502'd instantly
 * (`unable to verify the first certificate`), never even reaching PVE. Passing `dispatcher`
 * directly fixes both paths at once, since it's the exact value `stream()` already knows to use.
 */
export function buildPveClient(
  config: Config,
  credentials: Credentials,
  dispatcher: Agent | undefined,
): PveClient {
  const http = new PveHttp({
    baseUrl: config.PVE_URL,
    credentials,
    ...(dispatcher ? { dispatcher } : {}),
  });
  return new PveClient(http);
}
