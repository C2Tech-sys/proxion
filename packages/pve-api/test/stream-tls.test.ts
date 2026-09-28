import { createHash, X509Certificate } from 'node:crypto';
import * as https from 'node:https';
import type { AddressInfo } from 'node:net';
import { generate } from 'selfsigned';
import { fetch as undiciFetch, type RequestInit } from 'undici';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { PveHttp } from '../src/http.js';
import { PveTlsError } from '../src/errors.js';
import { createTlsAgent } from '../src/tls.js';

/**
 * `PveHttp.stream()` against a real local self-signed HTTPS server (T34) -- same harness style as
 * `tls.test.ts`'s own "TLS fingerprint pinning" describe block, extended to `stream()` (the
 * multipart-upload transport `storageRoutes.ts`'s upload route uses), which is a structurally
 * different code path from `request()` (see `stream()`'s own doc comment in `src/http.ts`: it
 * bypasses `fetch()` entirely and talks to the dispatcher directly, for per-call timeouts a shared
 * dispatcher/`fetch()` can't offer).
 *
 * Production incident this guards against: every real storage upload 502'd instantly with
 * `unable to verify the first certificate` -- the request reached this process, but `stream()`
 * opened its own connection with Node's *default* trust store instead of the fingerprint-pinned
 * one `request()` uses, because `apps/server`'s `buildPveClient` injected the shared dispatcher
 * into a custom `fetch` (invisible to `stream()`) instead of passing it as `PveHttpOptions.dispatcher`
 * (see `apps/server/src/pve/client.ts` and `dispatcher.ts` for the actual fix). The last test below
 * reproduces that exact anti-pattern directly against `PveHttp`, so it can never silently return.
 */
describe('PveHttp.stream() over TLS (local self-signed HTTPS server)', () => {
  let server: https.Server;
  let port: number;
  let fingerprintPve: string;
  let wrongFingerprintHex: string;
  let requestCount = 0;

  beforeAll(async () => {
    const pems = await generate([{ name: 'commonName', value: '127.0.0.1' }], {
      keySize: 2048,
      algorithm: 'sha256',
      extensions: [{ name: 'subjectAltName', altNames: [{ type: 7, ip: '127.0.0.1' }] }],
    });
    const x509 = new X509Certificate(pems.cert);
    const fingerprintHex = createHash('sha256').update(x509.raw).digest('hex');
    fingerprintPve = fingerprintHex.match(/.{2}/g)!.join(':').toUpperCase();
    wrongFingerprintHex = fingerprintHex.startsWith('ff') ? `00${fingerprintHex.slice(2)}` : `ff${fingerprintHex.slice(2)}`;

    server = https.createServer({ key: pems.private, cert: pems.cert }, (req, res) => {
      requestCount += 1;
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ data: 'UPID:test:00000001::::imgcopy::root@pam:' }));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = (server.address() as AddressInfo).port;
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  });

  function streamUpload(http: PveHttp) {
    return http.stream(
      'POST',
      '/nodes/{node}/storage/{storage}/upload',
      { node: 'pve1', storage: 'local' },
      { headers: { 'content-type': 'multipart/form-data; boundary=x' }, body: Buffer.from('abc'), contentLength: 3 },
    );
  }

  it('(a) tls.fingerprint passed directly to PveHttp: stream() succeeds against the pinned self-signed server', async () => {
    requestCount = 0;
    const http = new PveHttp({
      baseUrl: `https://127.0.0.1:${port}`,
      credentials: { type: 'token', tokenId: 'root@pam!test', tokenSecret: 'secret' },
      tls: { fingerprint: fingerprintPve },
    });

    await expect(streamUpload(http)).resolves.toBe('UPID:test:00000001::::imgcopy::root@pam:');
    expect(requestCount).toBe(1);
  });

  it('(b) a wrong fingerprint makes stream() fail with the same PveTlsError class request() fails with', async () => {
    requestCount = 0;
    const http = new PveHttp({
      baseUrl: `https://127.0.0.1:${port}`,
      credentials: { type: 'token', tokenId: 'root@pam!test', tokenSecret: 'secret' },
      tls: { fingerprint: wrongFingerprintHex },
    });

    await expect(streamUpload(http)).rejects.toBeInstanceOf(PveTlsError);
    expect(requestCount).toBe(0);
  });

  it('(c) an explicit `dispatcher` option is the exact object stream() hands to the request -- verified via a spy on the real pinned Agent', async () => {
    requestCount = 0;
    const dispatcher = createTlsAgent({ fingerprint: fingerprintPve })!;
    const requestSpy = vi.spyOn(dispatcher, 'request');
    const http = new PveHttp({
      baseUrl: `https://127.0.0.1:${port}`,
      credentials: { type: 'token', tokenId: 'root@pam!test', tokenSecret: 'secret' },
      dispatcher,
    });

    await expect(streamUpload(http)).resolves.toBe('UPID:test:00000001::::imgcopy::root@pam:');
    expect(requestSpy).toHaveBeenCalledTimes(1);
    expect(requestCount).toBe(1);
  });

  it(
    "(d) THE PRODUCTION BUG: a dispatcher hidden inside a custom `fetch` (never passed as `dispatcher`) is invisible " +
      "to stream() -- request() still works (it goes through fetch), but stream() falls back to the global " +
      'dispatcher and fails cert verification. This is exactly the anti-pattern a previous version of ' +
      "apps/server's `buildPveClient` used; that file now passes `dispatcher` directly instead (see its own " +
      'doc comment). This test must keep failing -- it exists to prove the bug class, not to be "fixed" by ' +
      'quietly changing stream() to peek inside an arbitrary fetch closure.',
    async () => {
      requestCount = 0;
      const sharedDispatcher = createTlsAgent({ fingerprint: fingerprintPve })!;
      const fetchThatHidesTheDispatcher = ((url: string | URL, init: RequestInit = {}) =>
        undiciFetch(url, { ...init, dispatcher: sharedDispatcher })) as typeof undiciFetch;

      const http = new PveHttp({
        baseUrl: `https://127.0.0.1:${port}`,
        credentials: { type: 'token', tokenId: 'root@pam!test', tokenSecret: 'secret' },
        fetch: fetchThatHidesTheDispatcher,
      });

      // request() works: it goes through `fetch`, which the custom implementation routes through
      // the pinned dispatcher.
      await expect(http.request('GET', '/version', {})).resolves.toBeDefined();

      // stream() does not go through `fetch` at all, so it never sees `sharedDispatcher` and falls
      // back to undici's global dispatcher -- default certificate verification, which rejects this
      // self-signed server exactly like it did in production.
      await expect(streamUpload(http)).rejects.toThrow();
    },
  );
});
