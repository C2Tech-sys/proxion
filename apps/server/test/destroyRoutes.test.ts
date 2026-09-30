import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance, InjectOptions } from 'fastify';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { startFakePve, type FakePve } from './helpers/fakePve.js';

describe('guest delete (destroy) routes', () => {
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

  function destroy(path: string, options: { cookie?: string; payload?: Record<string, unknown> } = {}) {
    const injectOptions: InjectOptions = { method: 'DELETE', url: `/api/actions/guest${path}` };
    if (options.cookie !== undefined) injectOptions.headers = { cookie: options.cookie };
    if (options.payload !== undefined) injectOptions.payload = options.payload;
    return app.inject(injectOptions);
  }

  /** One stopped qemu guest (vmid 100) and one stopped lxc guest (vmid 200) on `pve1`. */
  function baseResources(
    opts: { qemuStatus?: string; lxcStatus?: string; qemuTemplate?: boolean } = {},
  ): unknown[] {
    return [
      { id: 'node/pve1', type: 'node', node: 'pve1', status: 'online' },
      {
        id: 'qemu/100',
        type: 'qemu',
        vmid: 100,
        node: 'pve1',
        status: opts.qemuStatus ?? 'stopped',
        template: opts.qemuTemplate ? 1 : 0,
      },
      { id: 'lxc/200', type: 'lxc', vmid: 200, node: 'pve1', status: opts.lxcStatus ?? 'stopped' },
    ];
  }

  describe('token mode', () => {
    it('403s in token mode', async () => {
      await setupTokenMode();
      const res = await destroy('/pve1/qemu/100', { payload: {} });
      expect(res.statusCode).toBe(403);
      expect(res.json()).toEqual({ error: 'writes-disabled-in-token-mode' });
      expect(fakePve.destroyCalls).toHaveLength(0);
    });
  });

  describe('validation and lookup', () => {
    it('401s without a session', async () => {
      await setupSession();
      const res = await destroy('/pve1/qemu/100', { payload: {} });
      expect(res.statusCode).toBe(401);
    });

    it('rejects an unknown body field (400)', async () => {
      const cookie = await setupSession();
      fakePve.setClusterResources(baseResources());
      fakePve.setVmPermissions(100, { 'VM.Allocate': true });
      const res = await destroy('/pve1/qemu/100', { cookie, payload: { skiplock: true } });
      expect(res.statusCode).toBe(400);
      expect(fakePve.destroyCalls).toHaveLength(0);
    });

    it('rejects a non-boolean flag (400)', async () => {
      const cookie = await setupSession();
      fakePve.setClusterResources(baseResources());
      fakePve.setVmPermissions(100, { 'VM.Allocate': true });
      const res = await destroy('/pve1/qemu/100', { cookie, payload: { purge: 'yes' } });
      expect(res.statusCode).toBe(400);
    });

    it('rejects an invalid type/vmid (400)', async () => {
      const cookie = await setupSession();
      const res = await destroy('/pve1/bogus/100', { cookie, payload: {} });
      expect(res.statusCode).toBe(400);
    });

    it('404s not-found when the guest is not in the cluster', async () => {
      const cookie = await setupSession();
      fakePve.setClusterResources(baseResources());
      fakePve.setVmPermissions(999, { 'VM.Allocate': true });
      const res = await destroy('/pve1/qemu/999', { cookie, payload: {} });
      expect(res.statusCode).toBe(404);
      expect(res.json()).toEqual({ error: 'not-found' });
      expect(fakePve.destroyCalls).toHaveLength(0);
    });

    it('404s not-found when the vmid exists under the other guest type', async () => {
      const cookie = await setupSession();
      fakePve.setClusterResources(baseResources());
      fakePve.setVmPermissions(100, { 'VM.Allocate': true });
      const res = await destroy('/pve1/lxc/100', { cookie, payload: {} });
      expect(res.statusCode).toBe(404);
      expect(res.json()).toEqual({ error: 'not-found' });
    });

    it('400s guest-running for a running guest', async () => {
      const cookie = await setupSession();
      fakePve.setClusterResources(baseResources({ qemuStatus: 'running' }));
      fakePve.setVmPermissions(100, { 'VM.Allocate': true });
      const res = await destroy('/pve1/qemu/100', { cookie, payload: {} });
      expect(res.statusCode).toBe(400);
      expect(res.json()).toEqual({ error: 'guest-running', message: 'Stop the guest before deleting it' });
      expect(fakePve.destroyCalls).toHaveLength(0);
    });

    it('400s guest-running for a paused guest', async () => {
      const cookie = await setupSession();
      fakePve.setClusterResources(baseResources({ qemuStatus: 'paused' }));
      fakePve.setVmPermissions(100, { 'VM.Allocate': true });
      const res = await destroy('/pve1/qemu/100', { cookie, payload: {} });
      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({ error: 'guest-running' });
    });

    it('allows deleting a template', async () => {
      const cookie = await setupSession();
      fakePve.setClusterResources(baseResources({ qemuTemplate: true }));
      fakePve.setVmPermissions(100, { 'VM.Allocate': true });
      const res = await destroy('/pve1/qemu/100', { cookie, payload: {} });
      expect(res.statusCode).toBe(202);
    });
  });

  describe('privilege', () => {
    it('403s missing VM.Allocate, naming it', async () => {
      const cookie = await setupSession();
      fakePve.setClusterResources(baseResources());
      const res = await destroy('/pve1/qemu/100', { cookie, payload: {} });
      expect(res.statusCode).toBe(403);
      expect(res.json()).toEqual({ error: 'forbidden', missing: 'VM.Allocate' });
      expect(fakePve.destroyCalls).toHaveLength(0);
    });
  });

  describe('param mapping', () => {
    it('qemu: defaults send purge=0 and destroy-unreferenced-disks=1 (and 202 with the upid)', async () => {
      const cookie = await setupSession();
      fakePve.setClusterResources(baseResources());
      fakePve.setVmPermissions(100, { 'VM.Allocate': true });

      const res = await destroy('/pve1/qemu/100', { cookie, payload: {} });

      expect(res.statusCode).toBe(202);
      expect(res.json()).toEqual({ upid: 'UPID:fakepve:00000001:00000000:00000000:qmdestroy:100:root@pam:' });
      expect(fakePve.destroyCalls).toEqual([
        { type: 'qemu', vmid: 100, query: { purge: '0', 'destroy-unreferenced-disks': '1' } },
      ]);
    });

    it('qemu: both flags given explicitly are forwarded', async () => {
      const cookie = await setupSession();
      fakePve.setClusterResources(baseResources());
      fakePve.setVmPermissions(100, { 'VM.Allocate': true });

      const res = await destroy('/pve1/qemu/100', {
        cookie,
        payload: { purge: true, destroyUnreferencedDisks: false },
      });

      expect(res.statusCode).toBe(202);
      expect(fakePve.destroyCalls.at(-1)).toEqual({
        type: 'qemu',
        vmid: 100,
        query: { purge: '1', 'destroy-unreferenced-disks': '0' },
      });
    });

    it('lxc: defaults and explicit flags map the same way', async () => {
      const cookie = await setupSession();
      fakePve.setClusterResources(baseResources());
      fakePve.setVmPermissions(200, { 'VM.Allocate': true });

      const first = await destroy('/pve1/lxc/200', { cookie, payload: {} });
      expect(first.statusCode).toBe(202);
      expect(fakePve.destroyCalls.at(-1)).toEqual({
        type: 'lxc',
        vmid: 200,
        query: { purge: '0', 'destroy-unreferenced-disks': '1' },
      });

      const second = await destroy('/pve1/lxc/200', {
        cookie,
        payload: { purge: true, destroyUnreferencedDisks: false },
      });
      expect(second.statusCode).toBe(202);
      expect(fakePve.destroyCalls.at(-1)).toEqual({
        type: 'lxc',
        vmid: 200,
        query: { purge: '1', 'destroy-unreferenced-disks': '0' },
      });
    });

    it('works with no request body at all', async () => {
      const cookie = await setupSession();
      fakePve.setClusterResources(baseResources());
      fakePve.setVmPermissions(100, { 'VM.Allocate': true });

      const res = await destroy('/pve1/qemu/100', { cookie });

      expect(res.statusCode).toBe(202);
      expect(fakePve.destroyCalls.at(-1)?.query).toEqual({ purge: '0', 'destroy-unreferenced-disks': '1' });
    });

    it('surfaces a PVE destroy error with field detail', async () => {
      const cookie = await setupSession();
      fakePve.setClusterResources(baseResources());
      fakePve.setVmPermissions(100, { 'VM.Allocate': true });
      fakePve.setDestroyError('qemu', 100, 400, 'Parameter verification failed.', { vmid: 'VM is locked (backup)' });

      const res = await destroy('/pve1/qemu/100', { cookie, payload: {} });

      expect(res.statusCode).toBe(400);
      expect(res.json()).toEqual({
        error: 'pve-rejected',
        message: 'Parameter verification failed. vmid: VM is locked (backup)',
      });
    });

    it('maps a PVE 5xx to 502 pve-unreachable', async () => {
      const cookie = await setupSession();
      fakePve.setClusterResources(baseResources());
      fakePve.setVmPermissions(100, { 'VM.Allocate': true });
      fakePve.setDestroyError('qemu', 100, 500, 'internal secret detail');

      const res = await destroy('/pve1/qemu/100', { cookie, payload: {} });

      expect(res.statusCode).toBe(502);
      expect(res.json()).toEqual({ error: 'pve-unreachable' });
    });
  });

  it('rate-limits at 30 requests/minute per session (shared bucket)', async () => {
    const cookie = await setupSession();
    fakePve.setClusterResources(baseResources());
    fakePve.setVmPermissions(100, { 'VM.Allocate': true });

    let last;
    for (let i = 0; i < 31; i++) {
      last = await destroy('/pve1/qemu/100', { cookie, payload: {} });
    }
    expect(last!.statusCode).toBe(429);
  });
});
