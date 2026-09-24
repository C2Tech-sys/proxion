import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance, InjectOptions } from 'fastify';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { startFakePve, type FakePve } from './helpers/fakePve.js';

describe('guest action routes', () => {
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

  function postAction(
    path: string,
    options: { cookie?: string; payload?: Record<string, unknown> } = {},
  ) {
    const injectOptions: InjectOptions = { method: 'POST', url: `/api/actions/guest${path}` };
    if (options.cookie !== undefined) injectOptions.headers = { cookie: options.cookie };
    if (options.payload !== undefined) injectOptions.payload = options.payload;
    return app.inject(injectOptions);
  }

  describe('validation (400)', () => {
    it('rejects an invalid guest type', async () => {
      await setupSession();
      const res = await postAction('/node1/bogus/100/start');
      expect(res.statusCode).toBe(400);
    });

    it('rejects a non-numeric vmid', async () => {
      await setupSession();
      const res = await postAction('/node1/qemu/abc/start');
      expect(res.statusCode).toBe(400);
    });

    it('rejects an invalid action', async () => {
      await setupSession();
      const res = await postAction('/node1/qemu/100/nuke');
      expect(res.statusCode).toBe(400);
    });

    it('rejects a qemu-only action (reset) for an lxc guest', async () => {
      await setupSession();
      const res = await postAction('/node1/lxc/200/reset');
      expect(res.statusCode).toBe(400);
    });

    it('rejects an unknown body field (skiplock is never accepted)', async () => {
      const cookie = await setupSession();
      fakePve.setVmPermissions(100, { 'VM.PowerMgmt': true });
      const res = await postAction('/node1/qemu/100/stop', {
        cookie,
        payload: { skiplock: true },
      });
      expect(res.statusCode).toBe(400);
    });

    it('rejects a timeout outside 1..3600', async () => {
      const cookie = await setupSession();
      fakePve.setVmPermissions(100, { 'VM.PowerMgmt': true });
      const res = await postAction('/node1/qemu/100/shutdown', {
        cookie,
        payload: { timeout: 999999 },
      });
      expect(res.statusCode).toBe(400);
    });
  });

  it('401s with no identity at all', async () => {
    fakePve = await startFakePve();
    app = await buildApp({ config: loadConfig({ NODE_ENV: 'test', PVE_URL: fakePve.url }) });
    const res = await postAction('/node1/qemu/100/start');
    expect(res.statusCode).toBe(401);
  });

  it('403s in token mode (writes are refused for the shared token identity)', async () => {
    await setupTokenMode();
    const res = await postAction('/node1/qemu/100/start');
    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ error: 'writes-disabled-in-token-mode' });
  });

  it('403s a session that lacks VM.PowerMgmt', async () => {
    const cookie = await setupSession();
    // No `setVmPermissions` call: VM.PowerMgmt is absent by default.
    const res = await postAction('/node1/qemu/100/start', { cookie });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ error: 'forbidden', missing: 'VM.PowerMgmt' });
  });

  it('succeeds: 202 with the upid, and PVE received the right POST body', async () => {
    const cookie = await setupSession();
    fakePve.setVmPermissions(100, { 'VM.PowerMgmt': true });

    const res = await postAction('/node1/qemu/100/shutdown', {
      cookie,
      payload: { forceStop: true, timeout: 120 },
    });

    expect(res.statusCode).toBe(202);
    const body = res.json() as { upid: string };
    expect(typeof body.upid).toBe('string');
    expect(body.upid.length).toBeGreaterThan(0);

    const call = fakePve.actionCalls.at(-1);
    expect(call?.path).toBe('/api2/json/nodes/node1/qemu/100/status/shutdown');
    expect(call?.body).toEqual({ forceStop: '1', timeout: '120' });
  });

  it('succeeds for a plain action with no body (start)', async () => {
    const cookie = await setupSession();
    fakePve.setVmPermissions(100, { 'VM.PowerMgmt': true });

    const res = await postAction('/node1/qemu/100/start', { cookie });
    expect(res.statusCode).toBe(202);

    const call = fakePve.actionCalls.at(-1);
    expect(call?.path).toBe('/api2/json/nodes/node1/qemu/100/status/start');
  });

  it('maps a PVE 4xx to the same status with a sanitised message', async () => {
    const cookie = await setupSession();
    fakePve.setVmPermissions(100, { 'VM.PowerMgmt': true });
    fakePve.setActionError('qemu', 100, 'start', 400, 'VM 100 is already running');

    const res = await postAction('/node1/qemu/100/start', { cookie });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: 'pve-rejected', message: 'VM 100 is already running' });
  });

  it('maps a PVE 5xx to 502 pve-unreachable (no PVE detail leaked)', async () => {
    const cookie = await setupSession();
    fakePve.setVmPermissions(100, { 'VM.PowerMgmt': true });
    fakePve.setActionError('qemu', 100, 'start', 500, 'internal server secret detail');

    const res = await postAction('/node1/qemu/100/start', { cookie });
    expect(res.statusCode).toBe(502);
    expect(res.json()).toEqual({ error: 'pve-unreachable' });
  });

  it('rate-limits at 30 requests/minute per session', async () => {
    const cookie = await setupSession();
    fakePve.setVmPermissions(100, { 'VM.PowerMgmt': true });

    let last;
    for (let i = 0; i < 31; i++) {
      last = await postAction('/node1/qemu/100/start', { cookie });
    }
    expect(last!.statusCode).toBe(429);
  });
});
