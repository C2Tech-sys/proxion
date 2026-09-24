import type { Agent } from 'undici';
import { PveClient, PveHttp, type Credentials } from '@proxion/pve-api';
import type { Config } from '../config.js';
import { dispatcherFetch } from './dispatcher.js';

/**
 * Builds a `PveClient` for one set of credentials, routed through the
 * shared, single dispatcher (see `dispatcher.ts`) rather than letting
 * `PveHttp` build its own connection pool. Callers cache the result (on a
 * session, or once for the service token) rather than calling this per
 * request.
 */
export function buildPveClient(
  config: Config,
  credentials: Credentials,
  dispatcher: Agent | undefined,
): PveClient {
  const http = new PveHttp({
    baseUrl: config.PVE_URL,
    credentials,
    fetch: dispatcherFetch(dispatcher),
  });
  return new PveClient(http);
}
