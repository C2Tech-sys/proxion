import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance, InjectOptions } from 'fastify';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { startFakePve, type FakePve } from './helpers/fakePve.js';

describe('guest config route (rename/notes)', () => {
  let fakePve: FakePve;
  let app: FastifyInstance;

  afterEach(async () => {
    await app?.close();
    await fakePve?.close();
  });

  async function setupSession(): Promise<string> {
    fakePve = await startFakePve();
    app = await buildApp({ config: loadConfig({ NODE_ENV: 'test', PVE_URL: fakePve.url }) });

    const login = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { username: 'root', password: 'goodpass', realm: 'pam' },
    });
    const setCookie = login.headers['set-cookie'];
    const raw = Array.isArray(setCookie) ? setCookie[0] : setCookie;
    if (!raw) throw new Error('login did not set a session cookie');
    return raw.split(';')[0]!;
  }

  async function setupTokenMode(): Promise<void> {
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
  }

  function patchConfig(
    path: string,
    options: { cookie?: string; payload?: Record<string, unknown> } = {},
  ) {
    const injectOptions: InjectOptions = { method: 'PATCH', url: `/api/actions/guest${path}` };
    if (options.cookie !== undefined) injectOptions.headers = { cookie: options.cookie };
    if (options.payload !== undefined) injectOptions.payload = options.payload;
    return app.inject(injectOptions);
  }

  describe('happy path', () => {
    it('renames a qemu guest: PVE received name=', async () => {
      const cookie = await setupSession();
      fakePve.setVmPermissions(100, { 'VM.Config.Options': true });

      const res = await patchConfig('/node1/qemu/100/config', { cookie, payload: { name: 'web-01' } });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ ok: true, changed: ['name'] });

      const call = fakePve.configCalls.at(-1);
      expect(call?.path).toBe('/api2/json/nodes/node1/qemu/100/config');
      expect(call?.body).toEqual({ name: 'web-01' });
    });

    it('renames an lxc guest: PVE received hostname=', async () => {
      const cookie = await setupSession();
      fakePve.setVmPermissions(200, { 'VM.Config.Options': true });

      const res = await patchConfig('/node1/lxc/200/config', { cookie, payload: { name: 'ct-01' } });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ ok: true, changed: ['name'] });

      const call = fakePve.configCalls.at(-1);
      expect(call?.path).toBe('/api2/json/nodes/node1/lxc/200/config');
      expect(call?.body).toEqual({ hostname: 'ct-01' });
    });

    it('normalises \\r\\n to \\n and strips control characters in description', async () => {
      const cookie = await setupSession();
      fakePve.setVmPermissions(100, { 'VM.Config.Options': true });

      const res = await patchConfig('/node1/qemu/100/config', {
        cookie,
        payload: { description: 'line1\r\nline2\x07\tok' },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ ok: true, changed: ['description'] });

      const call = fakePve.configCalls.at(-1);
      expect(call?.body).toEqual({ description: 'line1\nline2\tok' });
    });

    it('accepts an empty description (clears the notes)', async () => {
      const cookie = await setupSession();
      fakePve.setVmPermissions(100, { 'VM.Config.Options': true });

      const res = await patchConfig('/node1/qemu/100/config', { cookie, payload: { description: '' } });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ ok: true, changed: ['description'] });

      const call = fakePve.configCalls.at(-1);
      expect(call?.body).toEqual({ description: '' });
    });

    it('reports both changed keys when both name and description are sent', async () => {
      const cookie = await setupSession();
      fakePve.setVmPermissions(100, { 'VM.Config.Options': true });

      const res = await patchConfig('/node1/qemu/100/config', {
        cookie,
        payload: { name: 'web-01', description: 'hello' },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ ok: true, changed: ['name', 'description'] });
    });
  });

  describe('name validation (400 invalid-name)', () => {
    async function expectInvalidName(name: string) {
      const cookie = await setupSession();
      fakePve.setVmPermissions(100, { 'VM.Config.Options': true });
      const res = await patchConfig('/node1/qemu/100/config', { cookie, payload: { name } });
      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({ error: 'invalid-name' });
    }

    it('rejects underscores/punctuation', async () => {
      await expectInvalidName('bad_name!');
    });

    it('rejects a leading hyphen', async () => {
      await expectInvalidName('-leading');
    });

    it('rejects a 64-character label', async () => {
      await expectInvalidName('a'.repeat(64));
    });

    it('rejects an empty name', async () => {
      await expectInvalidName('');
    });

    it('accepts a valid dns-name', async () => {
      const cookie = await setupSession();
      fakePve.setVmPermissions(100, { 'VM.Config.Options': true });
      const res = await patchConfig('/node1/qemu/100/config', { cookie, payload: { name: 'web-01.lab' } });
      expect(res.statusCode).toBe(200);
    });
  });

  describe('other validation (400)', () => {
    it('rejects a description over 8192 characters', async () => {
      const cookie = await setupSession();
      fakePve.setVmPermissions(100, { 'VM.Config.Options': true });
      const res = await patchConfig('/node1/qemu/100/config', {
        cookie,
        payload: { description: 'a'.repeat(8193) },
      });
      expect(res.statusCode).toBe(400);
    });

    it('rejects an empty body (no keys)', async () => {
      const cookie = await setupSession();
      fakePve.setVmPermissions(100, { 'VM.Config.Options': true });
      const res = await patchConfig('/node1/qemu/100/config', { cookie, payload: {} });
      expect(res.statusCode).toBe(400);
    });

    it('rejects an unknown key', async () => {
      const cookie = await setupSession();
      fakePve.setVmPermissions(100, { 'VM.Config.Options': true });
      const res = await patchConfig('/node1/qemu/100/config', {
        cookie,
        payload: { name: 'web-01', skiplock: true },
      });
      expect(res.statusCode).toBe(400);
    });
  });

  it('401s with no identity at all', async () => {
    fakePve = await startFakePve();
    app = await buildApp({ config: loadConfig({ NODE_ENV: 'test', PVE_URL: fakePve.url }) });
    const res = await patchConfig('/node1/qemu/100/config', { payload: { name: 'web-01' } });
    expect(res.statusCode).toBe(401);
  });

  it('403s in token mode (writes are refused for the shared token identity)', async () => {
    await setupTokenMode();
    const res = await patchConfig('/node1/qemu/100/config', { payload: { name: 'web-01' } });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ error: 'writes-disabled-in-token-mode' });
  });

  it('403s a session that lacks VM.Config.Options', async () => {
    const cookie = await setupSession();
    // No `setVmPermissions` call: VM.Config.Options is absent by default.
    const res = await patchConfig('/node1/qemu/100/config', { cookie, payload: { name: 'web-01' } });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ error: 'forbidden', missing: 'VM.Config.Options' });
  });

  it('403s a session that holds VM.PowerMgmt but not VM.Config.Options (different privilege)', async () => {
    const cookie = await setupSession();
    fakePve.setVmPermissions(100, { 'VM.PowerMgmt': true });
    const res = await patchConfig('/node1/qemu/100/config', { cookie, payload: { name: 'web-01' } });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ error: 'forbidden', missing: 'VM.Config.Options' });
  });

  it('maps a PVE 4xx to the same status with a sanitised message', async () => {
    const cookie = await setupSession();
    fakePve.setVmPermissions(100, { 'VM.Config.Options': true });
    fakePve.setConfigError('qemu', 100, 400, 'name already in use');

    const res = await patchConfig('/node1/qemu/100/config', { cookie, payload: { name: 'web-01' } });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: 'pve-rejected', message: 'name already in use' });
  });

  it('maps a PVE 5xx to 502 pve-unreachable (no PVE detail leaked)', async () => {
    const cookie = await setupSession();
    fakePve.setVmPermissions(100, { 'VM.Config.Options': true });
    fakePve.setConfigError('qemu', 100, 500, 'internal server secret detail');

    const res = await patchConfig('/node1/qemu/100/config', { cookie, payload: { name: 'web-01' } });
    expect(res.statusCode).toBe(502);
    expect(res.json()).toEqual({ error: 'pve-unreachable' });
  });

  it('logs a line with no description text', async () => {
    const cookie = await setupSession();
    fakePve.setVmPermissions(100, { 'VM.Config.Options': true });

    const infoLines: string[] = [];
    app.log.info = ((...args: unknown[]) => {
      infoLines.push(JSON.stringify(args));
    }) as typeof app.log.info;

    const secretText = 'super secret notes nobody else should see';
    const res = await patchConfig('/node1/qemu/100/config', {
      cookie,
      payload: { description: secretText },
    });
    expect(res.statusCode).toBe(200);
    expect(infoLines.some((line) => line.includes(secretText))).toBe(false);
  });

  it('shares the 30/minute bucket with the power-action route', async () => {
    const cookie = await setupSession();
    fakePve.setVmPermissions(100, { 'VM.PowerMgmt': true, 'VM.Config.Options': true });

    let last;
    for (let i = 0; i < 15; i++) {
      last = await app.inject({
        method: 'POST',
        url: '/api/actions/guest/node1/qemu/100/start',
        headers: { cookie },
      });
    }
    expect(last!.statusCode).toBe(202);

    for (let i = 0; i < 16; i++) {
      last = await patchConfig('/node1/qemu/100/config', { cookie, payload: { name: `web-${i}` } });
    }
    expect(last!.statusCode).toBe(429);
  });
});
