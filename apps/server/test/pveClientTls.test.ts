import { createHash, X509Certificate } from 'node:crypto';
import * as https from 'node:https';
import type { AddressInfo } from 'node:net';
import { generate } from 'selfsigned';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { createPveDispatcher } from '../src/pve/dispatcher.js';
import { buildPveClient } from '../src/pve/client.js';

/**
 * Regression for the T34 production incident: every real storage upload against a Proxmox host
 * with a self-signed certificate 502'd instantly (`unable to verify the first certificate`),
 * because `buildPveClient` injected the shared, fingerprint-pinned dispatcher into a custom
 * `fetch` -- invisible to `PveHttp.stream()`, which the upload route's `uploadStream()` call uses
 * and which bypasses `fetch()` entirely (see `pve/client.ts`'s own doc comment, and
 * `packages/pve-api/test/stream-tls.test.ts` for the same failure mode reproduced directly against
 * `PveHttp`). This drives `buildPveClient` -- the actual function the upload route calls through --
 * against a real local self-signed HTTPS server, exactly the way `PveHttp`'s own `tls.test.ts`
 * drives `PveHttp` directly.
 */
describe('buildPveClient + PveClient.uploadStream over a self-signed TLS connection', () => {
  let server: https.Server;
  let port: number;
  let fingerprintPve: string;
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

    server = https.createServer({ key: pems.private, cert: pems.cert }, (req, res) => {
      requestCount += 1;
      req.resume();
      req.on('end', () => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ data: 'UPID:fakepve:00000001:00000000:00000000:imgcopy:0:root@pam:' }));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = (server.address() as AddressInfo).port;
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  });

  it('uploadStream() succeeds through the shared, fingerprint-pinned dispatcher buildPveClient wires up', async () => {
    requestCount = 0;
    const config = loadConfig({
      NODE_ENV: 'test',
      PVE_URL: `https://127.0.0.1:${port}`,
      PVE_TLS_FINGERPRINT: fingerprintPve,
    });
    const dispatcher = createPveDispatcher(config);
    const client = buildPveClient(config, { type: 'token', tokenId: 'root@pam!proxion', tokenSecret: 'secret' }, dispatcher);

    const upid = await client.uploadStream(
      '/nodes/{node}/storage/{storage}/upload',
      { node: 'pve1', storage: 'local' },
      { headers: { 'content-type': 'multipart/form-data; boundary=x' }, body: Buffer.from('abc'), contentLength: 3 },
    );

    expect(upid).toBe('UPID:fakepve:00000001:00000000:00000000:imgcopy:0:root@pam:');
    expect(requestCount).toBe(1);
  });

  it('an ordinary request() call also still works through the same shared dispatcher (unchanged behaviour)', async () => {
    requestCount = 0;
    const config = loadConfig({
      NODE_ENV: 'test',
      PVE_URL: `https://127.0.0.1:${port}`,
      PVE_TLS_FINGERPRINT: fingerprintPve,
    });
    const dispatcher = createPveDispatcher(config);
    const client = buildPveClient(config, { type: 'token', tokenId: 'root@pam!proxion', tokenSecret: 'secret' }, dispatcher);

    await expect(client.get('/version')).resolves.toBeDefined();
    expect(requestCount).toBe(1);
  });
});
