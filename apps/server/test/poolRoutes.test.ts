import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance, InjectOptions } from 'fastify';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { startFakePve, type FakePve } from './helpers/fakePve.js';

const POOL_ALLOCATE = { 'Pool.Allocate': true };
const BASE = '/api/actions/datacenter/pools';

describe('datacenter pool routes (T70)', () => {
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

  /** A signed-in session that may create pools and manage `ids`. */
  async function setupAllowed(...ids: string[]): Promise<string> {
    const cookie = await setupSession();
    fakePve.setPathPermissions('/pool', POOL_ALLOCATE);
    for (const id of ids) fakePve.setPathPermissions(`/pool/${id}`, POOL_ALLOCATE);
    return cookie;
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

  function call(method: 'POST' | 'PUT' | 'DELETE', path: string, options: { cookie?: string; payload?: unknown } = {}) {
    const injectOptions: InjectOptions = { method, url: `${BASE}${path}` };
    if (options.cookie !== undefined) injectOptions.headers = { cookie: options.cookie };
    if (options.payload !== undefined) injectOptions.payload = options.payload as NonNullable<InjectOptions['payload']>;
    return app.inject(injectOptions);
  }

  describe('token mode, authentication and privilege', () => {
    it('token mode: POST, PUT and DELETE all 403 without any PVE write', async () => {
      await setupTokenMode();
      for (const [method, path, payload] of [
        ['POST', '', { poolid: 'prod' }],
        ['PUT', '/prod', { comment: 'x' }],
        ['DELETE', '/prod', undefined],
      ] as const) {
        const res = await call(method, path, { payload });
        expect(res.statusCode).toBe(403);
        expect(res.json()).toEqual({ error: 'writes-disabled-in-token-mode' });
      }
      expect(fakePve.poolCalls).toHaveLength(0);
    });

    it('401s without a session', async () => {
      await setupSession();
      expect((await call('POST', '', { payload: { poolid: 'prod' } })).statusCode).toBe(401);
      expect((await call('PUT', '/prod', { payload: { comment: 'x' } })).statusCode).toBe(401);
      expect((await call('DELETE', '/prod')).statusCode).toBe(401);
      expect(fakePve.poolCalls).toHaveLength(0);
    });

    it('POST 403s naming Pool.Allocate without it on /pool', async () => {
      const cookie = await setupSession();
      fakePve.setPathPermissions('/pool', { 'Pool.Audit': true });
      const res = await call('POST', '', { cookie, payload: { poolid: 'prod' } });
      expect(res.statusCode).toBe(403);
      expect(res.json()).toEqual({ error: 'forbidden', missing: 'Pool.Allocate' });
      expect(fakePve.poolCalls).toHaveLength(0);
    });

    it('PUT and DELETE 403 without it on /pool/<id>, even with it on /pool', async () => {
      const cookie = await setupSession();
      fakePve.setPathPermissions('/pool', POOL_ALLOCATE);
      const put = await call('PUT', '/prod', { cookie, payload: { comment: 'x' } });
      expect(put.statusCode).toBe(403);
      expect(put.json()).toEqual({ error: 'forbidden', missing: 'Pool.Allocate' });
      expect((await call('DELETE', '/prod', { cookie })).statusCode).toBe(403);
      expect(fakePve.poolCalls).toHaveLength(0);
    });
  });

  describe('body validation (400, before any PVE call)', () => {
    async function expect400(method: 'POST' | 'PUT', path: string, payload: unknown) {
      const cookie = await setupAllowed('prod');
      const res = await call(method, path, { cookie, payload });
      expect(res.statusCode).toBe(400);
      expect(fakePve.poolCalls).toHaveLength(0);
    }

    it('rejects a bad poolid, an unknown key and a multi-line comment on create', async () => {
      await expect400('POST', '', { poolid: '' });
      await expect400('POST', '', { poolid: 'has space' });
      await expect400('POST', '', { poolid: 'a/b' });
      await expect400('POST', '', { poolid: 'a'.repeat(65) });
      await expect400('POST', '', { poolid: 'prod', bogus: 1 });
      await expect400('POST', '', { poolid: 'prod', comment: 'line one\nline two' });
    });

    it('rejects an empty update, bad members and inconsistent flags', async () => {
      await expect400('PUT', '/prod', {});
      await expect400('PUT', '/prod', { vms: [] });
      await expect400('PUT', '/prod', { vms: [100.5] });
      await expect400('PUT', '/prod', { vms: ['100'] });
      await expect400('PUT', '/prod', { storage: ['bad name'] });
      await expect400('PUT', '/prod', { comment: 'x', remove: true });
      await expect400('PUT', '/prod', { vms: [100], remove: true, 'allow-move': true });
      await expect400('PUT', '/bad%20id', { comment: 'x' });
    });
  });

  describe('create', () => {
    it('sends poolid and comment', async () => {
      const cookie = await setupAllowed();
      const res = await call('POST', '', { cookie, payload: { poolid: 'prod', comment: 'Production guests' } });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ ok: true, poolid: 'prod' });
      expect(fakePve.poolCalls).toStrictEqual([
        { method: 'POST', path: '/pools', body: { poolid: 'prod', comment: 'Production guests' } },
      ]);
    });

    it('omits an absent or empty comment', async () => {
      const cookie = await setupAllowed();
      await call('POST', '', { cookie, payload: { poolid: 'dev' } });
      await call('POST', '', { cookie, payload: { poolid: 'qa', comment: '' } });
      expect(fakePve.poolCalls.map((c) => c.body)).toStrictEqual([{ poolid: 'dev' }, { poolid: 'qa' }]);
    });
  });

  describe('update', () => {
    it('changes the comment only (an empty comment clears it)', async () => {
      const cookie = await setupAllowed('prod');
      expect((await call('PUT', '/prod', { cookie, payload: { comment: 'New text' } })).statusCode).toBe(200);
      expect((await call('PUT', '/prod', { cookie, payload: { comment: '' } })).statusCode).toBe(200);
      expect(fakePve.poolCalls).toStrictEqual([
        { method: 'PUT', path: '/pools/prod', body: { comment: 'New text' } },
        { method: 'PUT', path: '/pools/prod', body: { comment: '' } },
      ]);
    });

    it('adds guests and storages as comma-joined lists', async () => {
      const cookie = await setupAllowed('prod');
      const res = await call('PUT', '/prod', { cookie, payload: { vms: [100, 101, 205], storage: ['tank', 'local'] } });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ ok: true, poolid: 'prod' });
      expect(fakePve.poolCalls).toStrictEqual([
        { method: 'PUT', path: '/pools/prod', body: { vms: '100,101,205', storage: 'tank,local' } },
      ]);
    });

    it('allow-move is sent as 1 when adding', async () => {
      const cookie = await setupAllowed('prod');
      await call('PUT', '/prod', { cookie, payload: { vms: [104], 'allow-move': true } });
      expect(fakePve.poolCalls[0]!.body).toStrictEqual({ vms: '104', 'allow-move': '1' });
    });

    it('removes members with delete: 1', async () => {
      const cookie = await setupAllowed('prod');
      const res = await call('PUT', '/prod', { cookie, payload: { vms: [100], storage: ['tank'], remove: true } });
      expect(res.statusCode).toBe(200);
      expect(fakePve.poolCalls).toStrictEqual([
        { method: 'PUT', path: '/pools/prod', body: { vms: '100', storage: 'tank', delete: '1' } },
      ]);
    });

    it('remove: false adds rather than removes (no delete flag)', async () => {
      const cookie = await setupAllowed('prod');
      await call('PUT', '/prod', { cookie, payload: { vms: [100], remove: false } });
      expect(fakePve.poolCalls[0]!.body).toStrictEqual({ vms: '100' });
    });

    it('relays a PVE 4xx and maps a 5xx to 502', async () => {
      const cookie = await setupAllowed('prod');
      fakePve.setPoolError({ status: 403, message: 'Permission check failed (/vms/100, VM.PoolAllocate)' });
      const rejected = await call('PUT', '/prod', { cookie, payload: { vms: [100] } });
      expect(rejected.statusCode).toBe(403);
      expect(rejected.json()).toEqual({
        error: 'pve-rejected',
        message: 'Permission check failed (/vms/100, VM.PoolAllocate)',
      });
      fakePve.setPoolError({ status: 500, message: 'boom' });
      const down = await call('PUT', '/prod', { cookie, payload: { vms: [100] } });
      expect(down.statusCode).toBe(502);
      expect(down.json()).toEqual({ error: 'pve-unreachable' });
    });
  });

  describe('delete', () => {
    it('sends DELETE /pools/{id}', async () => {
      const cookie = await setupAllowed('prod');
      const res = await call('DELETE', '/prod', { cookie });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ ok: true });
      expect(fakePve.poolCalls).toStrictEqual([{ method: 'DELETE', path: '/pools/prod', body: {} }]);
    });

    it("relays PVE's refusal of a pool that still has members", async () => {
      const cookie = await setupAllowed('prod');
      fakePve.setPoolError({ status: 400, message: "pool 'prod' is not empty" });
      const res = await call('DELETE', '/prod', { cookie });
      expect(res.statusCode).toBe(400);
      expect(res.json()).toEqual({ error: 'pve-rejected', message: "pool 'prod' is not empty" });
    });

    it('400s a bad id and maps a PVE 5xx to 502', async () => {
      const cookie = await setupAllowed('prod');
      expect((await call('DELETE', '/bad%20id', { cookie })).statusCode).toBe(400);
      fakePve.setPoolError({ status: 502, message: 'bad gateway' });
      expect((await call('DELETE', '/prod', { cookie })).statusCode).toBe(502);
    });
  });

  describe('reads go through the read-only proxy', () => {
    it('GET /api/pve/pools returns the pool list and the proxy still refuses a write', async () => {
      const cookie = await setupAllowed();
      fakePve.setPools([{ poolid: 'prod', comment: 'Production', members: [] }]);
      const read = await app.inject({ method: 'GET', url: '/api/pve/pools', headers: { cookie } });
      expect(read.statusCode).toBe(200);
      expect(read.json()).toEqual({ data: [{ poolid: 'prod', comment: 'Production', members: [] }] });
      const write = await app.inject({ method: 'POST', url: '/api/pve/pools', headers: { cookie }, payload: { poolid: 'x' } });
      expect(write.statusCode).toBe(405);
      expect(fakePve.poolCalls).toHaveLength(0);
    });
  });
});
