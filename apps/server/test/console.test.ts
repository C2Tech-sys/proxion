import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { WebSocket } from 'ws';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { startFakePve, type FakePve } from './helpers/fakePve.js';
import { attachFakePveWs, scriptedTermproxy } from './helpers/fakePveWs.js';

interface ConsoleStartBody {
  wsPath: string;
  password?: string;
}

async function postJson(
  baseUrl: string,
  path: string,
): Promise<{ status: number; body: ConsoleStartBody }> {
  const res = await fetch(`${baseUrl}${path}`, { method: 'POST' });
  const body = (await res.json()) as ConsoleStartBody;
  return { status: res.status, body };
}

describe('console bridges (token mode)', () => {
  let fakePve: FakePve;
  let app: FastifyInstance;
  let baseUrl: string;
  let wsClose: (() => void) | undefined;

  afterEach(async () => {
    wsClose?.();
    await app?.close();
    await fakePve?.close();
  });

  async function setup(
    onUpstream: (ws: WebSocket, req: import('node:http').IncomingMessage) => void,
  ) {
    fakePve = await startFakePve();
    const attached = attachFakePveWs(fakePve.app.server, onUpstream);
    wsClose = attached.close;

    app = await buildApp({
      config: loadConfig({
        NODE_ENV: 'test',
        PVE_URL: fakePve.url,
        PVE_TOKEN_ID: 'root@pam!proxion',
        PVE_TOKEN_SECRET: 'tokensecret',
        PROXION_ALLOW_TOKEN_MODE: 'true',
      }),
    });
    baseUrl = await app.listen({ port: 0, host: '127.0.0.1' });
  }

  it('VNC: starts a session and relays binary frames both ways', async () => {
    await setup((ws) => {
      ws.on('message', (data) => ws.send(data));
    });

    const start = await postJson(baseUrl, '/api/console/vnc/node1/qemu/100');
    expect(start.status).toBe(200);
    expect(start.body).toEqual({
      wsPath: expect.stringMatching(/^\/ws\/vnc\/[A-Za-z0-9_-]{20,}$/),
      password: 'VNCTICKET',
    });
    expect(fakePve.vncproxyCalls).toBe(1);

    const client = new WebSocket(`${baseUrl.replace('http', 'ws')}${start.body.wsPath}`);
    await new Promise<void>((resolve, reject) => {
      client.on('open', resolve);
      client.on('error', reject);
    });

    const echoed = await new Promise<Buffer>((resolve) => {
      client.on('message', (data) => resolve(data as Buffer));
      client.send(Buffer.from('hello-vnc'));
    });
    expect(echoed.toString('utf8')).toBe('hello-vnc');
    client.close();
  });

  it('VNC: a session id can only be used once', async () => {
    await setup((ws) => ws.on('message', (data) => ws.send(data)));
    const start = await postJson(baseUrl, '/api/console/vnc/node1/qemu/100');

    const first = new WebSocket(`${baseUrl.replace('http', 'ws')}${start.body.wsPath}`);
    await new Promise<void>((resolve, reject) => {
      first.on('open', resolve);
      first.on('error', reject);
    });
    first.close();
    await new Promise((resolve) => setTimeout(resolve, 20));

    const second = new WebSocket(`${baseUrl.replace('http', 'ws')}${start.body.wsPath}`);
    const secondClose = await new Promise<number>((resolve) => {
      second.on('close', (code) => resolve(code));
      second.on('error', () => resolve(-1));
    });
    expect(secondClose).toBe(4404);
  });

  it('Terminal: never sends a browser frame upstream before the OK handshake reply arrives', async () => {
    // `okDelayMs` deliberately delays PVE's `OK` reply -- the browser sends its
    // resize frame *immediately* on open (no artificial client-side delay), so
    // this only passes if the bridge itself withholds it until `OK` lands, not
    // because the client happened to wait long enough.
    const { onConnection, received } = scriptedTermproxy({
      onHandshake: () => 'ok',
      okDelayMs: 50,
    });
    await setup(onConnection);

    const start = await postJson(baseUrl, '/api/console/term/node1');
    expect(start.status).toBe(200);
    expect(start.body).toEqual({
      wsPath: expect.stringMatching(/^\/ws\/term\/[A-Za-z0-9_-]{20,}$/),
    });
    expect(start.body.password).toBeUndefined();
    expect(fakePve.termproxyCalls).toBe(1);

    const client = new WebSocket(`${baseUrl.replace('http', 'ws')}${start.body.wsPath}`);
    const browserReceived: string[] = [];
    client.on('message', (data) => browserReceived.push(data.toString('utf8')));
    await new Promise<void>((resolve, reject) => {
      client.on('open', resolve);
      client.on('error', reject);
    });

    client.send(Buffer.from('1:80:24:'));
    await new Promise<void>((resolve) => {
      const check = setInterval(() => {
        if (received.length >= 2) {
          clearInterval(check);
          resolve();
        }
      }, 5);
    });

    // PVE only ever saw the handshake, then (after replying OK) the resize frame --
    // never the resize frame first, and it never echoed `OK` itself to the browser.
    expect(received).toEqual(['root@pam:TERMTICKET\n', '1:80:24:']);
    expect(browserReceived).not.toContain('OK');
    client.close();
  });

  it('Terminal: closes the browser with 4502 when PVE rejects the handshake', async () => {
    const { onConnection } = scriptedTermproxy({ onHandshake: () => 'reject' });
    await setup(onConnection);

    const start = await postJson(baseUrl, '/api/console/term/node1');
    const client = new WebSocket(`${baseUrl.replace('http', 'ws')}${start.body.wsPath}`);

    const [code, reason] = await new Promise<[number, string]>((resolve) => {
      client.on('close', (c, r) => resolve([c, r.toString('utf8')]));
    });

    expect(code).toBe(4502);
    expect(reason).toBe('PVE terminal handshake failed');
  });

  it('Terminal: closes the browser with 4502 when PVE closes before replying OK', async () => {
    const { onConnection } = scriptedTermproxy({ onHandshake: () => 'close' });
    await setup(onConnection);

    const start = await postJson(baseUrl, '/api/console/term/node1');
    const client = new WebSocket(`${baseUrl.replace('http', 'ws')}${start.body.wsPath}`);

    const [code, reason] = await new Promise<[number, string]>((resolve) => {
      client.on('close', (c, r) => resolve([c, r.toString('utf8')]));
    });

    expect(code).toBe(4502);
    expect(reason).toBe('PVE terminal handshake failed');
  });

  it('VNC: closes the browser with 4502 (generic reason) when the upstream connection fails after it is established', async () => {
    await setup((ws) => {
      // Accept the connection, then immediately drop it -- simulating PVE
      // going away mid-session, unrelated to any handshake.
      ws.close();
    });

    const start = await postJson(baseUrl, '/api/console/vnc/node1/qemu/100');
    const client = new WebSocket(`${baseUrl.replace('http', 'ws')}${start.body.wsPath}`);

    const [code, reason] = await new Promise<[number, string]>((resolve) => {
      client.on('close', (c, r) => resolve([c, r.toString('utf8')]));
    });

    expect(code).toBe(4502);
    expect(reason).toBe('Upstream PVE connection failed');
  });
});
