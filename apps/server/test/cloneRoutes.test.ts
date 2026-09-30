import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance, InjectOptions } from 'fastify';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { startFakePve, type FakePve } from './helpers/fakePve.js';

describe('guest clone routes', () => {
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

  function clone(path: string, options: { cookie?: string; payload?: Record<string, unknown> } = {}) {
    const injectOptions: InjectOptions = { method: 'POST', url: `/api/actions/guest${path}/clone` };
    if (options.cookie !== undefined) injectOptions.headers = { cookie: options.cookie };
    if (options.payload !== undefined) injectOptions.payload = options.payload;
    return app.inject(injectOptions);
  }

  function nextid(path: string, options: { cookie?: string } = {}) {
    const injectOptions: InjectOptions = { method: 'GET', url: `/api/actions/guest${path}/clone/nextid` };
    if (options.cookie !== undefined) injectOptions.headers = { cookie: options.cookie };
    return app.inject(injectOptions);
  }

  /** `pve1` (the source guest's own node) and `pve2` (another node), plus the source guest row
   * itself -- the minimum `GET /cluster/resources` needs for a clone request that isn't testing
   * the target-exists/linked-requires-template/unknown-target 400s specifically. */
  function baseResources(opts: { template?: boolean } = {}) {
    return [
      { id: 'node/pve1', type: 'node', node: 'pve1', status: 'online' },
      { id: 'node/pve2', type: 'node', node: 'pve2', status: 'online' },
      { id: 'qemu/100', type: 'qemu', vmid: 100, node: 'pve1', status: 'stopped', template: opts.template ? 1 : 0 },
    ];
  }

  describe('token mode', () => {
    it('clone 403s in token mode', async () => {
      await setupTokenMode();
      const res = await clone('/node1/qemu/100', { payload: { newid: 101 } });
      expect(res.statusCode).toBe(403);
      expect(res.json()).toEqual({ error: 'writes-disabled-in-token-mode' });
    });

    it('nextid 403s in token mode', async () => {
      await setupTokenMode();
      const res = await nextid('/node1/qemu/100');
      expect(res.statusCode).toBe(403);
      expect(res.json()).toEqual({ error: 'writes-disabled-in-token-mode' });
    });
  });

  describe('body validation (400)', () => {
    it('rejects a bad name', async () => {
      const cookie = await setupSession();
      const res = await clone('/pve1/qemu/100', { cookie, payload: { newid: 101, name: '-bad-name' } });
      expect(res.statusCode).toBe(400);
    });

    it('rejects an unknown field', async () => {
      const cookie = await setupSession();
      const res = await clone('/pve1/qemu/100', { cookie, payload: { newid: 101, skiplock: true } });
      expect(res.statusCode).toBe(400);
    });

    it('rejects newid out of range', async () => {
      const cookie = await setupSession();
      const res = await clone('/pve1/qemu/100', { cookie, payload: { newid: 99 } });
      expect(res.statusCode).toBe(400);
    });
  });

  describe('business rules (400)', () => {
    it('same-id', async () => {
      const cookie = await setupSession();
      const res = await clone('/pve1/qemu/100', { cookie, payload: { newid: 100 } });
      expect(res.statusCode).toBe(400);
      expect(res.json()).toEqual({ error: 'same-id' });
    });

    it('target-exists', async () => {
      const cookie = await setupSession();
      fakePve.setClusterResources([
        ...baseResources(),
        { id: 'qemu/101', type: 'qemu', vmid: 101, node: 'pve1', status: 'stopped' },
      ]);
      const res = await clone('/pve1/qemu/100', { cookie, payload: { newid: 101 } });
      expect(res.statusCode).toBe(400);
      expect(res.json()).toEqual({ error: 'target-exists' });
    });

    it('linked-requires-template: rejected for a non-template source', async () => {
      const cookie = await setupSession();
      fakePve.setClusterResources(baseResources());
      const res = await clone('/pve1/qemu/100', { cookie, payload: { newid: 101, full: false } });
      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({ error: 'linked-requires-template' });
    });

    it('linked clone allowed for a template source', async () => {
      const cookie = await setupSession();
      fakePve.setClusterResources(baseResources({ template: true }));
      fakePve.setVmPermissions(100, { 'VM.Clone': true });
      fakePve.setVmPermissions(101, { 'VM.Allocate': true });
      const res = await clone('/pve1/qemu/100', { cookie, payload: { newid: 101, full: false } });
      expect(res.statusCode).toBe(202);
      const call = fakePve.cloneCalls.at(-1);
      expect(call?.body.full).toBe('0');
    });

    it('unknown-target', async () => {
      const cookie = await setupSession();
      fakePve.setClusterResources(baseResources());
      const res = await clone('/pve1/qemu/100', { cookie, payload: { newid: 101, target: 'pve9' } });
      expect(res.statusCode).toBe(400);
      expect(res.json()).toEqual({ error: 'unknown-target' });
    });

    it('a valid target node is accepted', async () => {
      const cookie = await setupSession();
      fakePve.setClusterResources(baseResources());
      fakePve.setVmPermissions(100, { 'VM.Clone': true });
      fakePve.setVmPermissions(101, { 'VM.Allocate': true });
      const res = await clone('/pve1/qemu/100', { cookie, payload: { newid: 101, target: 'pve2' } });
      expect(res.statusCode).toBe(202);
    });
  });

  describe('privilege matrix', () => {
    it('403s missing VM.Clone', async () => {
      const cookie = await setupSession();
      fakePve.setClusterResources(baseResources());
      fakePve.setVmPermissions(101, { 'VM.Allocate': true });
      const res = await clone('/pve1/qemu/100', { cookie, payload: { newid: 101 } });
      expect(res.statusCode).toBe(403);
      expect(res.json()).toEqual({ error: 'forbidden', missing: 'VM.Clone' });
    });

    it('403s missing VM.Allocate on newid', async () => {
      const cookie = await setupSession();
      fakePve.setClusterResources(baseResources());
      fakePve.setVmPermissions(100, { 'VM.Clone': true });
      const res = await clone('/pve1/qemu/100', { cookie, payload: { newid: 101 } });
      expect(res.statusCode).toBe(403);
      expect(res.json()).toEqual({ error: 'forbidden', missing: 'VM.Allocate' });
    });

    it('403s missing Datastore.AllocateSpace when a storage is given', async () => {
      const cookie = await setupSession();
      fakePve.setClusterResources(baseResources());
      fakePve.setVmPermissions(100, { 'VM.Clone': true });
      fakePve.setVmPermissions(101, { 'VM.Allocate': true });
      const res = await clone('/pve1/qemu/100', { cookie, payload: { newid: 101, storage: 'local-lvm' } });
      expect(res.statusCode).toBe(403);
      expect(res.json()).toEqual({ error: 'forbidden', missing: 'Datastore.AllocateSpace' });
    });

    it('202s with all three privileges granted', async () => {
      const cookie = await setupSession();
      fakePve.setClusterResources(baseResources());
      fakePve.setVmPermissions(100, { 'VM.Clone': true });
      fakePve.setVmPermissions(101, { 'VM.Allocate': true });
      fakePve.setStoragePermissions('local-lvm', { 'Datastore.AllocateSpace': true });
      const res = await clone('/pve1/qemu/100', { cookie, payload: { newid: 101, storage: 'local-lvm' } });
      expect(res.statusCode).toBe(202);
    });
  });

  describe('param mapping', () => {
    it('qemu: default full:true, no target sent when omitted, name mapped to name', async () => {
      const cookie = await setupSession();
      fakePve.setClusterResources(baseResources());
      fakePve.setVmPermissions(100, { 'VM.Clone': true });
      fakePve.setVmPermissions(101, { 'VM.Allocate': true });

      const res = await clone('/pve1/qemu/100', {
        cookie,
        payload: { newid: 101, name: 'web-prod-01-clone', description: 'a clone' },
      });

      expect(res.statusCode).toBe(202);
      const call = fakePve.cloneCalls.at(-1);
      expect(call?.type).toBe('qemu');
      expect(call?.body).toEqual({
        newid: '101',
        full: '1',
        name: 'web-prod-01-clone',
        description: 'a clone',
      });
    });

    it('lxc: hostname mapping instead of name', async () => {
      const cookie = await setupSession();
      fakePve.setClusterResources([
        { id: 'node/pve1', type: 'node', node: 'pve1', status: 'online' },
        { id: 'lxc/200', type: 'lxc', vmid: 200, node: 'pve1', status: 'stopped', template: 0 },
      ]);
      fakePve.setVmPermissions(200, { 'VM.Clone': true });
      fakePve.setVmPermissions(201, { 'VM.Allocate': true });

      const res = await clone('/pve1/lxc/200', { cookie, payload: { newid: 201, name: 'ct-clone' } });

      expect(res.statusCode).toBe(202);
      const call = fakePve.cloneCalls.at(-1);
      expect(call?.type).toBe('lxc');
      expect(call?.body).toEqual({ newid: '201', full: '1', hostname: 'ct-clone' });
    });

    it('target defaults to the source node when omitted, and is sent when given', async () => {
      const cookie = await setupSession();
      fakePve.setClusterResources(baseResources());
      fakePve.setVmPermissions(100, { 'VM.Clone': true });
      fakePve.setVmPermissions(101, { 'VM.Allocate': true });

      const res = await clone('/pve1/qemu/100', { cookie, payload: { newid: 101, target: 'pve2' } });

      expect(res.statusCode).toBe(202);
      const call = fakePve.cloneCalls.at(-1);
      expect(call?.body.target).toBe('pve2');
    });

    it('sends snapname and bwlimit when given', async () => {
      const cookie = await setupSession();
      fakePve.setClusterResources(baseResources());
      fakePve.setVmPermissions(100, { 'VM.Clone': true });
      fakePve.setVmPermissions(101, { 'VM.Allocate': true });

      const res = await clone('/pve1/qemu/100', {
        cookie,
        payload: { newid: 101, snapname: 'before-upgrade', bwlimit: 1024 },
      });

      expect(res.statusCode).toBe(202);
      const call = fakePve.cloneCalls.at(-1);
      expect(call?.body.snapname).toBe('before-upgrade');
      expect(call?.body.bwlimit).toBe('1024');
    });

    it('surfaces a PVE clone error with field detail', async () => {
      const cookie = await setupSession();
      fakePve.setClusterResources(baseResources());
      fakePve.setVmPermissions(100, { 'VM.Clone': true });
      fakePve.setVmPermissions(101, { 'VM.Allocate': true });
      fakePve.setCloneError('qemu', 100, 400, 'Parameter verification failed.', { newid: 'newid already exists' });

      const res = await clone('/pve1/qemu/100', { cookie, payload: { newid: 101 } });

      expect(res.statusCode).toBe(400);
      expect(res.json()).toEqual({
        error: 'pve-rejected',
        message: 'Parameter verification failed. newid: newid already exists',
      });
    });
  });

  describe('nextid', () => {
    it('proxies GET /cluster/nextid', async () => {
      const cookie = await setupSession();
      fakePve.setNextId(105);
      const res = await nextid('/pve1/qemu/100', { cookie });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ vmid: 105 });
    });
  });
});
