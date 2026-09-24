import { createHash, X509Certificate } from 'node:crypto';
import * as https from 'node:https';
import type { AddressInfo } from 'node:net';
import { generate } from 'selfsigned';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { attachFakePveWs } from './helpers/fakePveWs.js';

/**
 * Proves that a wrong `PVE_TLS_FINGERPRINT` refuses the *upstream* console
 * websocket connection -- not just the REST call -- using a real local
 * self-signed HTTPS server, the same technique as
 * packages/pve-api/test/tls.test.ts.
 */
describe('console bridge TLS fingerprint pinning (local self-signed HTTPS+WS server)', () => {
  let server: https.Server;
  let port: number;
  let fingerprintPve: string;
  let wrongFingerprintHex: string;
  let upstreamConnections = 0;

  beforeAll(async () => {
    const pems = await generate([{ name: 'commonName', value: '127.0.0.1' }], {
      keySize: 2048,
      algorithm: 'sha256',
      extensions: [{ name: 'subjectAltName', altNames: [{ type: 7, ip: '127.0.0.1' }] }],
    });

    const x509 = new X509Certificate(pems.cert);
    const fingerprintHex = createHash('sha256').update(x509.raw).digest('hex');
    fingerprintPve = fingerprintHex.match(/.{2}/g)!.join(':').toUpperCase();
    wrongFingerprintHex = fingerprintHex.startsWith('ff')
      ? `00${fingerprintHex.slice(2)}`
      : `ff${fingerprintHex.slice(2)}`;

    server = https.createServer({ key: pems.private, cert: pems.cert }, (_req, res) => {
      res.writeHead(404);
      res.end();
    });
    attachFakePveWs(server, (ws) => {
      upstreamConnections += 1;
      ws.on('message', (data) => ws.send(data));
    });

    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = (server.address() as AddressInfo).port;
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) =>
      server.close((err) => (err ? reject(err) : resolve())),
    );
  });

  it('refuses the upstream connection (and closes the browser socket) on a fingerprint mismatch', async () => {
    upstreamConnections = 0;
    const app = await buildApp({
      config: loadConfig({
        NODE_ENV: 'test',
        PVE_URL: `https://127.0.0.1:${port}`,
        PVE_TLS_FINGERPRINT: wrongFingerprintHex,
        PVE_TOKEN_ID: 'root@pam!proxion',
        PVE_TOKEN_SECRET: 'tokensecret',
      }),
    });

    // Manufacture a pending console session directly, bypassing the REST vncproxy
    // call (which would itself fail over the same mismatched TLS) -- isolates the
    // websocket bridge's own TLS pinning.
    const id = app.consoleTicketStore.create({
      kind: 'vnc',
      node: 'node1',
      type: 'qemu',
      vmid: 100,
      port: 5900,
      vncticket: 'VNCTICKET',
      credentials: { type: 'token', tokenId: 'root@pam!proxion', tokenSecret: 'tokensecret' },
    });

    const baseUrl = await app.listen({ port: 0, host: '127.0.0.1' });
    const client = new WebSocket(`${baseUrl.replace('http', 'ws')}/ws/vnc/${id}`);

    const outcome = await new Promise<'closed' | 'errored'>((resolve) => {
      client.on('close', () => resolve('closed'));
      client.on('error', () => resolve('errored'));
    });

    expect(['closed', 'errored']).toContain(outcome);
    expect(upstreamConnections).toBe(0);

    if (client.readyState === WebSocket.OPEN) client.close();
    await app.close();
  });

  it('accepts the upstream connection when the fingerprint matches', async () => {
    upstreamConnections = 0;
    const app = await buildApp({
      config: loadConfig({
        NODE_ENV: 'test',
        PVE_URL: `https://127.0.0.1:${port}`,
        PVE_TLS_FINGERPRINT: fingerprintPve,
        PVE_TOKEN_ID: 'root@pam!proxion',
        PVE_TOKEN_SECRET: 'tokensecret',
      }),
    });

    const id = app.consoleTicketStore.create({
      kind: 'vnc',
      node: 'node1',
      type: 'qemu',
      vmid: 100,
      port: 5900,
      vncticket: 'VNCTICKET',
      credentials: { type: 'token', tokenId: 'root@pam!proxion', tokenSecret: 'tokensecret' },
    });

    const baseUrl = await app.listen({ port: 0, host: '127.0.0.1' });
    const client = new WebSocket(`${baseUrl.replace('http', 'ws')}/ws/vnc/${id}`);

    await new Promise<void>((resolve, reject) => {
      client.on('open', resolve);
      client.on('error', reject);
    });

    // Prove the full path is actually up (not just the browser-facing half) by
    // round-tripping a frame through the pinned upstream connection.
    const echoed = await new Promise<Buffer>((resolve) => {
      client.on('message', (data) => resolve(data as Buffer));
      client.send(Buffer.from('ping'));
    });
    expect(echoed.toString('utf8')).toBe('ping');
    expect(upstreamConnections).toBe(1);

    client.close();
    await new Promise<void>((resolve) => client.on('close', () => resolve()));
    await app.close();
  });
});
