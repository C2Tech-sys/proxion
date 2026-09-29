import * as nodeHttp from 'node:http';
import type { AddressInfo } from 'node:net';
import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { PveApiError, PveHttp } from '../src/index.js';

/**
 * Builds a 10 MB Readable of arbitrary bytes, generated on demand (never held in memory all at
 * once) -- big enough that a real TCP socket cannot buffer it entirely, so a server that stops
 * reading after replying genuinely leaves bytes unsent when the connection closes (T35).
 */
function make10MbStream(): Readable {
  const CHUNK = Buffer.alloc(64 * 1024, 7);
  const total = 10 * 1024 * 1024;
  let sent = 0;
  return new Readable({
    read() {
      if (sent >= total) {
        this.push(null);
        return;
      }
      const size = Math.min(CHUNK.length, total - sent);
      sent += size;
      this.push(size === CHUNK.length ? CHUNK : CHUNK.subarray(0, size));
    },
  });
}

/**
 * A bare local HTTP server (T35) reproducing the production incident: it answers with `status`
 * immediately after headers, without ever reading the request body, then closes the connection --
 * exactly what pveproxy did to the real host in the incident this ticket fixes (see
 * `packages/pve-api/src/http.ts`'s `stream()` doc comment and this repo's CHANGELOG). Unlike
 * `stream.test.ts`'s fake `Dispatcher`, this drives a real socket so `stream()`'s actual
 * `dispatcher.request()` call (not a stand-in) is what's under test.
 */
async function startEarlyReplyServer(status: number, message: string): Promise<{ url: string; close: () => Promise<void> }> {
  const server = nodeHttp.createServer((req, res) => {
    // Required so a body-write failure on a connection Node is still finishing up never surfaces
    // as an unhandled 'error' on the request itself and crashes the test process.
    req.on('error', () => {});
    // Deliberately never reads/drains `req` and never sets `Connection: close` or touches the
    // socket directly -- plain default (keep-alive) Node http-server behaviour, same as Fastify's
    // own default and closer to how pveproxy behaves in production (see the incident writeup in
    // `src/http.ts`'s `stream()` doc comment and this repo's CHANGELOG): the response reaches the
    // client while the request body is still (genuinely) arriving, with no special handling
    // needed on either side. An explicit `Connection: close` here, or destroying the socket
    // ourselves, instead reproduces a *different* failure (the peer's TCP stack racing an RST
    // against its own not-yet-fully-delivered response) that this test is not about.
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ data: null, message }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${address.port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

describe('PveHttp.stream against a server that replies before reading the body (T35)', () => {
  it('throws PveApiError with the real status and message instead of hanging or masking the reply', async () => {
    const server = await startEarlyReplyServer(401, 'authentication failure');
    try {
      const http = new PveHttp({ baseUrl: server.url, credentials: { type: 'token', tokenId: 'root@pam!x', tokenSecret: 's' } });

      await expect(
        http.stream(
          'POST',
          '/nodes/{node}/storage/{storage}/upload',
          { node: 'pve', storage: 'local' },
          { headers: { 'content-type': 'application/octet-stream' }, body: make10MbStream(), contentLength: 10 * 1024 * 1024 },
        ),
      ).rejects.toMatchObject({ status: 401, message: 'authentication failure' });
    } finally {
      await server.close();
    }
  });

  it('is an instance of PveApiError', async () => {
    const server = await startEarlyReplyServer(401, 'authentication failure');
    try {
      const http = new PveHttp({ baseUrl: server.url, credentials: { type: 'token', tokenId: 'root@pam!x', tokenSecret: 's' } });

      await expect(
        http.stream(
          'POST',
          '/nodes/{node}/storage/{storage}/upload',
          { node: 'pve', storage: 'local' },
          { headers: { 'content-type': 'application/octet-stream' }, body: make10MbStream(), contentLength: 10 * 1024 * 1024 },
        ),
      ).rejects.toBeInstanceOf(PveApiError);
    } finally {
      await server.close();
    }
  });
});
