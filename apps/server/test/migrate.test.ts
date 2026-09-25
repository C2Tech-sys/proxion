import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance, InjectOptions } from 'fastify';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { startFakePve, type FakePve } from './helpers/fakePve.js';

describe('guest migrate routes', () => {
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

  function migrate(path: string, options: { cookie?: string; payload?: Record<string, unknown> } = {}) {
    const injectOptions: InjectOptions = { method: 'POST', url: `/api/actions/guest${path}/migrate` };
    if (options.cookie !== undefined) injectOptions.headers = { cookie: options.cookie };
    if (options.payload !== undefined) injectOptions.payload = options.payload;
    return app.inject(injectOptions);
  }

  function precheck(path: string, target: string, options: { cookie?: string } = {}) {
    const injectOptions: InjectOptions = {
      method: 'GET',
      url: `/api/actions/guest${path}/migrate/precheck?target=${encodeURIComponent(target)}`,
    };
    if (options.cookie !== undefined) injectOptions.headers = { cookie: options.cookie };
    return app.inject(injectOptions);
  }

  /** Same as `precheck`, but with no `?target=` at all -- PVE's own precheck endpoints accept an
   * absent `target` too (see `migrateRoutes.ts`), and this is how the web dialog's node picker
   * learns cluster-wide `allowedNodes`/`notAllowedNodes` before any target is chosen. */
  function precheckNoTarget(path: string, options: { cookie?: string } = {}) {
    const injectOptions: InjectOptions = { method: 'GET', url: `/api/actions/guest${path}/migrate/precheck` };
    if (options.cookie !== undefined) injectOptions.headers = { cookie: options.cookie };
    return app.inject(injectOptions);
  }

  describe('validation (400)', () => {
    it('rejects target === node', async () => {
      const cookie = await setupSession();
      fakePve.setVmPermissions(100, { 'VM.Migrate': true });
      const res = await migrate('/node1/qemu/100', { cookie, payload: { target: 'node1' } });
      expect(res.statusCode).toBe(400);
    });

    it('rejects an invalid target node name', async () => {
      const cookie = await setupSession();
      fakePve.setVmPermissions(100, { 'VM.Migrate': true });
      const res = await migrate('/node1/qemu/100', { cookie, payload: { target: 'not a node!' } });
      expect(res.statusCode).toBe(400);
    });

    it('rejects an unknown body field', async () => {
      const cookie = await setupSession();
      fakePve.setVmPermissions(100, { 'VM.Migrate': true });
      const res = await migrate('/node1/qemu/100', {
        cookie,
        payload: { target: 'node2', skiplock: true },
      });
      expect(res.statusCode).toBe(400);
    });

    it('rejects restart for a qemu guest', async () => {
      const cookie = await setupSession();
      fakePve.setVmPermissions(100, { 'VM.Migrate': true });
      const res = await migrate('/node1/qemu/100', { cookie, payload: { target: 'node2', restart: true } });
      expect(res.statusCode).toBe(400);
    });

    it('rejects withLocalDisks for an lxc guest', async () => {
      const cookie = await setupSession();
      fakePve.setVmPermissions(200, { 'VM.Migrate': true });
      const res = await migrate('/node1/lxc/200', {
        cookie,
        payload: { target: 'node2', withLocalDisks: true },
      });
      expect(res.statusCode).toBe(400);
    });

    it('rejects a missing target', async () => {
      const cookie = await setupSession();
      fakePve.setVmPermissions(100, { 'VM.Migrate': true });
      const res = await migrate('/node1/qemu/100', { cookie, payload: {} });
      expect(res.statusCode).toBe(400);
    });

    it('precheck rejects an invalid (but present) target', async () => {
      const cookie = await setupSession();
      fakePve.setVmPermissions(100, { 'VM.Migrate': true });
      const res = await precheck('/node1/qemu/100', 'not a node!', { cookie });
      expect(res.statusCode).toBe(400);
    });

    it('precheck rejects target === node', async () => {
      const cookie = await setupSession();
      fakePve.setVmPermissions(100, { 'VM.Migrate': true });
      const res = await precheck('/node1/qemu/100', 'node1', { cookie });
      expect(res.statusCode).toBe(400);
    });
  });

  it('403s in token mode', async () => {
    await setupTokenMode();
    const res = await migrate('/node1/qemu/100', { payload: { target: 'node2' } });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ error: 'writes-disabled-in-token-mode' });
  });

  it('precheck 403s in token mode', async () => {
    await setupTokenMode();
    const res = await precheck('/node1/qemu/100', 'node2');
    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ error: 'writes-disabled-in-token-mode' });
  });

  it('403s a session that lacks VM.Migrate', async () => {
    const cookie = await setupSession();
    // No `setVmPermissions` call: VM.Migrate is absent by default.
    const res = await migrate('/node1/qemu/100', { cookie, payload: { target: 'node2' } });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ error: 'forbidden', missing: 'VM.Migrate' });
  });

  it('precheck 403s a session that lacks VM.Migrate', async () => {
    const cookie = await setupSession();
    const res = await precheck('/node1/qemu/100', 'node2', { cookie });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ error: 'forbidden', missing: 'VM.Migrate' });
  });

  it('qemu: 202 with upid, and PVE received target/online/with-local-disks', async () => {
    const cookie = await setupSession();
    fakePve.setVmPermissions(100, { 'VM.Migrate': true });

    const res = await migrate('/node1/qemu/100', {
      cookie,
      payload: { target: 'node2', online: true, withLocalDisks: true },
    });

    expect(res.statusCode).toBe(202);
    const body = res.json() as { upid: string };
    expect(typeof body.upid).toBe('string');

    const call = fakePve.migrateCalls.at(-1);
    expect(call?.type).toBe('qemu');
    expect(call?.path).toBe('/api2/json/nodes/node1/qemu/100/migrate');
    expect(call?.body).toEqual({ target: 'node2', online: '1', 'with-local-disks': '1' });
  });

  it('lxc: 202 with upid, and PVE received target/restart', async () => {
    const cookie = await setupSession();
    fakePve.setVmPermissions(200, { 'VM.Migrate': true });

    const res = await migrate('/node1/lxc/200', {
      cookie,
      payload: { target: 'node2', restart: true },
    });

    expect(res.statusCode).toBe(202);
    const body = res.json() as { upid: string };
    expect(typeof body.upid).toBe('string');

    const call = fakePve.migrateCalls.at(-1);
    expect(call?.type).toBe('lxc');
    expect(call?.path).toBe('/api2/json/nodes/node1/lxc/200/migrate');
    expect(call?.body).toEqual({ target: 'node2', restart: '1' });
  });

  it('maps a PVE error to a sanitised message with the PVE status code', async () => {
    const cookie = await setupSession();
    fakePve.setVmPermissions(100, { 'VM.Migrate': true });
    fakePve.setMigrateError('qemu', 100, 400, 'target node is offline\x00');

    const res = await migrate('/node1/qemu/100', { cookie, payload: { target: 'node2' } });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: 'pve-rejected', message: 'target node is offline' });
  });

  it('precheck succeeds without a target, and PVE saw no target query param', async () => {
    const cookie = await setupSession();
    fakePve.setVmPermissions(100, { 'VM.Migrate': true });
    fakePve.setMigratePrecheck('qemu', 100, {
      running: true,
      allowed_nodes: ['node2'],
      not_allowed_nodes: { node3: { unavailable_storages: ['local-lvm'] } },
      local_disks: [],
      local_resources: [],
    });

    const res = await precheckNoTarget('/node1/qemu/100', { cookie });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      running: true,
      allowedNodes: ['node2'],
      notAllowedNodes: { node3: { unavailableStorages: ['local-lvm'], blockingHaResources: [] } },
      localDisks: [],
      localResources: [],
    });

    const call = fakePve.migratePrecheckCalls.at(-1);
    expect(call?.path).toBe('/api2/json/nodes/node1/qemu/100/migrate');
    expect(call?.path).not.toContain('target=');

    const withTarget = await precheck('/node1/qemu/100', 'node2', { cookie });
    expect(withTarget.statusCode).toBe(200);
    const secondCall = fakePve.migratePrecheckCalls.at(-1);
    expect(secondCall?.path).toContain('target=node2');
  });

  it('precheck normalises the qemu shape', async () => {
    const cookie = await setupSession();
    fakePve.setVmPermissions(100, { 'VM.Migrate': true });
    fakePve.setMigratePrecheck('qemu', 100, {
      running: true,
      allowed_nodes: ['node2'],
      not_allowed_nodes: { node3: { unavailable_storages: ['local-lvm'], 'blocking-ha-resources': [{ sid: 'vm:100', cause: 'node-affinity' }] } },
      local_disks: [{ volid: 'local-lvm:vm-100-disk-0', size: 34359738368, cdrom: false, is_unused: false }],
      local_resources: ['usb0'],
      'has-dbus-vmstate': false,
    });

    const res = await precheck('/node1/qemu/100', 'node2', { cookie });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      running: true,
      allowedNodes: ['node2'],
      notAllowedNodes: { node3: { unavailableStorages: ['local-lvm'], blockingHaResources: ['vm:100'] } },
      localDisks: [{ volid: 'local-lvm:vm-100-disk-0', size: 34359738368, cdrom: false, isUnused: false }],
      localResources: ['usb0'],
    });
  });

  it('precheck normalises the lxc shape (hyphenated keys, no local disks/resources)', async () => {
    const cookie = await setupSession();
    fakePve.setVmPermissions(200, { 'VM.Migrate': true });
    fakePve.setMigratePrecheck('lxc', 200, {
      running: false,
      'allowed-nodes': ['node2'],
      'not-allowed-nodes': { node3: {} },
    });

    const res = await precheck('/node1/lxc/200', 'node2', { cookie });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      running: false,
      allowedNodes: ['node2'],
      notAllowedNodes: { node3: { unavailableStorages: [], blockingHaResources: [] } },
      localDisks: [],
      localResources: [],
    });
  });
});
