import { Headers, fetch as undiciFetch, type Dispatcher, type RequestInit, type Response } from 'undici';
import { PveApiError, PveTlsError } from './errors.js';
import { createTlsAgent, type PveTlsOptions } from './tls.js';

/**
 * How this client authenticates to the Proxmox VE API.
 *
 * `token` is fully implemented today (API tokens, sent as an `Authorization:
 * PVEAPIToken=...` header). `ticket` is a typed stub so a server-side
 * pass-through login flow can be added later without changing this
 * interface's shape.
 */
export type Credentials =
  | { readonly type: 'token'; readonly tokenId: string; readonly tokenSecret: string }
  | { readonly type: 'ticket'; readonly ticket: string; readonly csrfToken: string };

export type PveParams = Record<string, unknown>;

export interface PveHttpOptions {
  /** e.g. `https://pve.example.com:8006` (no trailing slash, no `/api2/json`). */
  baseUrl: string;
  credentials: Credentials;
  /**
   * TLS behavior for a dispatcher this `PveHttp` instance builds and owns
   * itself (see `createTlsAgent`). Mutually exclusive with `dispatcher` --
   * passing both throws.
   */
  tls?: PveTlsOptions;
  /**
   * Use an already-built undici `Dispatcher` instead of having this instance
   * create its own. Intended for a server holding many `PveHttp` instances
   * against the same PVE host: build one dispatcher per host (e.g. via
   * `createTlsAgent`) and share it, rather than opening a new `Agent` (and
   * its own connection pool) per credential set / `PveHttp` instance. When
   * set, `tls` is ignored -- and must not also be given. `close()` never
   * closes a `dispatcher` passed in this way; only one this instance built
   * itself from `tls` is closed.
   */
  dispatcher?: Dispatcher;
  /** Override the fetch implementation (used in tests). Defaults to undici's own `fetch`. */
  fetch?: typeof undiciFetch;
}

interface PveEnvelope {
  data?: unknown;
  errors?: Record<string, string>;
  message?: string;
}

const METHODS_WITH_BODY = new Set(['POST', 'PUT']);
// PVE path params aren't always identifier-shaped: `{route-map-id}`,
// `{pci-id-or-mapping}`, etc. Match anything between braces, not just
// `\w+`, so hyphenated params are actually substituted instead of leaking
// literal `{route-map-id}` into the URL with the value dropped to the query
// string.
const PATH_PARAM_RE = /\{([^}]+)\}/g;

function serializeScalar(value: unknown): string {
  if (typeof value === 'boolean') return value ? '1' : '0';
  return String(value);
}

/** PVE's `-list` convention: comma-joined values. */
function serializeQueryValue(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (Array.isArray(value)) return value.map(serializeScalar).join(',');
  return serializeScalar(value);
}

function substitutePathParams(pathTemplate: string, params: PveParams): { path: string; consumed: Set<string> } {
  const consumed = new Set<string>();
  const path = pathTemplate.replace(PATH_PARAM_RE, (_match, name: string) => {
    if (!(name in params) || params[name] === undefined || params[name] === null) {
      throw new Error(`Missing required path parameter "${name}" for ${pathTemplate}`);
    }
    consumed.add(name);
    return encodeURIComponent(serializeScalar(params[name]));
  });
  return { path, consumed };
}

/**
 * Low-level transport for the Proxmox VE REST API: builds requests (path
 * substitution, query/body serialization, auth header), unwraps the `{data:
 * ...}` envelope, and raises `PveApiError` on non-2xx responses.
 *
 * Uses `undici`'s own `fetch`/`Headers`/`Agent` throughout (rather than
 * Node's ambient global `fetch`, which is backed by a *different* internal
 * copy of undici). Mixing the two -- e.g. passing an `Agent` built from the
 * `undici` package as the `dispatcher` for the global `fetch` -- fails at
 * runtime (`InvalidArgumentError: invalid onRequestStart method`) because
 * their internal diagnostics/interceptor plumbing isn't cross-compatible,
 * even though their public types are close enough that TypeScript alone
 * won't catch the mismatch.
 */
export class PveHttp {
  private readonly baseUrl: string;
  private readonly credentials: Credentials;
  private readonly dispatcher: Dispatcher | undefined;
  /** Whether `this.dispatcher` was built by this instance (from `tls`) and so is ours to close. */
  private readonly ownsDispatcher: boolean;
  private readonly fetchImpl: typeof undiciFetch;

  constructor(options: PveHttpOptions) {
    if (options.dispatcher && options.tls) {
      throw new Error('PveHttp: specify either `dispatcher` or `tls`, not both');
    }

    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.credentials = options.credentials;

    if (options.dispatcher) {
      this.dispatcher = options.dispatcher;
      this.ownsDispatcher = false;
    } else {
      this.dispatcher = createTlsAgent(options.tls);
      this.ownsDispatcher = this.dispatcher !== undefined;
    }

    this.fetchImpl = options.fetch ?? undiciFetch;
  }

  /**
   * Close the dispatcher this instance built itself from `tls` options, if
   * any. A `dispatcher` passed in explicitly is the caller's to close (it
   * may be shared across other `PveHttp` instances) and is never touched
   * here. Safe to call when there's nothing to close.
   */
  async close(): Promise<void> {
    if (this.ownsDispatcher && this.dispatcher) {
      await this.dispatcher.close();
    }
  }

  async request<T = unknown>(
    method: string,
    pathTemplate: string,
    params: PveParams = {},
    init: RequestInit = {},
  ): Promise<T> {
    const httpMethod = method.toUpperCase();
    const { path: resolvedPath, consumed } = substitutePathParams(pathTemplate, params);

    const remaining: Array<[string, string]> = [];
    for (const [key, value] of Object.entries(params)) {
      if (consumed.has(key)) continue;
      const serialized = serializeQueryValue(value);
      if (serialized === undefined) continue;
      remaining.push([key, serialized]);
    }

    let url = `${this.baseUrl}/api2/json${resolvedPath}`;
    let body: string | undefined;
    const headers = new Headers(init.headers);
    this.applyAuth(headers);

    if (METHODS_WITH_BODY.has(httpMethod)) {
      if (remaining.length > 0) {
        body = new URLSearchParams(remaining).toString();
        headers.set('content-type', 'application/x-www-form-urlencoded');
      }
    } else if (remaining.length > 0) {
      url = `${url}?${new URLSearchParams(remaining).toString()}`;
    }

    const requestInit: RequestInit = {
      ...init,
      method: httpMethod,
      headers,
      ...(body !== undefined ? { body } : {}),
      ...(this.dispatcher ? { dispatcher: this.dispatcher } : {}),
    };

    const response = await this.fetchAndUnwrapTlsErrors(url, requestInit);

    return this.handleResponse<T>(response);
  }

  /**
   * `fetch()` wraps a rejected/errored connector (e.g. our TLS fingerprint
   * mismatch check) in a generic `TypeError('fetch failed', { cause })`.
   * Unwrap it so callers see the original `PveTlsError` directly.
   */
  private async fetchAndUnwrapTlsErrors(url: string, init: RequestInit): Promise<Response> {
    try {
      return await this.fetchImpl(url, init);
    } catch (error) {
      if (error instanceof Error && error.cause instanceof PveTlsError) {
        throw error.cause;
      }
      throw error;
    }
  }

  private applyAuth(headers: Headers): void {
    if (this.credentials.type === 'token') {
      headers.set('authorization', `PVEAPIToken=${this.credentials.tokenId}=${this.credentials.tokenSecret}`);
      return;
    }
    // Ticket + CSRF mode: cookie-based session auth (server-side pass-through login).
    // The ticket is sent URL-encoded, matching the stock UI (it stores the cookie
    // encoded too); PVE URI-unescapes it on the way in.
    headers.set('cookie', `PVEAuthCookie=${encodeURIComponent(this.credentials.ticket)}`);
    headers.set('csrfpreventiontoken', this.credentials.csrfToken);
  }

  private async handleResponse<T>(response: Response): Promise<T> {
    const text = await response.text();
    let envelope: PveEnvelope | undefined;
    if (text.length > 0) {
      try {
        envelope = JSON.parse(text) as PveEnvelope;
      } catch {
        envelope = undefined;
      }
    }

    if (!response.ok) {
      throw new PveApiError({
        status: response.status,
        // `||`, not `??`: an empty-string reason phrase (a real possibility --
        // some servers/proxies send a blank HTTP status line reason) should
        // also fall through to the generic message, not surface as "".
        message:
          envelope?.message || response.statusText || `Proxmox VE API request failed with status ${response.status}`,
        ...(envelope?.errors ? { errors: envelope.errors } : {}),
      });
    }

    return (envelope?.data as T | undefined) ?? (undefined as T);
  }
}
