import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { startFakePve, type FakePve } from './helpers/fakePve.js';
import * as dispatcherModule from '../src/pve/dispatcher.js';
import { buildUpstreamUrl } from '../src/proxy/pveProxy.js';

function cookieFrom(setCookieHeader: string | string[] | undefined): string {
  const raw = Array.isArray(setCookieHeader) ? setCookieHeader[0] : setCookieHeader;
  if (!raw) throw new Error('no Set-Cookie header');
  return raw.split(';')[0]!;
}

describe('GET /api/pve/*', () => {
  let fakePve: FakePve;
  let app: FastifyInstance;

  afterEach(async () => {
    await app?.close();
    await fakePve?.close();
  });

  it('returns 401 with no identity (no session, no token mode)', async () => {
    fakePve = await startFakePve();
    app = await buildApp({ config: loadConfig({ NODE_ENV: 'test', PVE_URL: fakePve.url }) });

    const response = await app.inject({ method: 'GET', url: '/api/pve/version' });
    expect(response.statusCode).toBe(401);
  });

  it('forwards to PVE with the session ticket and returns the body/status verbatim', async () => {
    fakePve = await startFakePve();
    app = await buildApp({ config: loadConfig({ NODE_ENV: 'test', PVE_URL: fakePve.url }) });

    const login = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { username: 'root@pam', password: 'goodpass' },
    });
    const cookie = cookieFrom(login.headers['set-cookie']);

    const response = await app.inject({
      method: 'GET',
      url: '/api/pve/version',
      headers: { cookie },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ data: { version: '9.0', release: '9.0' } });
  });

  it('never forwards the browser cookie upstream', async () => {
    fakePve = await startFakePve();
    app = await buildApp({ config: loadConfig({ NODE_ENV: 'test', PVE_URL: fakePve.url }) });
    const login = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { username: 'root@pam', password: 'goodpass' },
    });
    const cookie = cookieFrom(login.headers['set-cookie']);

    await app.inject({
      method: 'GET',
      url: '/api/pve/version',
      headers: { cookie: `${cookie}; other=browser-only` },
    });

    expect(fakePve.lastCookieHeader).toBe('PVEAuthCookie=PVE%3Aroot%40pam%3AFAKETICKET-0');
  });

  it('rejects non-GET methods with 405 (write proxy not enabled)', async () => {
    fakePve = await startFakePve();
    app = await buildApp({ config: loadConfig({ NODE_ENV: 'test', PVE_URL: fakePve.url }) });

    for (const method of ['POST', 'PUT', 'DELETE', 'PATCH'] as const) {
      const response = await app.inject({
        method,
        url: '/api/pve/nodes/pve/qemu/100/status/start',
      });
      expect(response.statusCode).toBe(405);
    }
  });

  it('uses the service token identity in token mode with no session', async () => {
    fakePve = await startFakePve();
    app = await buildApp({
      config: loadConfig({
        NODE_ENV: 'test',
        PVE_URL: fakePve.url,
        PVE_TOKEN_ID: 'root@pam!proxion',
        PVE_TOKEN_SECRET: 'tokensecret',
        PROXION_ALLOW_TOKEN_MODE: 'true',
      }),
    });

    const response = await app.inject({ method: 'GET', url: '/api/pve/version' });
    expect(response.statusCode).toBe(200);
  });

  it('token mode is off by default even with a service token configured', async () => {
    fakePve = await startFakePve();
    app = await buildApp({
      config: loadConfig({
        NODE_ENV: 'test',
        PVE_URL: fakePve.url,
        PVE_TOKEN_ID: 'root@pam!proxion',
        PVE_TOKEN_SECRET: 'tokensecret',
      }),
    });

    const response = await app.inject({ method: 'GET', url: '/api/pve/version' });
    expect(response.statusCode).toBe(401);
  });
});

describe('buildUpstreamUrl (path containment, unit)', () => {
  function reqWithUrl(url: string) {
    return { raw: { url }, url } as unknown as Parameters<typeof buildUpstreamUrl>[1];
  }

  it('rejects a plain ".." traversal that would escape /api2/json/', () => {
    expect(
      buildUpstreamUrl('https://pve.example:8006', reqWithUrl('/api/pve/../../access/ticket')),
    ).toBeUndefined();
  });

  it('rejects a percent-encoded ".." traversal (the URL Standard normalizes %2e like a literal dot)', () => {
    expect(
      buildUpstreamUrl('https://pve.example:8006', reqWithUrl('/api/pve/%2e%2e/x')),
    ).toBeUndefined();
  });

  it('rejects a protocol-relative ("//host/...") suffix', () => {
    expect(
      buildUpstreamUrl('https://pve.example:8006', reqWithUrl('/api/pve//evil.example.com/x')),
    ).toBeUndefined();
  });

  it('resolves a normal path with a query string, unchanged, inside /api2/json/', () => {
    const url = buildUpstreamUrl(
      'https://pve.example:8006',
      reqWithUrl('/api/pve/cluster/resources?type=vm'),
    );
    expect(url?.pathname).toBe('/api2/json/cluster/resources');
    expect(url?.search).toBe('?type=vm');
  });

  it('resolves the /api/pve root to the /api2/json/ root', () => {
    const url = buildUpstreamUrl('https://pve.example:8006', reqWithUrl('/api/pve'));
    expect(url?.pathname).toBe('/api2/json/');
  });
});

describe('GET /api/pve/* path containment (end-to-end)', () => {
  let fakePve: FakePve;
  let app: FastifyInstance;

  afterEach(async () => {
    await app?.close();
    await fakePve?.close();
  });

  async function setup() {
    fakePve = await startFakePve();
    app = await buildApp({
      config: loadConfig({
        NODE_ENV: 'test',
        PVE_URL: fakePve.url,
        PVE_TOKEN_ID: 'root@pam!proxion',
        PVE_TOKEN_SECRET: 'tokensecret',
        PROXION_ALLOW_TOKEN_MODE: 'true',
      }),
    });
    // The poller (auto-started because a service token is configured) also hits
    // /cluster/resources and /cluster/tasks in the background; stop it so its
    // requests can't race with -- and pollute -- this describe's assertions
    // about exactly what PVE saw.
    app.proxionPoller?.stop();
  }

  it('a plain ".." traversal never reaches PVE (blocked by routing or, if it ever did match, by buildUpstreamUrl)', async () => {
    await setup();
    const response = await app.inject({ method: 'GET', url: '/api/pve/../../access/ticket' });
    expect(response.statusCode).not.toBe(200);
    expect(fakePve.requestCount).toBe(0);
  });

  it('a percent-encoded ".." traversal never reaches PVE', async () => {
    await setup();
    const response = await app.inject({ method: 'GET', url: '/api/pve/%2e%2e/x' });
    expect(response.statusCode).not.toBe(200);
    expect(fakePve.requestCount).toBe(0);
  });

  it('rejects a protocol-relative ("//host/...") suffix with 400, and PVE never sees it', async () => {
    await setup();
    const response = await app.inject({ method: 'GET', url: '/api/pve//evil.example.com/x' });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: 'Invalid PVE API path' });
    expect(fakePve.requestCount).toBe(0);
  });

  it('still forwards a normal path with a query string, unchanged', async () => {
    await setup();
    const response = await app.inject({ method: 'GET', url: '/api/pve/cluster/resources?type=vm' });
    expect(response.statusCode).toBe(200);
    expect(fakePve.lastRequestUrl).toBe('/api2/json/cluster/resources?type=vm');
  });
});

describe('shared PVE dispatcher (no per-request Agent leak)', () => {
  it('is built exactly once at boot and reused across proxied requests', async () => {
    const fakePve = await startFakePve();
    const spy = vi.spyOn(dispatcherModule, 'createPveDispatcher');

    const app = await buildApp({
      config: loadConfig({
        NODE_ENV: 'test',
        PVE_URL: fakePve.url,
        PVE_TOKEN_ID: 'root@pam!proxion',
        PVE_TOKEN_SECRET: 'tokensecret',
        PROXION_ALLOW_TOKEN_MODE: 'true',
      }),
    });
    expect(spy).toHaveBeenCalledTimes(1);

    for (let i = 0; i < 5; i += 1) {
      const response = await app.inject({ method: 'GET', url: '/api/pve/version' });
      expect(response.statusCode).toBe(200);
    }

    expect(spy).toHaveBeenCalledTimes(1);

    await app.close();
    await fakePve.close();
    spy.mockRestore();
  });

  it('reuses the same PveClient for a session across proxied requests (not rebuilt per request)', async () => {
    const fakePve = await startFakePve();
    const app = await buildApp({ config: loadConfig({ NODE_ENV: 'test', PVE_URL: fakePve.url }) });

    const login = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { username: 'root@pam', password: 'goodpass' },
    });
    const cookie = cookieFrom(login.headers['set-cookie']);
    const sid = [...app.sessionStore.values()][0]!.sid;
    const clientBefore = app.sessionStore.get(sid)!.pveClient;

    await app.inject({ method: 'GET', url: '/api/pve/version', headers: { cookie } });
    await app.inject({ method: 'GET', url: '/api/pve/version', headers: { cookie } });

    expect(app.sessionStore.get(sid)!.pveClient).toBe(clientBefore);

    await app.close();
    await fakePve.close();
  });
});
