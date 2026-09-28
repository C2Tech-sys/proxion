import type { Readable } from 'node:stream';
import {
  Headers,
  fetch as undiciFetch,
  getGlobalDispatcher,
  type Dispatcher,
  type RequestInit,
  type Response,
} from 'undici';
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
  /**
   * Override the fetch implementation (used in tests). Defaults to undici's own `fetch`.
   *
   * NOTE (T34): `stream()` bypasses `fetch` entirely (see its own doc comment) and resolves its
   * dispatcher only from `tls`/`dispatcher` above -- never from this option. A caller that needs
   * one dispatcher shared across many `PveHttp` instances (a server holding one per session, say)
   * must pass it as `dispatcher`, not smuggle it into a custom `fetch` here: `request()` would work
   * either way, but `stream()` would silently fall back to undici's *global* dispatcher, which
   * fails outright against a self-signed certificate `dispatcher`/`tls` would have pinned past.
   * This is exactly the bug a previous version of `apps/server`'s `buildPveClient` had.
   */
  fetch?: typeof undiciFetch;
}

interface PveEnvelope {
  data?: unknown;
  errors?: Record<string, string>;
  message?: string;
}

/**
 * A body PVE will accept for `PveHttp.stream()`: exactly what undici's low-level
 * `Dispatcher.request()` itself accepts as a streamable body -- a Node.js `Readable` (an inbound
 * HTTP request, e.g. Fastify's `req.raw`, is one) or an already-buffered `Buffer` -- never a value
 * this module reads into memory itself. The caller (an HTTP route handler forwarding a browser
 * upload) is expected to pass the *raw* incoming stream straight through, so the bytes are never
 * buffered twice.
 */
export type PveStreamBody = Readable | Buffer | null;

export interface PveStreamOptions {
  /** Forwarded as-is (after `applyAuth` adds the auth header(s)) -- callers set at least
   * `content-type` here, since a streamed body's exact framing (e.g. a multipart boundary) is
   * this call's caller's responsibility, not this transport's. */
  headers?: Record<string, string>;
  /** The request body -- streamed to PVE, never buffered by this method (see `PveStreamBody`). */
  body: PveStreamBody;
  /** Sent as the `content-length` header; also the number undici uses to know when the request
   * body is complete. Callers must know this upfront (e.g. from the inbound request's own
   * `content-length`) -- `PveHttp.stream()` never buffers the body to compute it. */
  contentLength: number;
  /** Aborts the in-flight request to PVE when triggered (e.g. the original client disconnected
   * mid-upload) -- propagated straight to undici's own `Dispatcher.request()` `signal` option. */
  signal?: AbortSignal;
}

/**
 * Floor for `stream()`'s per-call `headersTimeout`/`bodyTimeout` -- long enough for a many-GB ISO
 * upload over a slow link to never trip undici's much shorter default (5 minutes), regardless of
 * whether this instance's own dispatcher (if any) was built with a shorter one.
 */
const STREAM_TIMEOUT_MS = 60 * 60 * 1000;

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
    return this.interpretEnvelope<T>(response.status, text, response.statusText);
  }

  /**
   * Shared by `handleResponse` (the `fetch`-based `request()` path) and `stream()` (the
   * dispatcher-based streaming path, which has no `Response` object to read a body/statusText
   * from) -- parses PVE's `{data, errors, message}` envelope and either returns `data` or raises
   * `PveApiError`, identically either way.
   */
  private interpretEnvelope<T>(status: number, text: string, statusText?: string): T {
    let envelope: PveEnvelope | undefined;
    if (text.length > 0) {
      try {
        envelope = JSON.parse(text) as PveEnvelope;
      } catch {
        envelope = undefined;
      }
    }

    if (status < 200 || status >= 300) {
      throw new PveApiError({
        status,
        // `||`, not `??`: an empty-string reason phrase (a real possibility -- some
        // servers/proxies send a blank HTTP status line reason) should also fall through to the
        // generic message, not surface as "".
        message: envelope?.message || statusText || `Proxmox VE API request failed with status ${status}`,
        ...(envelope?.errors ? { errors: envelope.errors } : {}),
      });
    }

    return (envelope?.data as T | undefined) ?? (undefined as T);
  }

  /**
   * Streams a request body straight to PVE without ever buffering it in this process -- for
   * uploads too large to hold in memory (a many-GB ISO). Deliberately bypasses `fetch()`/
   * `request()` above: undici's `fetch()` has no per-call way to raise `headersTimeout`/
   * `bodyTimeout` past whatever the dispatcher itself was built with (a real risk here -- an
   * `Agent` built with no explicit timeout, or the global default dispatcher, times out at 5
   * minutes, far too short for a large upload over a slow link), so this drives the dispatcher's
   * own low-level `request()` directly, which *does* accept per-call timeouts. That also means
   * this path never follows redirects (undici's `Dispatcher.request()` doesn't, unlike `fetch()`
   * with its default `redirect: 'follow'`) -- exactly what a same-origin PVE upload needs.
   *
   * Auth is applied exactly like `request()` (`applyAuth`), so a caller's ticket/CSRF token or
   * API token never has to leave this package. `params` substitutes the path template's `{node}`/
   * `{storage}`-style placeholders (see `substitutePathParams`) -- there is no query/body
   * parameter serialization here, unlike `request()`: every other field PVE's upload/download-url
   * endpoints need travels inside `opts.body` (the caller's own already-framed request body) or is
   * a path parameter, so nothing else needs appending.
   *
   * Dispatcher resolution (T34): `this.dispatcher ?? getGlobalDispatcher()` -- the *same*
   * `this.dispatcher` field `request()` conditionally attaches to its own `fetch` call, built once
   * in the constructor from `tls`/`dispatcher`. That field is `undefined` only when this instance
   * was given neither -- the "no TLS options at all" configuration, where falling back to undici's
   * global dispatcher matches `request()`'s own default `fetch` behaviour exactly. See
   * `PveHttpOptions.fetch`'s doc comment for the one configuration this can't see: a dispatcher
   * hidden inside a custom `fetch` instead of passed as `dispatcher`.
   */
  async stream<T = unknown>(
    method: string,
    pathTemplate: string,
    params: PveParams,
    opts: PveStreamOptions,
  ): Promise<T> {
    const { path: resolvedPath } = substitutePathParams(pathTemplate, params);
    const url = new URL(`${this.baseUrl}/api2/json${resolvedPath}`);

    const headers = new Headers(opts.headers);
    this.applyAuth(headers);
    headers.set('content-length', String(opts.contentLength));
    const headerRecord: Record<string, string> = {};
    headers.forEach((value, key) => {
      headerRecord[key] = value;
    });

    const dispatcher = this.dispatcher ?? getGlobalDispatcher();

    const requestOptions: Dispatcher.RequestOptions = {
      origin: url.origin,
      path: `${url.pathname}${url.search}`,
      method: method.toUpperCase() as Dispatcher.HttpMethod,
      headers: headerRecord,
      headersTimeout: STREAM_TIMEOUT_MS,
      bodyTimeout: STREAM_TIMEOUT_MS,
      ...(opts.body !== null ? { body: opts.body } : {}),
      ...(opts.signal ? { signal: opts.signal } : {}),
    };

    let response: Dispatcher.ResponseData;
    try {
      response = await dispatcher.request(requestOptions);
    } catch (error) {
      if (error instanceof Error && error.cause instanceof PveTlsError) throw error.cause;
      throw error;
    }

    const chunks: Buffer[] = [];
    for await (const chunk of response.body) {
      chunks.push(chunk as Buffer);
    }
    const text = Buffer.concat(chunks).toString('utf8');

    return this.interpretEnvelope<T>(response.statusCode, text);
  }
}
