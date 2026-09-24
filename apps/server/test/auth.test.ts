import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { startFakePve, type FakePve } from './helpers/fakePve.js';

function rawSetCookie(setCookieHeader: string | string[] | undefined): string {
  const raw = Array.isArray(setCookieHeader) ? setCookieHeader[0] : setCookieHeader;
  if (!raw) throw new Error('no Set-Cookie header');
  return raw;
}

function cookieFrom(setCookieHeader: string | string[] | undefined): string {
  return rawSetCookie(setCookieHeader).split(';')[0]!;
}

describe('auth routes', () => {
  let fakePve: FakePve;
  let app: FastifyInstance;

  afterEach(async () => {
    await app?.close();
    await fakePve?.close();
  });

  async function setup() {
    fakePve = await startFakePve();
    app = await buildApp({ config: loadConfig({ NODE_ENV: 'test', PVE_URL: fakePve.url }) });
  }

  it('POST /api/auth/login succeeds with correct credentials and sets a session cookie', async () => {
    await setup();
    const response = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { username: 'root', password: 'goodpass', realm: 'pam' },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      username: 'root@pam',
      realm: 'pam',
      capabilities: { vms: { 'VM.Audit': 1 } },
    });
    const cookie = cookieFrom(response.headers['set-cookie']);
    expect(cookie).toMatch(/^proxion\.sid=/);
  });

  it('does not set Secure on the session cookie by default outside production', async () => {
    await setup();
    const response = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { username: 'root@pam', password: 'goodpass' },
    });
    expect(rawSetCookie(response.headers['set-cookie'])).not.toMatch(/Secure/i);
  });

  it('sets Secure on the session cookie when PROXION_COOKIE_SECURE=true, even outside production', async () => {
    fakePve = await startFakePve();
    app = await buildApp({
      config: loadConfig({ NODE_ENV: 'test', PVE_URL: fakePve.url, PROXION_COOKIE_SECURE: 'true' }),
    });
    const response = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { username: 'root@pam', password: 'goodpass' },
    });
    expect(rawSetCookie(response.headers['set-cookie'])).toMatch(/Secure/i);
  });

  it('POST /api/auth/login rejects bad credentials with a generic 401 (no PVE detail leaked)', async () => {
    await setup();
    const response = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { username: 'root', password: 'wrongpass', realm: 'pam' },
    });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({ error: 'Invalid credentials' });
    expect(JSON.stringify(response.json())).not.toMatch(/authentication failure/);
  });

  it('GET /api/auth/me returns 401 with no session', async () => {
    await setup();
    const response = await app.inject({ method: 'GET', url: '/api/auth/me' });
    expect(response.statusCode).toBe(401);
  });

  it('GET /api/auth/me returns the session user after login', async () => {
    await setup();
    const login = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { username: 'root@pam', password: 'goodpass' },
    });
    const cookie = cookieFrom(login.headers['set-cookie']);

    const me = await app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie } });
    expect(me.statusCode).toBe(200);
    expect(me.json()).toEqual({
      username: 'root@pam',
      realm: 'pam',
      capabilities: { vms: { 'VM.Audit': 1 } },
      mode: 'session',
    });
  });

  it('POST /api/auth/logout clears the session', async () => {
    await setup();
    const login = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { username: 'root@pam', password: 'goodpass' },
    });
    const cookie = cookieFrom(login.headers['set-cookie']);

    const logout = await app.inject({
      method: 'POST',
      url: '/api/auth/logout',
      headers: { cookie },
    });
    expect(logout.statusCode).toBe(200);

    const me = await app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie } });
    expect(me.statusCode).toBe(401);
  });

  it('rate-limits login attempts (10/min/IP)', async () => {
    await setup();
    let last;
    for (let i = 0; i < 11; i += 1) {
      last = await app.inject({
        method: 'POST',
        url: '/api/auth/login',
        payload: { username: 'root', password: 'wrongpass' },
      });
    }
    expect(last!.statusCode).toBe(429);
  });

  it('renews the ticket for sessions older than 1h, and reuses the same PveClient afterward', async () => {
    await setup();
    const login = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { username: 'root@pam', password: 'goodpass' },
    });
    const cookie = cookieFrom(login.headers['set-cookie']);
    const before = [...app.sessionStore.values()][0]!;
    const sid = before.sid;
    expect(fakePve.ticketCalls).toHaveLength(1);

    // Force the session to look old enough to need renewal.
    app.sessionStore.set(sid, { ...before, lastRenewedAt: Date.now() - 2 * 60 * 60 * 1000 });

    const me = await app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie } });
    expect(me.statusCode).toBe(200);
    expect(fakePve.ticketCalls).toHaveLength(2);
    expect(fakePve.ticketCalls[1]).toEqual({ username: 'root@pam', password: before.ticket });

    const after = app.sessionStore.get(sid)!;
    expect(after.ticket).not.toBe(before.ticket);
  });

  it('logs the user out when ticket renewal fails', async () => {
    await setup();
    const login = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { username: 'root@pam', password: 'goodpass' },
    });
    const cookie = cookieFrom(login.headers['set-cookie']);
    const before = [...app.sessionStore.values()][0]!;
    const sid = before.sid;
    // Corrupt the ticket so renewal (password=<ticket>) is rejected by the fake PVE.
    app.sessionStore.set(sid, {
      ...before,
      ticket: 'stale-ticket',
      lastRenewedAt: Date.now() - 2 * 60 * 60 * 1000,
    });

    const me = await app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie } });
    expect(me.statusCode).toBe(401);
    expect(app.sessionStore.get(sid)).toBeUndefined();
  });

  it('POST /api/auth/login returns 502 "Proxmox VE unreachable" (not 401) when PVE cannot be reached', async () => {
    // Port 1 is not listening; the connection is refused -- a transport
    // failure, not a rejected credential.
    app = await buildApp({
      config: loadConfig({ NODE_ENV: 'test', PVE_URL: 'https://127.0.0.1:1' }),
    });
    const response = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { username: 'root@pam', password: 'goodpass' },
    });
    expect(response.statusCode).toBe(502);
    expect(response.json()).toEqual({ error: 'Proxmox VE unreachable' });
  });

  it('POST /api/auth/login returns 502 when PVE answers but with a 5xx (not 401)', async () => {
    const brokenPve = http.createServer((_req, res) => {
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ message: 'internal error' }));
    });
    await new Promise<void>((resolve) => brokenPve.listen(0, '127.0.0.1', resolve));
    const port = (brokenPve.address() as AddressInfo).port;

    app = await buildApp({
      config: loadConfig({ NODE_ENV: 'test', PVE_URL: `http://127.0.0.1:${port}` }),
    });
    const response = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { username: 'root@pam', password: 'goodpass' },
    });
    expect(response.statusCode).toBe(502);
    expect(response.json()).toEqual({ error: 'Proxmox VE unreachable' });

    await new Promise<void>((resolve, reject) =>
      brokenPve.close((err) => (err ? reject(err) : resolve())),
    );
  });

  it('keeps the session (does not log out) when ticket renewal fails because PVE is unreachable, and retries next request', async () => {
    await setup();
    const login = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { username: 'root@pam', password: 'goodpass' },
    });
    const cookie = cookieFrom(login.headers['set-cookie']);
    const before = [...app.sessionStore.values()][0]!;
    const sid = before.sid;
    const staleRenewedAt = Date.now() - 2 * 60 * 60 * 1000;
    app.sessionStore.set(sid, { ...before, lastRenewedAt: staleRenewedAt });

    // PVE goes away entirely (simulates a network/TLS blip, not a rejection).
    await fakePve.close();

    const me = await app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie } });
    expect(me.statusCode).toBe(200);
    expect(me.json()).toEqual({
      username: 'root@pam',
      realm: 'pam',
      capabilities: { vms: { 'VM.Audit': 1 } },
      mode: 'session',
    });

    // Session kept as-is (same ticket, lastRenewedAt untouched) so the next
    // request retries renewal rather than the caller being logged out.
    const after = app.sessionStore.get(sid)!;
    expect(after).toBeDefined();
    expect(after.ticket).toBe(before.ticket);
    expect(after.lastRenewedAt).toBe(staleRenewedAt);
  });

  describe('GET /api/auth/me in token mode', () => {
    it('returns the token identity when token mode is on, a token is configured, and there is no session', async () => {
      fakePve = await startFakePve();
      app = await buildApp({
        config: loadConfig({
          NODE_ENV: 'test',
          PVE_URL: fakePve.url,
          PROXION_ALLOW_TOKEN_MODE: 'true',
          PVE_TOKEN_ID: 'proxion@pve!dev',
          PVE_TOKEN_SECRET: 'shh',
        }),
      });
      const response = await app.inject({ method: 'GET', url: '/api/auth/me' });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({
        username: 'proxion@pve!dev',
        realm: 'token',
        capabilities: {},
        mode: 'token',
      });
    });

    it('still returns 401 with token mode on but no token configured', async () => {
      fakePve = await startFakePve();
      app = await buildApp({
        config: loadConfig({
          NODE_ENV: 'test',
          PVE_URL: fakePve.url,
          PROXION_ALLOW_TOKEN_MODE: 'true',
        }),
      });
      const response = await app.inject({ method: 'GET', url: '/api/auth/me' });
      expect(response.statusCode).toBe(401);
    });

    it('still returns 401 with a token configured but token mode off', async () => {
      fakePve = await startFakePve();
      app = await buildApp({
        config: loadConfig({
          NODE_ENV: 'test',
          PVE_URL: fakePve.url,
          PROXION_ALLOW_TOKEN_MODE: 'false',
          PVE_TOKEN_ID: 'proxion@pve!dev',
          PVE_TOKEN_SECRET: 'shh',
        }),
      });
      const response = await app.inject({ method: 'GET', url: '/api/auth/me' });
      expect(response.statusCode).toBe(401);
    });

    it('prefers a real session over the token identity when both are available', async () => {
      fakePve = await startFakePve();
      app = await buildApp({
        config: loadConfig({
          NODE_ENV: 'test',
          PVE_URL: fakePve.url,
          PROXION_ALLOW_TOKEN_MODE: 'true',
          PVE_TOKEN_ID: 'proxion@pve!dev',
          PVE_TOKEN_SECRET: 'shh',
        }),
      });
      const login = await app.inject({
        method: 'POST',
        url: '/api/auth/login',
        payload: { username: 'root@pam', password: 'goodpass' },
      });
      const cookie = cookieFrom(login.headers['set-cookie']);

      const me = await app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie } });
      expect(me.statusCode).toBe(200);
      expect(me.json()).toEqual({
        username: 'root@pam',
        realm: 'pam',
        capabilities: { vms: { 'VM.Audit': 1 } },
        mode: 'session',
      });
    });
  });
});
