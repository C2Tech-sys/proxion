import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
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

  // --- T64: runtime-editable settings ---------------------------------------------------------
  describe('notification settings (T64)', () => {
    interface RecordedRequest {
      url: string;
      authorization: string | undefined;
      body: string;
    }
    const targets: Array<{ close: () => Promise<void> }> = [];

    afterEach(async () => {
      for (const target of targets.splice(0)) await target.close();
    });

    async function startRecordingTarget(): Promise<{
      baseUrl: string;
      host: string;
      requests: RecordedRequest[];
    }> {
      const requests: RecordedRequest[] = [];
      const server = http.createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on('data', (chunk: Buffer) => chunks.push(chunk));
        req.on('end', () => {
          requests.push({
            url: req.url ?? '',
            authorization: req.headers.authorization,
            body: Buffer.concat(chunks).toString('utf8'),
          });
          res.writeHead(200);
          res.end();
        });
      });
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      const { port } = server.address() as AddressInfo;
      targets.push({ close: () => new Promise<void>((resolve) => server.close(() => resolve())) });
      return { baseUrl: `http://127.0.0.1:${port}`, host: `127.0.0.1:${port}`, requests };
    }

    const BASE_BODY = {
      enabled: true,
      mutedKinds: [] as string[],
      minSeverity: 'warning',
      includeResolved: true,
      debounceMs: 10_000,
      siteName: 'Proxion',
    };
    const TOKEN_MODE_ENV = {
      PVE_TOKEN_ID: 'root@pam!proxion',
      PVE_TOKEN_SECRET: 'tokensecret',
      PROXION_ALLOW_TOKEN_MODE: 'true',
    };
    const SMTP_WITH_PASSWORD = 'smtps://mailuser:S3cretPw@smtp.example.com:465';
    const EMAIL_ENV = {
      PROXION_NOTIFY_SMTP_URL: SMTP_WITH_PASSWORD,
      PROXION_NOTIFY_EMAIL_FROM: 'proxion@example.com',
      PROXION_NOTIFY_EMAIL_TO: 'a@example.com, b@example.com',
    };

    /** A signed-in cookie for a caller who holds `Sys.Modify` on `/`. */
    async function setupAdmin(extraEnv: Record<string, string> = {}): Promise<string> {
      await setup(extraEnv);
      fakePve.setRootPermissions({ 'Sys.Modify': true });
      return loginCookie();
    }

    function put(cookie: string | undefined, payload: unknown) {
      return app.inject({
        method: 'PUT',
        url: '/api/notify/settings',
        ...(cookie ? { headers: { cookie } } : {}),
        payload: payload as Record<string, unknown>,
      });
    }

    function getSettings(cookie: string) {
      return app.inject({ method: 'GET', url: '/api/notify/settings', headers: { cookie } });
    }

    function mute(cookie: string | undefined, payload: unknown) {
      return app.inject({
        method: 'POST',
        url: '/api/notify/mute',
        ...(cookie ? { headers: { cookie } } : {}),
        payload: payload as Record<string, unknown>,
      });
    }

    function savedFile(): Record<string, unknown> {
      const dataDir = path.resolve(process.cwd(), app.proxionConfig.PROXION_DATA_DIR);
      return JSON.parse(fs.readFileSync(path.join(dataDir, 'notify-settings.json'), 'utf8')) as Record<string, unknown>;
    }

    it('GET /api/notify/settings is 401 with no identity', async () => {
      await setup();
      const res = await app.inject({ method: 'GET', url: '/api/notify/settings' });
      expect(res.statusCode).toBe(401);
    });

    it('GET /api/notify/settings: nothing configured reports the env defaults', async () => {
      await setup();
      const res = await getSettings(await loginCookie());
      expect(res.statusCode).toBe(200);
      expect(res.json()).toStrictEqual({
        source: 'env',
        enabled: true,
        mutedKinds: [],
        minSeverity: 'warning',
        includeResolved: true,
        debounceMs: 10_000,
        siteName: 'Proxion',
        channels: { webhook: false, email: false },
      });
    });

    it('GET /api/notify/settings masks every secret: host only, token presence, no SMTP password', async () => {
      const target = await startRecordingTarget();
      await setup({
        PROXION_NOTIFY_WEBHOOK_URL: `${target.baseUrl}/hooks/SECRET-PATH-123?key=SECRET-QUERY`,
        PROXION_NOTIFY_WEBHOOK_FORMAT: 'ntfy',
        PROXION_NOTIFY_WEBHOOK_TOKEN: 'super-secret-token-value',
        ...EMAIL_ENV,
        PROXION_PUBLIC_URL: 'https://proxion.example.com',
      });
      const res = await getSettings(await loginCookie());
      expect(res.statusCode).toBe(200);
      expect(res.json()).toStrictEqual({
        source: 'env',
        enabled: true,
        mutedKinds: [],
        minSeverity: 'warning',
        includeResolved: true,
        debounceMs: 10_000,
        siteName: 'Proxion',
        publicUrl: 'https://proxion.example.com',
        webhook: { url: { host: target.host, masked: true }, format: 'ntfy', token: { set: true } },
        email: {
          smtpUrl: { host: 'smtp.example.com', port: 465, secure: true, user: 'mailuser', set: true },
          from: 'proxion@example.com',
          to: ['a@example.com', 'b@example.com'],
        },
        channels: { webhook: true, email: true },
      });
      for (const secret of ['SECRET-PATH-123', 'SECRET-QUERY', 'super-secret-token-value', 'S3cretPw']) {
        expect(res.body).not.toContain(secret);
      }
    });

    it('GET /api/notify/settings works in token mode', async () => {
      await setup(TOKEN_MODE_ENV);
      const res = await app.inject({ method: 'GET', url: '/api/notify/settings' });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ source: 'env', channels: { webhook: false, email: false } });
    });

    it('the env error is part of the settings view while the env is in force', async () => {
      await setup({ PROXION_NOTIFY_WEBHOOK_FORMAT: 'nope' });
      const res = await getSettings(await loginCookie());
      expect((res.json() as { error?: string }).error).toContain('PROXION_NOTIFY_WEBHOOK_FORMAT');
    });

    describe('write gating', () => {
      it('PUT and POST /mute are 401 with no identity', async () => {
        await setup();
        expect((await put(undefined, BASE_BODY)).statusCode).toBe(401);
        expect((await mute(undefined, { for: '1h' })).statusCode).toBe(401);
      });

      it('PUT and POST /mute are 403 in token mode, before any permission lookup', async () => {
        await setup(TOKEN_MODE_ENV);
        const requestsBefore = fakePve.requestCount;
        const putRes = await put(undefined, BASE_BODY);
        const muteRes = await mute(undefined, { for: '1h' });
        expect(putRes.statusCode).toBe(403);
        expect(putRes.json()).toStrictEqual({ error: 'writes-disabled-in-token-mode' });
        expect(muteRes.statusCode).toBe(403);
        expect(muteRes.json()).toStrictEqual({ error: 'writes-disabled-in-token-mode' });
        expect(fakePve.requestCount).toBe(requestsBefore);
        expect(app.notifySettingsStore.current).toBeUndefined();
      });

      it('PUT and POST /mute are 403 without Sys.Modify on /, and nothing is written', async () => {
        await setup();
        const cookie = await loginCookie(); // root perms default to none in the fake
        const putRes = await put(cookie, BASE_BODY);
        const muteRes = await mute(cookie, { for: '1h' });
        expect(putRes.statusCode).toBe(403);
        expect(putRes.json()).toStrictEqual({ error: 'forbidden', missing: ['Sys.Modify'] });
        expect(muteRes.statusCode).toBe(403);
        expect(muteRes.json()).toStrictEqual({ error: 'forbidden', missing: ['Sys.Modify'] });
        expect(app.notifySettingsStore.current).toBeUndefined();
      });

      it('another Sys privilege on / is not enough', async () => {
        await setup();
        fakePve.setRootPermissions({ 'Sys.Audit': true });
        expect((await put(await loginCookie(), BASE_BODY)).statusCode).toBe(403);
      });
    });

    describe('PUT validation', () => {
      const CASES: Array<[string, Record<string, unknown>, string]> = [
        ['an unknown key', { ...BASE_BODY, bogus: 1 }, 'body'],
        ['a missing field', { enabled: true }, 'mutedKinds'],
        ['an unknown alert kind', { ...BASE_BODY, mutedKinds: ['nonsense'] }, 'mutedKinds'],
        ['a debounce below 1 s', { ...BASE_BODY, debounceMs: 999 }, 'debounceMs'],
        ['a debounce above 10 min', { ...BASE_BODY, debounceMs: 600_001 }, 'debounceMs'],
        ['an empty site name', { ...BASE_BODY, siteName: '' }, 'siteName'],
        ['an over-long site name', { ...BASE_BODY, siteName: 'x'.repeat(65) }, 'siteName'],
        ['a bad severity', { ...BASE_BODY, minSeverity: 'info' }, 'minSeverity'],
        ['a non-http public URL', { ...BASE_BODY, publicUrl: 'ftp://x.example.com' }, 'publicUrl'],
        ['a non-http webhook URL', { ...BASE_BODY, webhook: { url: 'file:///etc/passwd', format: 'generic' } }, 'webhook.url'],
        ['a bad webhook format', { ...BASE_BODY, webhook: { url: 'https://x.example.com', format: 'teams' } }, 'webhook.format'],
        [
          'a non-smtp SMTP URL',
          { ...BASE_BODY, email: { smtpUrl: 'http://x.example.com', from: 'a@b.c', to: ['d@e.f'] } },
          'email.smtpUrl',
        ],
        [
          'an empty recipient list',
          { ...BASE_BODY, email: { smtpUrl: 'smtp://x.example.com', from: 'a@b.c', to: [] } },
          'email.to',
        ],
        ['a keep sentinel with nothing stored (url)', { ...BASE_BODY, webhook: { url: { keep: true }, format: 'generic' } }, 'no stored webhook URL'],
        [
          'a keep sentinel with nothing stored (smtp)',
          { ...BASE_BODY, email: { smtpUrl: { keep: true }, from: 'a@b.c', to: ['d@e.f'] } },
          'no stored SMTP URL',
        ],
        ['a malformed muteUntil', { ...BASE_BODY, muteUntil: 'tomorrow' }, 'muteUntil'],
      ];

      for (const [label, payload, fragment] of CASES) {
        it(`400 for ${label}`, async () => {
          const cookie = await setupAdmin();
          const res = await put(cookie, payload);
          expect(res.statusCode).toBe(400);
          const body = res.json() as { error: string; message: string };
          expect(body.error).toBe('invalid-settings');
          expect(body.message).toContain(fragment);
          expect(app.notifySettingsStore.current).toBeUndefined();
        });
      }

      it('never echoes a submitted secret back in a 400', async () => {
        const cookie = await setupAdmin();
        const res = await put(cookie, {
          ...BASE_BODY,
          debounceMs: 1,
          webhook: { url: 'ftp://hooks.example.com/SECRET-IN-BODY', format: 'generic', token: 'TOKEN-IN-BODY' },
        });
        expect(res.statusCode).toBe(400);
        expect(res.body).not.toContain('SECRET-IN-BODY');
        expect(res.body).not.toContain('TOKEN-IN-BODY');
      });
    });

    describe('PUT and hot reload', () => {
      it('saves, answers with the masked view and writes the file with the secrets', async () => {
        const target = await startRecordingTarget();
        const cookie = await setupAdmin();
        const res = await put(cookie, {
          ...BASE_BODY,
          mutedKinds: ['storage', 'backup'],
          minSeverity: 'error',
          includeResolved: false,
          debounceMs: 30_000,
          siteName: 'Rack 4',
          publicUrl: 'https://proxion.example.com',
          webhook: { url: `${target.baseUrl}/hooks/SECRET-PATH-123`, format: 'gotify', token: 'tok-new-1' },
          email: { smtpUrl: SMTP_WITH_PASSWORD, from: 'proxion@example.com', to: ['a@example.com'] },
        });
        expect(res.statusCode).toBe(200);
        expect(res.json()).toStrictEqual({
          source: 'file',
          enabled: true,
          mutedKinds: ['backup', 'storage'],
          minSeverity: 'error',
          includeResolved: false,
          debounceMs: 30_000,
          siteName: 'Rack 4',
          publicUrl: 'https://proxion.example.com',
          webhook: { url: { host: target.host, masked: true }, format: 'gotify', token: { set: true } },
          email: {
            smtpUrl: { host: 'smtp.example.com', port: 465, secure: true, user: 'mailuser', set: true },
            from: 'proxion@example.com',
            to: ['a@example.com'],
          },
          channels: { webhook: true, email: true },
        });
        for (const secret of ['SECRET-PATH-123', 'tok-new-1', 'S3cretPw']) expect(res.body).not.toContain(secret);

        expect(savedFile()).toStrictEqual({
          version: 1,
          enabled: true,
          mutedKinds: ['backup', 'storage'],
          minSeverity: 'error',
          includeResolved: false,
          debounceMs: 30_000,
          siteName: 'Rack 4',
          publicUrl: 'https://proxion.example.com',
          webhook: { url: `${target.baseUrl}/hooks/SECRET-PATH-123`, format: 'gotify', token: 'tok-new-1' },
          email: { smtpUrl: SMTP_WITH_PASSWORD, from: 'proxion@example.com', to: ['a@example.com'] },
        });

        // A later GET (and the status route) read the same thing.
        expect(((await getSettings(cookie)).json() as { source: string }).source).toBe('file');
        const status = await app.inject({ method: 'GET', url: '/api/notify/status', headers: { cookie } });
        expect(status.json()).toStrictEqual({
          configured: { webhook: true, email: true },
          minSeverity: 'error',
          includeResolved: false,
        });
      });

      it('swaps the channels without a restart: the next test message goes to the new webhook', async () => {
        const before = await startRecordingTarget();
        const after = await startRecordingTarget();
        const cookie = await setupAdmin({ PROXION_NOTIFY_WEBHOOK_URL: before.baseUrl });
        const oldNotifier = app.notifier;
        expect(oldNotifier).toBeDefined();

        const res = await put(cookie, {
          ...BASE_BODY,
          webhook: { url: after.baseUrl, format: 'generic', token: 'new-bearer' },
        });
        expect(res.statusCode).toBe(200);
        expect(app.notifier).toBeDefined();
        expect(app.notifier).not.toBe(oldNotifier);

        const test = await app.inject({ method: 'POST', url: '/api/notify/test', headers: { cookie } });
        expect(test.json()).toStrictEqual({ results: { webhook: 'ok' } });
        expect(before.requests).toHaveLength(0);
        expect(after.requests).toHaveLength(1);
        expect(after.requests[0]?.authorization).toBe('Bearer new-bearer');
      });

      it('removing every channel drops the notifier; adding one brings it back', async () => {
        const target = await startRecordingTarget();
        const cookie = await setupAdmin({ PROXION_NOTIFY_WEBHOOK_URL: target.baseUrl });
        expect((await put(cookie, { ...BASE_BODY, webhook: null, email: null })).statusCode).toBe(200);
        expect(app.notifier).toBeUndefined();
        const test = await app.inject({ method: 'POST', url: '/api/notify/test', headers: { cookie } });
        expect(test.statusCode).toBe(400);
        expect(test.json()).toStrictEqual({ error: 'not-configured' });

        expect((await put(cookie, { ...BASE_BODY, webhook: { url: target.baseUrl, format: 'generic' } })).statusCode).toBe(200);
        expect(app.notifier).toBeDefined();
      });

      it('a settings file makes a broken environment irrelevant (T59 error no longer reported)', async () => {
        const target = await startRecordingTarget();
        const cookie = await setupAdmin({ PROXION_NOTIFY_WEBHOOK_FORMAT: 'nope' });
        expect(app.notifier).toBeUndefined();
        const res = await put(cookie, { ...BASE_BODY, webhook: { url: target.baseUrl, format: 'generic' } });
        expect(res.statusCode).toBe(200);
        expect(res.json()).not.toHaveProperty('error');
        expect(app.notifier).toBeDefined();
      });

      it('survives a restart: a new app over the same data dir boots from the file', async () => {
        const target = await startRecordingTarget();
        const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'proxion-notify-restart-'));
        try {
          const cookie = await setupAdmin({ PROXION_DATA_DIR: dataDir });
          await put(cookie, { ...BASE_BODY, siteName: 'Persisted', webhook: { url: target.baseUrl, format: 'slack' } });
          await app.close();

          app = await buildApp({
            config: loadConfig({ NODE_ENV: 'test', PVE_URL: fakePve.url, PROXION_DATA_DIR: dataDir }),
          });
          expect(app.notifier).toBeDefined();
          const res = await getSettings(await loginCookie());
          expect(res.json()).toMatchObject({
            source: 'file',
            siteName: 'Persisted',
            webhook: { url: { host: target.host }, format: 'slack' },
          });
        } finally {
          fs.rmSync(dataDir, { recursive: true, force: true });
        }
      });

      it('applies mutedKinds to what is actually sent after the reload', async () => {
        const target = await startRecordingTarget();
        const cookie = await setupAdmin();
        const res = await put(cookie, {
          ...BASE_BODY,
          debounceMs: 1000,
          mutedKinds: ['backup'],
          webhook: { url: target.baseUrl, format: 'generic' },
        });
        expect(res.statusCode).toBe(200);
        const notifier = app.notifier!;
        notifier.onAlerts([]); // first-run summary
        await notifier.flushForTest();
        const at = Math.floor(Date.now() / 1000);
        notifier.onAlerts([
          { id: 'backup:1', kind: 'backup', severity: 'error', title: 'MUTED-BACKUP-ALERT', at },
          { id: 'storage:1', kind: 'storage', severity: 'error', title: 'VISIBLE-STORAGE-ALERT', at },
        ]);
        await notifier.flushForTest();
        await vi.waitFor(() => expect(target.requests.length).toBeGreaterThanOrEqual(2), { timeout: 5000 });
        const bodies = target.requests.map((r) => r.body).join('\n');
        expect(bodies).toContain('VISIBLE-STORAGE-ALERT');
        expect(bodies).not.toContain('MUTED-BACKUP-ALERT');
      });
    });

    describe('secrets: keep sentinels', () => {
      it('{ keep: true } leaves the stored token, webhook address and SMTP URL untouched', async () => {
        const target = await startRecordingTarget();
        const cookie = await setupAdmin();
        const first = await put(cookie, {
          ...BASE_BODY,
          webhook: { url: `${target.baseUrl}/hooks/ABC`, format: 'generic', token: 'stored-token' },
          email: { smtpUrl: SMTP_WITH_PASSWORD, from: 'proxion@example.com', to: ['a@example.com'] },
        });
        expect(first.statusCode).toBe(200);
        const stored = savedFile();

        const second = await put(cookie, {
          ...BASE_BODY,
          siteName: 'Renamed',
          webhook: { url: { keep: true }, format: 'discord', token: { keep: true } },
          email: { smtpUrl: { keep: true }, from: 'other@example.com', to: ['a@example.com', 'c@example.com'] },
        });
        expect(second.statusCode).toBe(200);
        expect(savedFile()).toStrictEqual({
          ...stored,
          siteName: 'Renamed',
          webhook: { url: `${target.baseUrl}/hooks/ABC`, format: 'discord', token: 'stored-token' },
          email: { smtpUrl: SMTP_WITH_PASSWORD, from: 'other@example.com', to: ['a@example.com', 'c@example.com'] },
        });
        expect((second.json() as { webhook: { token: unknown } }).webhook.token).toStrictEqual({ set: true });
      });

      it('token: null (or omitted) clears the stored token', async () => {
        const target = await startRecordingTarget();
        const cookie = await setupAdmin();
        await put(cookie, { ...BASE_BODY, webhook: { url: target.baseUrl, format: 'ntfy', token: 'to-clear' } });

        const cleared = await put(cookie, {
          ...BASE_BODY,
          webhook: { url: { keep: true }, format: 'ntfy', token: null },
        });
        expect(cleared.statusCode).toBe(200);
        expect((cleared.json() as { webhook: { token: unknown } }).webhook.token).toStrictEqual({ set: false });
        expect(savedFile().webhook).toStrictEqual({ url: target.baseUrl, format: 'ntfy' });
      });

      it('a kept token is refused when the webhook address changes (it would be sent to the new host)', async () => {
        const original = await startRecordingTarget();
        const elsewhere = await startRecordingTarget();
        const cookie = await setupAdmin();
        await put(cookie, { ...BASE_BODY, webhook: { url: original.baseUrl, format: 'generic', token: 'stored-token' } });

        const res = await put(cookie, {
          ...BASE_BODY,
          webhook: { url: elsewhere.baseUrl, format: 'generic', token: { keep: true } },
        });
        expect(res.statusCode).toBe(400);
        expect((res.json() as { message: string }).message).toContain('webhook.token');
        expect(res.body).not.toContain('stored-token');
        expect(savedFile().webhook).toStrictEqual({ url: original.baseUrl, format: 'generic', token: 'stored-token' });
      });

      it('keeps work against env-sourced values too (they are copied into the file)', async () => {
        const target = await startRecordingTarget();
        const cookie = await setupAdmin({
          PROXION_NOTIFY_WEBHOOK_URL: `${target.baseUrl}/env-hook`,
          PROXION_NOTIFY_WEBHOOK_TOKEN: 'env-token',
          ...EMAIL_ENV,
        });
        const res = await put(cookie, {
          ...BASE_BODY,
          mutedKinds: ['task'],
          webhook: { url: { keep: true }, format: 'generic', token: { keep: true } },
          email: { smtpUrl: { keep: true }, from: 'proxion@example.com', to: ['a@example.com', 'b@example.com'] },
        });
        expect(res.statusCode).toBe(200);
        expect((res.json() as { source: string }).source).toBe('file');
        expect(savedFile()).toMatchObject({
          mutedKinds: ['task'],
          webhook: { url: `${target.baseUrl}/env-hook`, token: 'env-token' },
          email: { smtpUrl: SMTP_WITH_PASSWORD },
        });
      });
    });

    describe('snooze and the test button', () => {
      it('POST /mute sets muteUntil for the requested span and persists the rest unchanged', async () => {
        const target = await startRecordingTarget();
        const cookie = await setupAdmin({ PROXION_NOTIFY_WEBHOOK_URL: target.baseUrl, PROXION_NOTIFY_SITE_NAME: 'Lab' });
        for (const [span, ms] of [
          ['1h', 3_600_000],
          ['8h', 8 * 3_600_000],
          ['24h', 24 * 3_600_000],
          ['7d', 7 * 24 * 3_600_000],
        ] as const) {
          const before = Date.now();
          const res = await mute(cookie, { for: span });
          const after = Date.now();
          expect(res.statusCode).toBe(200);
          const body = res.json() as { muteUntil: string; source: string; siteName: string };
          expect(body.source).toBe('file');
          expect(body.siteName).toBe('Lab');
          const until = Date.parse(body.muteUntil);
          expect(until).toBeGreaterThanOrEqual(before + ms);
          expect(until).toBeLessThanOrEqual(after + ms);
          expect(savedFile().muteUntil).toBe(body.muteUntil);
        }
        // the env webhook was carried over into the file
        expect(savedFile().webhook).toStrictEqual({ url: target.baseUrl, format: 'generic' });
      });

      it('POST /mute { for: null } clears the snooze; GET only reports a mute that is still in the future', async () => {
        const cookie = await setupAdmin();
        await mute(cookie, { for: '1h' });
        expect((await getSettings(cookie)).json()).toHaveProperty('muteUntil');
        const cleared = await mute(cookie, { for: null });
        expect(cleared.statusCode).toBe(200);
        expect(cleared.json()).not.toHaveProperty('muteUntil');
        expect(savedFile()).not.toHaveProperty('muteUntil');

        // an already-expired muteUntil in the file is not reported
        await put(cookie, { ...BASE_BODY, muteUntil: '2001-01-01T00:00:00.000Z' });
        expect(savedFile().muteUntil).toBe('2001-01-01T00:00:00.000Z');
        expect((await getSettings(cookie)).json()).not.toHaveProperty('muteUntil');
      });

      it('a PUT without muteUntil keeps the current snooze; muteUntil: null clears it', async () => {
        const cookie = await setupAdmin();
        const muted = (await mute(cookie, { for: '8h' })).json() as { muteUntil: string };
        const kept = await put(cookie, { ...BASE_BODY, siteName: 'Other' });
        expect((kept.json() as { muteUntil: string }).muteUntil).toBe(muted.muteUntil);
        const cleared = await put(cookie, { ...BASE_BODY, muteUntil: null });
        expect(cleared.json()).not.toHaveProperty('muteUntil');
      });

      it('POST /mute is 400 for an unknown span or a stray key', async () => {
        const cookie = await setupAdmin();
        expect((await mute(cookie, { for: '2h' })).statusCode).toBe(400);
        expect((await mute(cookie, {})).statusCode).toBe(400);
        expect((await mute(cookie, { for: '1h', extra: true })).statusCode).toBe(400);
      });

      it('POST /api/notify/test still sends while snoozed, switched off, and with every kind muted', async () => {
        const target = await startRecordingTarget();
        const cookie = await setupAdmin({ PROXION_NOTIFY_WEBHOOK_URL: target.baseUrl });

        await mute(cookie, { for: '24h' });
        expect((await app.inject({ method: 'POST', url: '/api/notify/test', headers: { cookie } })).json()).toStrictEqual({
          results: { webhook: 'ok' },
        });
        expect(target.requests).toHaveLength(1);

        await put(cookie, {
          ...BASE_BODY,
          enabled: false,
          mutedKinds: ['backup', 'task', 'storage'],
          webhook: { url: { keep: true }, format: 'generic' },
        });
        expect((await app.inject({ method: 'POST', url: '/api/notify/test', headers: { cookie } })).json()).toStrictEqual({
          results: { webhook: 'ok' },
        });
        expect(target.requests).toHaveLength(2);
      });

      it('enabled: false sends nothing for real alerts', async () => {
        const target = await startRecordingTarget();
        const cookie = await setupAdmin();
        await put(cookie, {
          ...BASE_BODY,
          enabled: false,
          debounceMs: 1000,
          webhook: { url: target.baseUrl, format: 'generic' },
        });
        const notifier = app.notifier!;
        notifier.onAlerts([]);
        await notifier.flushForTest();
        notifier.onAlerts([
          { id: 'storage:1', kind: 'storage', severity: 'error', title: 'SHOULD-NOT-BE-SENT', at: Math.floor(Date.now() / 1000) },
        ]);
        await notifier.flushForTest();
        await new Promise((resolve) => setTimeout(resolve, 1300));
        await notifier.flushForTest();
        expect(target.requests).toHaveLength(0);
      });
    });
  });
});
