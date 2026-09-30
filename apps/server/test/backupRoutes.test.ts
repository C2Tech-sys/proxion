import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance, InjectOptions } from 'fastify';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { startFakePve, type FakePve } from './helpers/fakePve.js';

describe('guest backup/restore routes', () => {
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

  function backup(path: string, options: { cookie?: string; payload?: Record<string, unknown> } = {}) {
    const injectOptions: InjectOptions = { method: 'POST', url: `/api/actions/guest${path}/backup` };
    if (options.cookie !== undefined) injectOptions.headers = { cookie: options.cookie };
    if (options.payload !== undefined) injectOptions.payload = options.payload;
    return app.inject(injectOptions);
  }

  function restore(path: string, options: { cookie?: string; payload?: Record<string, unknown> } = {}) {
    const injectOptions: InjectOptions = { method: 'POST', url: `/api/actions/guest${path}/restore` };
    if (options.cookie !== undefined) injectOptions.headers = { cookie: options.cookie };
    if (options.payload !== undefined) injectOptions.payload = options.payload;
    return app.inject(injectOptions);
  }

  function nextid(path: string, options: { cookie?: string } = {}) {
    const injectOptions: InjectOptions = { method: 'GET', url: `/api/actions/guest${path}/restore/nextid` };
    if (options.cookie !== undefined) injectOptions.headers = { cookie: options.cookie };
    return app.inject(injectOptions);
  }

  describe('token mode', () => {
    it('backup 403s in token mode', async () => {
      await setupTokenMode();
      const res = await backup('/node1/qemu/100', { payload: { storage: 'local', mode: 'snapshot' } });
      expect(res.statusCode).toBe(403);
      expect(res.json()).toEqual({ error: 'writes-disabled-in-token-mode' });
    });

    it('restore 403s in token mode', async () => {
      await setupTokenMode();
      const res = await restore('/node1/qemu/100', { payload: { archive: 'local:backup/vzdump-qemu-100-2024_01_01-00_00_00.tar.zst' } });
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

  describe('backup privilege matrix', () => {
    it('403s missing VM.Backup', async () => {
      const cookie = await setupSession();
      fakePve.setStoragePermissions('local', { 'Datastore.AllocateSpace': true });
      const res = await backup('/node1/qemu/100', { cookie, payload: { storage: 'local', mode: 'snapshot' } });
      expect(res.statusCode).toBe(403);
      expect(res.json()).toEqual({ error: 'forbidden', missing: 'VM.Backup' });
    });

    it('403s missing Datastore.AllocateSpace', async () => {
      const cookie = await setupSession();
      fakePve.setVmPermissions(100, { 'VM.Backup': true });
      const res = await backup('/node1/qemu/100', { cookie, payload: { storage: 'local', mode: 'snapshot' } });
      expect(res.statusCode).toBe(403);
      expect(res.json()).toEqual({ error: 'forbidden', missing: 'Datastore.AllocateSpace' });
    });
  });

  describe('backup body validation (400)', () => {
    it('rejects a bad mode', async () => {
      const cookie = await setupSession();
      fakePve.setVmPermissions(100, { 'VM.Backup': true });
      fakePve.setStoragePermissions('local', { 'Datastore.AllocateSpace': true });
      const res = await backup('/node1/qemu/100', { cookie, payload: { storage: 'local', mode: 'bogus' } });
      expect(res.statusCode).toBe(400);
    });

    it('rejects a bad compress value', async () => {
      const cookie = await setupSession();
      const res = await backup('/node1/qemu/100', {
        cookie,
        payload: { storage: 'local', mode: 'snapshot', compress: 'lz4' },
      });
      expect(res.statusCode).toBe(400);
    });

    it('rejects a bad storage id', async () => {
      const cookie = await setupSession();
      const res = await backup('/node1/qemu/100', {
        cookie,
        payload: { storage: 'not a storage!', mode: 'snapshot' },
      });
      expect(res.statusCode).toBe(400);
    });

    it('rejects notes over 512 chars', async () => {
      const cookie = await setupSession();
      const res = await backup('/node1/qemu/100', {
        cookie,
        payload: { storage: 'local', mode: 'snapshot', notes: 'x'.repeat(513) },
      });
      expect(res.statusCode).toBe(400);
    });

    it('rejects an unknown field', async () => {
      const cookie = await setupSession();
      const res = await backup('/node1/qemu/100', {
        cookie,
        payload: { storage: 'local', mode: 'snapshot', skiplock: true },
      });
      expect(res.statusCode).toBe(400);
    });
  });

  describe('vzdump param mapping', () => {
    it('202s and PVE received storage/mode/compress/remove:0 default, notes-template', async () => {
      const cookie = await setupSession();
      fakePve.setVmPermissions(100, { 'VM.Backup': true });
      fakePve.setStoragePermissions('local', { 'Datastore.AllocateSpace': true });

      const res = await backup('/node1/qemu/100', {
        cookie,
        payload: { storage: 'local', mode: 'snapshot', notes: '{{guestname}}' },
      });

      expect(res.statusCode).toBe(202);
      const body = res.json() as { upid: string };
      expect(typeof body.upid).toBe('string');

      const call = fakePve.vzdumpCalls.at(-1);
      expect(call?.body).toEqual({
        vmid: '100',
        storage: 'local',
        mode: 'snapshot',
        compress: 'zstd',
        remove: '0',
        'notes-template': '{{guestname}}',
      });
    });

    it('omits remove when prune is true, and sends protected', async () => {
      const cookie = await setupSession();
      fakePve.setVmPermissions(100, { 'VM.Backup': true });
      fakePve.setStoragePermissions('local', { 'Datastore.AllocateSpace': true });

      const res = await backup('/node1/qemu/100', {
        cookie,
        payload: { storage: 'local', mode: 'stop', compress: 'gzip', protected: true, prune: true },
      });

      expect(res.statusCode).toBe(202);
      const call = fakePve.vzdumpCalls.at(-1);
      expect(call?.body).toEqual({
        vmid: '100',
        storage: 'local',
        mode: 'stop',
        compress: 'gzip',
        protected: '1',
      });
    });

    it('surfaces a PVE vzdump error with field detail', async () => {
      const cookie = await setupSession();
      fakePve.setVmPermissions(100, { 'VM.Backup': true });
      fakePve.setStoragePermissions('local', { 'Datastore.AllocateSpace': true });
      fakePve.setVzdumpError(400, 'Parameter verification failed.', { storage: 'storage does not exist' });

      const res = await backup('/node1/qemu/100', { cookie, payload: { storage: 'local', mode: 'snapshot' } });

      expect(res.statusCode).toBe(400);
      expect(res.json()).toEqual({
        error: 'pve-rejected',
        message: 'Parameter verification failed. storage: storage does not exist',
      });
    });
  });

  describe('restore validation (400)', () => {
    it('rejects a bad archive regex', async () => {
      const cookie = await setupSession();
      const res = await restore('/node1/qemu/100', { cookie, payload: { archive: 'not-a-backup-volid' } });
      expect(res.statusCode).toBe(400);
    });

    it('rejects unique for an lxc guest', async () => {
      const cookie = await setupSession();
      const res = await restore('/node1/lxc/200', {
        cookie,
        payload: { archive: 'local:backup/vzdump-lxc-200-2024_01_01-00_00_00.tar.zst', unique: true },
      });
      expect(res.statusCode).toBe(400);
    });

    it('rejects unprivileged for a qemu guest', async () => {
      const cookie = await setupSession();
      const res = await restore('/node1/qemu/100', {
        cookie,
        payload: { archive: 'local:backup/vzdump-qemu-100-2024_01_01-00_00_00.tar.zst', unprivileged: true },
      });
      expect(res.statusCode).toBe(400);
    });

    it('target-exists without force is a 400', async () => {
      const cookie = await setupSession();
      fakePve.setExistingGuest(100, 'stopped');
      const res = await restore('/node1/qemu/100', {
        cookie,
        payload: { archive: 'local:backup/vzdump-qemu-100-2024_01_01-00_00_00.tar.zst' },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json()).toEqual({ error: 'target-exists' });
    });

    it('target-running is a 400 even with force', async () => {
      const cookie = await setupSession();
      fakePve.setExistingGuest(100, 'running');
      const res = await restore('/node1/qemu/100', {
        cookie,
        payload: { archive: 'local:backup/vzdump-qemu-100-2024_01_01-00_00_00.tar.zst', force: true },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json()).toEqual({ error: 'target-running', message: 'Stop the guest before restoring over it' });
    });

    it('force with a target id that does not exist is a 400, and PVE is never called', async () => {
      const cookie = await setupSession();
      // targetVmid 999 does not exist (no setExistingGuest call) -- `force` has nothing to
      // overwrite, so it's rejected outright rather than being silently dropped before PVE.
      const res = await restore('/node1/qemu/100', {
        cookie,
        payload: {
          archive: 'local:backup/vzdump-qemu-100-2024_01_01-00_00_00.tar.zst',
          targetVmid: 999,
          force: true,
        },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json()).toEqual({
        error: 'force-without-target',
        message: 'force is only accepted when restoring over an existing guest',
      });
      expect(fakePve.createCalls).toHaveLength(0);
    });
  });

  describe('restore privilege matrix', () => {
    it('new id requires VM.Allocate', async () => {
      const cookie = await setupSession();
      // targetVmid 999 does not exist; no VM.Allocate granted.
      const res = await restore('/node1/qemu/100', {
        cookie,
        payload: { archive: 'local:backup/vzdump-qemu-100-2024_01_01-00_00_00.tar.zst', targetVmid: 999 },
      });
      expect(res.statusCode).toBe(403);
      expect(res.json()).toEqual({ error: 'forbidden', missing: 'VM.Allocate' });
    });

    it('new id succeeds with VM.Allocate, and PVE receives no force field at all', async () => {
      const cookie = await setupSession();
      fakePve.setVmPermissions(999, { 'VM.Allocate': true });
      const res = await restore('/node1/qemu/100', {
        cookie,
        payload: { archive: 'local:backup/vzdump-qemu-100-2024_01_01-00_00_00.tar.zst', targetVmid: 999 },
      });
      expect(res.statusCode).toBe(202);
      const call = fakePve.createCalls.at(-1);
      expect(call?.body).toEqual({
        vmid: '999',
        archive: 'local:backup/vzdump-qemu-100-2024_01_01-00_00_00.tar.zst',
      });
      expect(call?.body).not.toHaveProperty('force');
    });

    it('overwrite accepts VM.Backup alone', async () => {
      const cookie = await setupSession();
      fakePve.setExistingGuest(100, 'stopped');
      fakePve.setVmPermissions(100, { 'VM.Backup': true });
      const res = await restore('/node1/qemu/100', {
        cookie,
        payload: { archive: 'local:backup/vzdump-qemu-100-2024_01_01-00_00_00.tar.zst', force: true },
      });
      expect(res.statusCode).toBe(202);
    });

    it('overwrite is forbidden without VM.Backup or VM.Allocate', async () => {
      const cookie = await setupSession();
      fakePve.setExistingGuest(100, 'stopped');
      const res = await restore('/node1/qemu/100', {
        cookie,
        payload: { archive: 'local:backup/vzdump-qemu-100-2024_01_01-00_00_00.tar.zst', force: true },
      });
      expect(res.statusCode).toBe(403);
      expect(res.json()).toEqual({ error: 'forbidden', missing: 'VM.Backup or VM.Allocate' });
    });

    it('403s missing Datastore.AllocateSpace when a target storage is given', async () => {
      const cookie = await setupSession();
      fakePve.setVmPermissions(999, { 'VM.Allocate': true });
      const res = await restore('/node1/qemu/100', {
        cookie,
        payload: {
          archive: 'local:backup/vzdump-qemu-100-2024_01_01-00_00_00.tar.zst',
          targetVmid: 999,
          storage: 'local-lvm',
        },
      });
      expect(res.statusCode).toBe(403);
      expect(res.json()).toEqual({ error: 'forbidden', missing: 'Datastore.AllocateSpace' });
    });
  });

  describe('restore param mapping', () => {
    it('qemu: overwrite self sends archive/force/start/unique', async () => {
      const cookie = await setupSession();
      fakePve.setExistingGuest(100, 'stopped');
      fakePve.setVmPermissions(100, { 'VM.Backup': true });

      const res = await restore('/node1/qemu/100', {
        cookie,
        payload: {
          archive: 'local:backup/vzdump-qemu-100-2024_01_01-00_00_00.tar.zst',
          force: true,
          start: false,
          unique: true,
        },
      });

      expect(res.statusCode).toBe(202);
      const call = fakePve.createCalls.at(-1);
      expect(call?.type).toBe('qemu');
      expect(call?.body).toEqual({
        vmid: '100',
        archive: 'local:backup/vzdump-qemu-100-2024_01_01-00_00_00.tar.zst',
        force: '1',
        start: '0',
        unique: '1',
      });
    });

    it('lxc: restore to a new id sends ostemplate/restore, no force', async () => {
      const cookie = await setupSession();
      fakePve.setVmPermissions(999, { 'VM.Allocate': true });

      const res = await restore('/node1/lxc/200', {
        cookie,
        payload: {
          archive: 'local:backup/vzdump-lxc-200-2024_01_01-00_00_00.tar.zst',
          targetVmid: 999,
          unprivileged: true,
        },
      });

      expect(res.statusCode).toBe(202);
      const call = fakePve.createCalls.at(-1);
      expect(call?.type).toBe('lxc');
      expect(call?.body).toEqual({
        vmid: '999',
        ostemplate: 'local:backup/vzdump-lxc-200-2024_01_01-00_00_00.tar.zst',
        restore: '1',
        unprivileged: '1',
      });
    });

    it('surfaces a PVE restore error with field detail', async () => {
      const cookie = await setupSession();
      fakePve.setVmPermissions(999, { 'VM.Allocate': true });
      fakePve.setCreateError('qemu', 999, 400, 'Parameter verification failed.', { archive: 'file does not exist' });

      const res = await restore('/node1/qemu/100', {
        cookie,
        payload: { archive: 'local:backup/vzdump-qemu-100-2024_01_01-00_00_00.tar.zst', targetVmid: 999 },
      });

      expect(res.statusCode).toBe(400);
      expect(res.json()).toEqual({
        error: 'pve-rejected',
        message: 'Parameter verification failed. archive: file does not exist',
      });
    });
  });

  describe('nextid', () => {
    it('proxies GET /cluster/nextid', async () => {
      const cookie = await setupSession();
      fakePve.setNextId(101);
      const res = await nextid('/node1/qemu/100', { cookie });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ vmid: 101 });
    });
  });
});
