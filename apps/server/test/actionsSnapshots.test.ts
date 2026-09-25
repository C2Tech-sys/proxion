import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance, InjectOptions } from 'fastify';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { startFakePve, type FakePve } from './helpers/fakePve.js';

describe('guest snapshot routes', () => {
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

  function req(
    method: 'POST' | 'DELETE',
    path: string,
    options: { cookie?: string; payload?: Record<string, unknown> } = {},
  ) {
    const injectOptions: InjectOptions = { method, url: `/api/actions/guest${path}` };
    if (options.cookie !== undefined) injectOptions.headers = { cookie: options.cookie };
    if (options.payload !== undefined) injectOptions.payload = options.payload;
    return app.inject(injectOptions);
  }

  function create(path: string, options: { cookie?: string; payload?: Record<string, unknown> } = {}) {
    return req('POST', `${path}/snapshots`, options);
  }

  function del(path: string, snapname: string, options: { cookie?: string } = {}) {
    return req('DELETE', `${path}/snapshots/${snapname}`, options);
  }

  function rollback(
    path: string,
    snapname: string,
    options: { cookie?: string; payload?: Record<string, unknown> } = {},
  ) {
    return req('POST', `${path}/snapshots/${snapname}/rollback`, options);
  }

  describe('create: happy paths', () => {
    it('qemu: 202 with upid, and PVE received snapname/description/vmstate=1', async () => {
      const cookie = await setupSession();
      fakePve.setVmPermissions(100, { 'VM.Snapshot': true });

      const res = await create('/node1/qemu/100', {
        cookie,
        payload: { snapname: 'pre-upgrade', description: 'before the upgrade', vmstate: true },
      });

      expect(res.statusCode).toBe(202);
      const body = res.json() as { upid: string };
      expect(typeof body.upid).toBe('string');

      const call = fakePve.snapshotCalls.at(-1);
      expect(call?.method).toBe('POST');
      expect(call?.path).toBe('/api2/json/nodes/node1/qemu/100/snapshot');
      expect(call?.body).toEqual({ snapname: 'pre-upgrade', description: 'before the upgrade', vmstate: '1' });
    });

    it('lxc: 202 with upid, and PVE received snapname/description but no vmstate', async () => {
      const cookie = await setupSession();
      fakePve.setVmPermissions(200, { 'VM.Snapshot': true });

      const res = await create('/node1/lxc/200', {
        cookie,
        payload: { snapname: 'initial', description: 'base image' },
      });

      expect(res.statusCode).toBe(202);
      const call = fakePve.snapshotCalls.at(-1);
      expect(call?.path).toBe('/api2/json/nodes/node1/lxc/200/snapshot');
      expect(call?.body).toEqual({ snapname: 'initial', description: 'base image' });
    });

    it('rejects vmstate for an lxc guest (400)', async () => {
      const cookie = await setupSession();
      fakePve.setVmPermissions(200, { 'VM.Snapshot': true });

      const res = await create('/node1/lxc/200', { cookie, payload: { snapname: 'initial', vmstate: true } });
      expect(res.statusCode).toBe(400);
    });
  });

  describe('snapshot name rule', () => {
    const cases: Array<[string, boolean]> = [
      ['current', false],
      ['1abc', false],
      ['a', false],
      ['a'.repeat(41), false],
      ['bad name', false],
      ['ab', true],
      ['pre-upgrade_2', true],
      ['a'.repeat(40), true],
    ];

    for (const [name, valid] of cases) {
      it(`${valid ? 'accepts' : 'rejects'} "${name.length > 20 ? `${name.slice(0, 12)}...(len ${name.length})` : name}"`, async () => {
        const cookie = await setupSession();
        fakePve.setVmPermissions(100, { 'VM.Snapshot': true });

        const res = await create('/node1/qemu/100', { cookie, payload: { snapname: name } });
        if (valid) {
          expect(res.statusCode).toBe(202);
        } else {
          expect(res.statusCode).toBe(400);
        }
      });
    }

    it('rejects "current" for delete', async () => {
      const cookie = await setupSession();
      fakePve.setVmPermissions(100, { 'VM.Snapshot': true });
      const res = await del('/node1/qemu/100', 'current', { cookie });
      expect(res.statusCode).toBe(400);
    });

    it('rejects "current" for rollback', async () => {
      const cookie = await setupSession();
      fakePve.setVmPermissions(100, { 'VM.Snapshot.Rollback': true });
      const res = await rollback('/node1/qemu/100', 'current', { cookie });
      expect(res.statusCode).toBe(400);
    });
  });

  describe('validation (400)', () => {
    it('rejects a description over 8192 characters', async () => {
      const cookie = await setupSession();
      fakePve.setVmPermissions(100, { 'VM.Snapshot': true });

      const res = await create('/node1/qemu/100', {
        cookie,
        payload: { snapname: 'too-long', description: 'x'.repeat(8193) },
      });
      expect(res.statusCode).toBe(400);
    });

    it('rejects an unknown body field on create', async () => {
      const cookie = await setupSession();
      fakePve.setVmPermissions(100, { 'VM.Snapshot': true });

      const res = await create('/node1/qemu/100', { cookie, payload: { snapname: 'ok', bogus: true } });
      expect(res.statusCode).toBe(400);
    });

    it('rejects an unknown body field on rollback', async () => {
      const cookie = await setupSession();
      fakePve.setVmPermissions(100, { 'VM.Snapshot.Rollback': true });

      const res = await rollback('/node1/qemu/100', 'pre-upgrade', { cookie, payload: { bogus: true } });
      expect(res.statusCode).toBe(400);
    });

    it('rejects start for an lxc rollback (400)', async () => {
      const cookie = await setupSession();
      fakePve.setVmPermissions(200, { 'VM.Snapshot.Rollback': true });

      const res = await rollback('/node1/lxc/200', 'initial', { cookie, payload: { start: true } });
      expect(res.statusCode).toBe(400);
    });
  });

  it('401s with no identity at all', async () => {
    fakePve = await startFakePve();
    app = await buildApp({ config: loadConfig({ NODE_ENV: 'test', PVE_URL: fakePve.url }) });
    const res = await create('/node1/qemu/100', { payload: { snapname: 'ok' } });
    expect(res.statusCode).toBe(401);
  });

  it('403s in token mode', async () => {
    await setupTokenMode();
    const res = await create('/node1/qemu/100', { payload: { snapname: 'ok' } });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ error: 'writes-disabled-in-token-mode' });
  });

  it('403s create for a session missing VM.Snapshot (has only VM.PowerMgmt)', async () => {
    const cookie = await setupSession();
    fakePve.setVmPermissions(100, { 'VM.PowerMgmt': true });

    const res = await create('/node1/qemu/100', { cookie, payload: { snapname: 'ok' } });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ error: 'forbidden', missing: 'VM.Snapshot' });
  });

  it('403s delete for a session missing VM.Snapshot', async () => {
    const cookie = await setupSession();
    const res = await del('/node1/qemu/100', 'pre-upgrade', { cookie });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ error: 'forbidden', missing: 'VM.Snapshot' });
  });

  it('rollback needs VM.Snapshot.Rollback specifically -- VM.Snapshot alone is not enough', async () => {
    const cookie = await setupSession();
    fakePve.setVmPermissions(100, { 'VM.Snapshot': true });

    const res = await rollback('/node1/qemu/100', 'pre-upgrade', { cookie });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ error: 'forbidden', missing: 'VM.Snapshot.Rollback' });
  });

  it('rollback succeeds for a session with VM.Snapshot.Rollback, sending start=1 for qemu', async () => {
    const cookie = await setupSession();
    fakePve.setVmPermissions(100, { 'VM.Snapshot.Rollback': true });

    const res = await rollback('/node1/qemu/100', 'pre-upgrade', { cookie, payload: { start: true } });
    expect(res.statusCode).toBe(202);

    const call = fakePve.snapshotCalls.at(-1);
    expect(call?.path).toBe('/api2/json/nodes/node1/qemu/100/snapshot/pre-upgrade/rollback');
    expect(call?.body).toEqual({ start: '1' });
  });

  it('delete succeeds and forwards force=1 as a query param when requested', async () => {
    const cookie = await setupSession();
    fakePve.setVmPermissions(100, { 'VM.Snapshot': true });

    const res = await req('DELETE', '/node1/qemu/100/snapshots/pre-upgrade?force=1', { cookie });
    expect(res.statusCode).toBe(202);

    const call = fakePve.snapshotCalls.at(-1);
    expect(call?.method).toBe('DELETE');
    expect(call?.path).toBe('/api2/json/nodes/node1/qemu/100/snapshot/pre-upgrade?force=1');
    expect(call?.body).toEqual({ force: '1' });
  });

  it('maps a PVE 4xx to the same status with a sanitised message (create)', async () => {
    const cookie = await setupSession();
    fakePve.setVmPermissions(100, { 'VM.Snapshot': true });
    fakePve.setSnapshotError('create', 'qemu', 100, 'dup', 400, 'snapshot name already used');

    const res = await create('/node1/qemu/100', { cookie, payload: { snapname: 'dup' } });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: 'pve-rejected', message: 'snapshot name already used' });
  });

  it('maps a PVE 5xx to 502 pve-unreachable (delete)', async () => {
    const cookie = await setupSession();
    fakePve.setVmPermissions(100, { 'VM.Snapshot': true });
    fakePve.setSnapshotError('delete', 'qemu', 100, 'pre-upgrade', 500, 'internal server secret detail');

    const res = await del('/node1/qemu/100', 'pre-upgrade', { cookie });
    expect(res.statusCode).toBe(502);
    expect(res.json()).toEqual({ error: 'pve-unreachable' });
  });

  it('maps a PVE 4xx to the same status on rollback too', async () => {
    const cookie = await setupSession();
    fakePve.setVmPermissions(100, { 'VM.Snapshot.Rollback': true });
    fakePve.setSnapshotError('rollback', 'qemu', 100, 'pre-upgrade', 400, 'cannot roll back a running vm');

    const res = await rollback('/node1/qemu/100', 'pre-upgrade', { cookie });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: 'pve-rejected', message: 'cannot roll back a running vm' });
  });

  it('shares the 30/minute rate-limit bucket with the power-action route', async () => {
    const cookie = await setupSession();
    fakePve.setVmPermissions(100, { 'VM.PowerMgmt': true, 'VM.Snapshot': true });

    // 20 power actions + 11 snapshot creates = 31 requests total against the one shared bucket.
    let last;
    for (let i = 0; i < 20; i++) {
      last = await req('POST', '/node1/qemu/100/start', { cookie });
    }
    for (let i = 0; i < 11; i++) {
      last = await create('/node1/qemu/100', { cookie, payload: { snapname: 'ratelimit-check' } });
    }
    expect(last!.statusCode).toBe(429);
  });
});
