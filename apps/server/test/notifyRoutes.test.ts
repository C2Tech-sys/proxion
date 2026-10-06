import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
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

  describe('an invalid PROXION_NOTIFY_* value (T59)', () => {
    const BAD = { PROXION_NOTIFY_WEBHOOK_FORMAT: 'proxion-alertxnt' };
    const MESSAGE =
      'PROXION_NOTIFY_WEBHOOK_FORMAT: expected one of generic|discord|slack|ntfy|gotify (got "proxion-alertxnt")';

    it('still boots, GET /api/notify/status carries the error, and nothing is configured', async () => {
      webhookTarget = await startFakeWebhookTarget();
      await setup({ ...BAD, PROXION_NOTIFY_WEBHOOK_URL: webhookTarget.baseUrl });
      expect(app.notifier).toBeUndefined();
      const cookie = await loginCookie();
      const res = await app.inject({ method: 'GET', url: '/api/notify/status', headers: { cookie } });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({
        configured: { webhook: false, email: false },
        minSeverity: 'warning',
        includeResolved: true,
        error: MESSAGE,
      });
    });

    it('POST /api/notify/test is 400 not-configured (with the message)', async () => {
      await setup(BAD);
      const cookie = await loginCookie();
      const res = await app.inject({ method: 'POST', url: '/api/notify/test', headers: { cookie } });
      expect(res.statusCode).toBe(400);
      expect(res.json()).toEqual({ error: 'not-configured', message: MESSAGE });
    });

    it('a good config has no `error` key in the status body', async () => {
      await setup();
      const cookie = await loginCookie();
      const res = await app.inject({ method: 'GET', url: '/api/notify/status', headers: { cookie } });
      expect(res.json()).not.toHaveProperty('error');
    });

    it('logs exactly one startup warning, "Notifications disabled: <message>"', async () => {
      // The app logger is `silent` under NODE_ENV=test, so build with `development` (info level)
      // and capture what pino's stdout destination (sonic-boom) hands to fs.write/fs.writeSync.
      const chunks: string[] = [];
      const record = (data: unknown) => {
        if (typeof data === 'string') chunks.push(data);
        else if (Buffer.isBuffer(data)) chunks.push(data.toString('utf8'));
      };
      // Swallowed rather than passed through, so the captured lines don't also spam the test output.
      const byteLength = (data: unknown) => Buffer.byteLength(typeof data === 'string' ? data : (data as Buffer));
      const syncSpy = vi.spyOn(fs, 'writeSync').mockImplementation(((...args: unknown[]) => {
        record(args[1]);
        return byteLength(args[1]);
      }) as typeof fs.writeSync);
      const asyncSpy = vi.spyOn(fs, 'write').mockImplementation(((...args: unknown[]) => {
        record(args[1]);
        const callback = args[args.length - 1];
        if (typeof callback === 'function') callback(null, byteLength(args[1]));
      }) as typeof fs.write);
      fakePve = await startFakePve();
      try {
        app = await buildApp({
          config: loadConfig({ NODE_ENV: 'development', SESSION_SECRET: 'x'.repeat(32), PVE_URL: fakePve.url, ...BAD }),
        });
        // Let an asynchronous (non-sync) destination flush before the spies come off.
        await new Promise((resolve) => setTimeout(resolve, 50));
      } finally {
        syncSpy.mockRestore();
        asyncSpy.mockRestore();
      }
      const lines = chunks
        .join('')
        .split('\n')
        .filter((line) => line.startsWith('{'));
      const warns = lines
        .map((line) => JSON.parse(line) as { level: number; msg: string })
        .filter((entry) => entry.msg.startsWith('Notifications disabled'));
      expect(warns).toHaveLength(1);
      expect(warns[0]).toMatchObject({ level: 40, msg: `Notifications disabled: ${MESSAGE}` });
      expect(lines.join('')).not.toContain('Proxion notification channels');
    });
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
