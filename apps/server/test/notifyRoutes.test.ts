import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { startFakePve, type FakePve } from './helpers/fakePve.js';

function cookieFrom(setCookieHeader: string | string[] | undefined): string {
  const raw = Array.isArray(setCookieHeader) ? setCookieHeader[0] : setCookieHeader;
  if (!raw) throw new Error('no Set-Cookie header');
  return raw.split(';')[0]!;
}

/** A tiny local HTTP server standing in for a real webhook endpoint -- never a real external
 *  service, per the ticket's "never call a real ... webhook endpoint in tests". */
async function startFakeWebhookTarget(
  status = 200,
): Promise<{ baseUrl: string; requestCount: () => number; close: () => Promise<void> }> {
  let count = 0;
  const server = http.createServer((req, res) => {
    count += 1;
    req.resume();
    req.on('end', () => {
      res.writeHead(status);
      res.end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    requestCount: () => count,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

describe('/api/notify', () => {
  let fakePve: FakePve;
  let app: FastifyInstance;
  let webhookTarget: { baseUrl: string; requestCount: () => number; close: () => Promise<void> } | undefined;

  afterEach(async () => {
    await app?.close();
    await fakePve?.close();
    await webhookTarget?.close();
    webhookTarget = undefined;
  });

  async function setup(extraEnv: Record<string, string> = {}) {
    fakePve = await startFakePve();
    app = await buildApp({ config: loadConfig({ NODE_ENV: 'test', PVE_URL: fakePve.url, ...extraEnv }) });
  }

  async function loginCookie(): Promise<string> {
    const login = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { username: 'root@pam', password: 'goodpass' },
    });
    return cookieFrom(login.headers['set-cookie']);
  }

  it('GET /api/notify/status is 401 with no identity', async () => {
    await setup();
    const res = await app.inject({ method: 'GET', url: '/api/notify/status' });
    expect(res.statusCode).toBe(401);
  });

  it('GET /api/notify/status: nothing configured', async () => {
    await setup();
    const cookie = await loginCookie();
    const res = await app.inject({ method: 'GET', url: '/api/notify/status', headers: { cookie } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      configured: { webhook: false, email: false },
      minSeverity: 'warning',
      includeResolved: true,
    });
  });

  it('GET /api/notify/status: reports configured channels and settings, with no secrets in the body', async () => {
    webhookTarget = await startFakeWebhookTarget();
    await setup({
      PROXION_NOTIFY_WEBHOOK_URL: webhookTarget.baseUrl,
      PROXION_NOTIFY_WEBHOOK_TOKEN: 'super-secret-token-value',
      PROXION_NOTIFY_MIN_SEVERITY: 'error',
      PROXION_NOTIFY_INCLUDE_RESOLVED: 'false',
    });
    const cookie = await loginCookie();
    const res = await app.inject({ method: 'GET', url: '/api/notify/status', headers: { cookie } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      configured: { webhook: true, email: false },
      minSeverity: 'error',
      includeResolved: false,
    });
    expect(res.body).not.toContain('super-secret-token-value');
    expect(res.body).not.toContain(webhookTarget.baseUrl);
  });

  it('GET /api/notify/status works for token-mode identities too', async () => {
    await setup({
      PVE_TOKEN_ID: 'root@pam!proxion',
      PVE_TOKEN_SECRET: 'tokensecret',
      PROXION_ALLOW_TOKEN_MODE: 'true',
    });
    const res = await app.inject({ method: 'GET', url: '/api/notify/status' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ configured: { webhook: false, email: false } });
  });

  it('POST /api/notify/test is 401 with no identity', async () => {
    await setup();
    const res = await app.inject({ method: 'POST', url: '/api/notify/test' });
    expect(res.statusCode).toBe(401);
  });

  it('POST /api/notify/test is 403 in token mode', async () => {
    webhookTarget = await startFakeWebhookTarget();
    await setup({
      PVE_TOKEN_ID: 'root@pam!proxion',
      PVE_TOKEN_SECRET: 'tokensecret',
      PROXION_ALLOW_TOKEN_MODE: 'true',
      PROXION_NOTIFY_WEBHOOK_URL: webhookTarget.baseUrl,
    });
    const res = await app.inject({ method: 'POST', url: '/api/notify/test' });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ error: 'writes-disabled-in-token-mode' });
  });

  it('POST /api/notify/test is 400 not-configured when no channel is set up', async () => {
    await setup();
    const cookie = await loginCookie();
    const res = await app.inject({ method: 'POST', url: '/api/notify/test', headers: { cookie } });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: 'not-configured' });
  });

  it('POST /api/notify/test sends through the configured webhook and reports ok', async () => {
    webhookTarget = await startFakeWebhookTarget(200);
    await setup({ PROXION_NOTIFY_WEBHOOK_URL: webhookTarget.baseUrl });
    const cookie = await loginCookie();

    const res = await app.inject({ method: 'POST', url: '/api/notify/test', headers: { cookie } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ results: { webhook: 'ok' } });
    expect(webhookTarget.requestCount()).toBe(1);
  });

  it('POST /api/notify/test reports a sanitised failure when the webhook target rejects', async () => {
    webhookTarget = await startFakeWebhookTarget(503);
    await setup({ PROXION_NOTIFY_WEBHOOK_URL: webhookTarget.baseUrl });
    const cookie = await loginCookie();

    const res = await app.inject({ method: 'POST', url: '/api/notify/test', headers: { cookie } });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { results: { webhook: string } };
    expect(body.results.webhook).not.toBe('ok');
    expect(body.results.webhook).toContain('503');
  });

  it('rate-limits POST /api/notify/test to 5/min per session', async () => {
    webhookTarget = await startFakeWebhookTarget();
    await setup({ PROXION_NOTIFY_WEBHOOK_URL: webhookTarget.baseUrl });
    const cookie = await loginCookie();

    for (let i = 0; i < 5; i++) {
      const res = await app.inject({ method: 'POST', url: '/api/notify/test', headers: { cookie } });
      expect(res.statusCode).toBe(200);
    }
    const blocked = await app.inject({ method: 'POST', url: '/api/notify/test', headers: { cookie } });
    expect(blocked.statusCode).toBe(429);
  });
});
