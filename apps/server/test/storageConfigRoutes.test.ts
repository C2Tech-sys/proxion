import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance, InjectOptions } from 'fastify';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { composeAddForm, composeEditForm, composePruneBackups } from '../src/actions/storageConfigRoutes.js';
import { startFakePve, type FakePve } from './helpers/fakePve.js';

const ALLOCATE = { 'Datastore.Allocate': true };
const BASE = '/api/actions/datacenter/storage';
const FINGERPRINT = Array.from({ length: 32 }, (_, i) => (i * 7 + 3).toString(16).padStart(2, '0').slice(-2)).join(':');
// A recognisable fake secret: asserting it is absent from logs/responses is only meaningful if it
// would be visible were it present.
const SECRET = 'S3cr3t-Pa55word-do-not-log';

describe('datacenter storage configuration routes (T70)', () => {
  let fakePve: FakePve;
  let app: FastifyInstance;

  afterEach(async () => {
    vi.restoreAllMocks();
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

  /** A signed-in session that may add storage and edit/remove `ids`. */
  async function setupAllowed(...ids: string[]): Promise<string> {
    const cookie = await setupSession();
    fakePve.setPathPermissions('/storage', ALLOCATE);
    for (const id of ids) fakePve.setPathPermissions(`/storage/${id}`, ALLOCATE);
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

  /** Every argument any `app.log` level was called with, as one string. */
  function spyOnLogs() {
    const spies = (['trace', 'debug', 'info', 'warn', 'error', 'fatal'] as const).map((level) =>
      vi.spyOn(app.log, level),
    );
    return () => JSON.stringify(spies.flatMap((spy) => spy.mock.calls));
  }

  const NFS = { type: 'nfs', storage: 'nfs1', server: '10.0.0.5', export: '/srv/pve', content: ['backup', 'iso'] };

  describe('token mode', () => {
    it('POST, PUT and DELETE all 403 without any PVE write', async () => {
      await setupTokenMode();
      const post = await call('POST', '', { payload: NFS });
      expect(post.statusCode).toBe(403);
      expect(post.json()).toEqual({ error: 'writes-disabled-in-token-mode' });
      const put = await call('PUT', '/nfs1', { payload: { disable: true } });
      expect(put.statusCode).toBe(403);
      expect(put.json()).toEqual({ error: 'writes-disabled-in-token-mode' });
      const del = await call('DELETE', '/nfs1');
      expect(del.statusCode).toBe(403);
      expect(del.json()).toEqual({ error: 'writes-disabled-in-token-mode' });
      expect(fakePve.storageConfigCalls).toHaveLength(0);
    });
  });

  describe('authentication and privilege', () => {
    it('401s without a session', async () => {
      await setupSession();
      for (const [method, path] of [
        ['POST', ''],
        ['PUT', '/nfs1'],
        ['DELETE', '/nfs1'],
      ] as const) {
        const res = await call(method, path, { payload: method === 'DELETE' ? undefined : method === 'PUT' ? { disable: true } : NFS });
        expect(res.statusCode).toBe(401);
      }
      expect(fakePve.storageConfigCalls).toHaveLength(0);
    });

    it('POST 403s naming Datastore.Allocate without it on /storage', async () => {
      const cookie = await setupSession();
      fakePve.setPathPermissions('/storage', { 'Datastore.Audit': true });
      const res = await call('POST', '', { cookie, payload: NFS });
      expect(res.statusCode).toBe(403);
      expect(res.json()).toEqual({ error: 'forbidden', missing: 'Datastore.Allocate' });
      expect(fakePve.storageConfigCalls).toHaveLength(0);
    });

    it('PUT and DELETE 403 without it on /storage/<id>, even with it on /storage', async () => {
      const cookie = await setupSession();
      fakePve.setPathPermissions('/storage', ALLOCATE);
      fakePve.setStorageConfig('nfs1', { storage: 'nfs1', type: 'nfs' });
      const put = await call('PUT', '/nfs1', { cookie, payload: { disable: true } });
      expect(put.statusCode).toBe(403);
      expect(put.json()).toEqual({ error: 'forbidden', missing: 'Datastore.Allocate' });
      const del = await call('DELETE', '/nfs1', { cookie });
      expect(del.statusCode).toBe(403);
      expect(fakePve.storageConfigCalls).toHaveLength(0);
    });
  });

  describe('add: body validation (400, before any PVE call)', () => {
    async function expect400(payload: unknown) {
      const cookie = await setupAllowed();
      const res = await call('POST', '', { cookie, payload });
      expect(res.statusCode).toBe(400);
      expect(fakePve.storageConfigCalls).toHaveLength(0);
      return res;
    }

    it('rejects an unknown type, a missing type and an unknown key', async () => {
      await expect400({ ...NFS, type: 'iscsi' });
      await expect400({ storage: 'x1', content: ['iso'] });
      await expect400({ ...NFS, bogus: 1 });
      await expect400({ ...NFS, path: '/srv' });
    });

    it('rejects a bad storage id', async () => {
      await expect400({ ...NFS, storage: 'a' });
      await expect400({ ...NFS, storage: '1nfs' });
      await expect400({ ...NFS, storage: 'nfs/1' });
      await expect400({ ...NFS, storage: 'nfs,1' });
    });

    it('rejects empty, duplicate or unsupported content', async () => {
      await expect400({ ...NFS, content: [] });
      await expect400({ ...NFS, content: ['iso', 'iso'] });
      await expect400({ ...NFS, content: ['bogus'] });
      await expect400({ type: 'lvm', storage: 'vg1', vgname: 'vg', content: ['backup'] });
      await expect400({ type: 'zfspool', storage: 'zp1', pool: 'tank', content: ['iso'] });
      await expect400({ type: 'pbs', storage: 'pbs1', server: 'pbs', datastore: 'ds1', username: 'a@pbs', password: 'x', content: ['iso'] });
    });

    it('rejects a bad dir path, nfs export, option injection, host and nodes', async () => {
      await expect400({ type: 'dir', storage: 'dir1', path: 'relative', content: ['iso'] });
      await expect400({ type: 'dir', storage: 'dir1', path: '/mnt/../etc', content: ['iso'] });
      await expect400({ ...NFS, export: 'srv' });
      await expect400({ ...NFS, options: 'vers=4;rm' });
      await expect400({ ...NFS, server: 'bad host' });
      await expect400({ ...NFS, nodes: ['pve1,pve2'] });
    });

    it('rejects a bad cifs smbversion/share, a bad zfs blocksize and an empty password', async () => {
      const cifs = { type: 'cifs', storage: 'smb1', server: 'nas', share: 'media', content: ['backup'] };
      await expect400({ ...cifs, smbversion: '4.0' });
      await expect400({ ...cifs, share: 'a/b' });
      await expect400({ ...cifs, password: '' });
      await expect400({ type: 'zfspool', storage: 'zp1', pool: 'tank', content: ['images'], blocksize: '16 k' });
    });

    it('rejects a pbs username without @, a bad fingerprint and a missing password', async () => {
      const pbs = { type: 'pbs', storage: 'pbs1', server: 'pbs.lan', datastore: 'ds1', username: 'backup@pbs', password: 'pw', content: ['backup'] };
      await expect400({ ...pbs, username: 'backup' });
      await expect400({ ...pbs, fingerprint: 'AA:BB' });
      const { password: _omitted, ...withoutPassword } = pbs;
      void _omitted;
      await expect400(withoutPassword);
    });

    it('rejects keep-all with other keep values and an out-of-range keep count', async () => {
      await expect400({ ...NFS, prune: { keepAll: true, keepLast: 3 } });
      await expect400({ ...NFS, prune: { keepLast: 366 } });
      await expect400({ ...NFS, prune: { keepLast: 1.5 } });
      await expect400({ ...NFS, prune: { keepFoo: 1 } });
    });
  });

  describe('add: the exact PVE form per type', () => {
    it('nfs', async () => {
      const cookie = await setupAllowed();
      const res = await call('POST', '', { cookie, payload: { ...NFS, prune: { keepLast: 3 } } });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ ok: true, storage: 'nfs1' });
      expect(fakePve.storageConfigCalls).toStrictEqual([
        {
          method: 'POST',
          path: '/storage',
          body: {
            storage: 'nfs1',
            type: 'nfs',
            server: '10.0.0.5',
            export: '/srv/pve',
            content: 'backup,iso',
            'prune-backups': 'keep-last=3',
          },
        },
      ]);
    });

    it('nfs with options, nodes, disabled and a multi-key retention', async () => {
      const cookie = await setupAllowed();
      const res = await call('POST', '', {
        cookie,
        payload: {
          ...NFS,
          options: 'vers=4.2,soft',
          nodes: ['pve1', 'pve2'],
          disable: true,
          prune: { keepLast: 3, keepDaily: 7, keepMonthly: 6 },
        },
      });
      expect(res.statusCode).toBe(200);
      expect(fakePve.storageConfigCalls[0]!.body).toStrictEqual({
        storage: 'nfs1',
        type: 'nfs',
        server: '10.0.0.5',
        export: '/srv/pve',
        content: 'backup,iso',
        options: 'vers=4.2,soft',
        nodes: 'pve1,pve2',
        disable: '1',
        'prune-backups': 'keep-last=3,keep-daily=7,keep-monthly=6',
      });
    });

    it('dir (shared, preallocation) and keep-all', async () => {
      const cookie = await setupAllowed();
      const res = await call('POST', '', {
        cookie,
        payload: {
          type: 'dir',
          storage: 'dir1',
          path: '/mnt/data',
          content: ['iso', 'vztmpl', 'backup'],
          shared: true,
          preallocation: 'metadata',
          prune: { keepAll: true },
        },
      });
      expect(res.statusCode).toBe(200);
      expect(fakePve.storageConfigCalls[0]!.body).toStrictEqual({
        storage: 'dir1',
        type: 'dir',
        path: '/mnt/data',
        content: 'iso,vztmpl,backup',
        shared: '1',
        preallocation: 'metadata',
        'prune-backups': 'keep-all=1',
      });
    });

    it('cifs', async () => {
      const cookie = await setupAllowed();
      const res = await call('POST', '', {
        cookie,
        payload: {
          type: 'cifs',
          storage: 'smb1',
          server: 'nas.lan',
          share: 'proxmox',
          username: 'svc-pve',
          password: SECRET,
          domain: 'CORP',
          subdir: '/backups',
          smbversion: '3.11',
          content: ['backup'],
        },
      });
      expect(res.statusCode).toBe(200);
      expect(fakePve.storageConfigCalls[0]!.body).toStrictEqual({
        storage: 'smb1',
        type: 'cifs',
        server: 'nas.lan',
        share: 'proxmox',
        content: 'backup',
        username: 'svc-pve',
        password: SECRET,
        domain: 'CORP',
        subdir: '/backups',
        smbversion: '3.11',
      });
    });

    it('lvm', async () => {
      const cookie = await setupAllowed();
      const res = await call('POST', '', {
        cookie,
        payload: { type: 'lvm', storage: 'lvm1', vgname: 'vg_data', content: ['images', 'rootdir'], shared: true },
      });
      expect(res.statusCode).toBe(200);
      expect(fakePve.storageConfigCalls[0]!.body).toStrictEqual({
        storage: 'lvm1',
        type: 'lvm',
        vgname: 'vg_data',
        content: 'images,rootdir',
        shared: '1',
      });
    });

    it('lvmthin', async () => {
      const cookie = await setupAllowed();
      const res = await call('POST', '', {
        cookie,
        payload: { type: 'lvmthin', storage: 'thin1', vgname: 'pve', thinpool: 'data', content: ['images'], nodes: ['pve1'] },
      });
      expect(res.statusCode).toBe(200);
      expect(fakePve.storageConfigCalls[0]!.body).toStrictEqual({
        storage: 'thin1',
        type: 'lvmthin',
        vgname: 'pve',
        thinpool: 'data',
        content: 'images',
        nodes: 'pve1',
      });
    });

    it('zfspool', async () => {
      const cookie = await setupAllowed();
      const res = await call('POST', '', {
        cookie,
        payload: {
          type: 'zfspool',
          storage: 'zfs1',
          pool: 'tank/vm',
          content: ['images', 'rootdir'],
          sparse: true,
          blocksize: '16k',
          mountpoint: '/tank/vm',
        },
      });
      expect(res.statusCode).toBe(200);
      expect(fakePve.storageConfigCalls[0]!.body).toStrictEqual({
        storage: 'zfs1',
        type: 'zfspool',
        pool: 'tank/vm',
        content: 'images,rootdir',
        sparse: '1',
        blocksize: '16k',
        mountpoint: '/tank/vm',
      });
    });

    it('pbs', async () => {
      const cookie = await setupAllowed();
      const res = await call('POST', '', {
        cookie,
        payload: {
          type: 'pbs',
          storage: 'pbs1',
          server: 'pbs.lan',
          datastore: 'store1',
          username: 'backup@pbs',
          password: SECRET,
          fingerprint: FINGERPRINT,
          namespace: 'prod/vms',
          content: ['backup'],
          prune: { keepLast: 5, keepWeekly: 4 },
        },
      });
      expect(res.statusCode).toBe(200);
      expect(fakePve.storageConfigCalls[0]!.body).toStrictEqual({
        storage: 'pbs1',
        type: 'pbs',
        server: 'pbs.lan',
        datastore: 'store1',
        content: 'backup',
        username: 'backup@pbs',
        password: SECRET,
        fingerprint: FINGERPRINT,
        namespace: 'prod/vms',
        'prune-backups': 'keep-last=5,keep-weekly=4',
      });
    });
  });

  describe('passwords are never logged or echoed', () => {
    const PBS = {
      type: 'pbs',
      storage: 'pbs1',
      server: 'pbs.lan',
      datastore: 'store1',
      username: 'backup@pbs',
      password: SECRET,
      content: ['backup'],
    };

    it('add pbs: not in the response or in any log call (control: the storage id is)', async () => {
      const cookie = await setupAllowed();
      const logged = spyOnLogs();
      const res = await call('POST', '', { cookie, payload: PBS });
      expect(res.statusCode).toBe(200);
      expect(res.body).not.toContain(SECRET);
      expect(logged()).toContain('pbs1');
      expect(logged()).not.toContain(SECRET);
    });

    it('add cifs rejected by PVE: neither the relayed error nor the logs carry it', async () => {
      const cookie = await setupAllowed();
      fakePve.setStorageConfigError({ status: 500, message: 'mount error' });
      const logged = spyOnLogs();
      const cifs = { type: 'cifs', storage: 'smb1', server: 'nas', share: 'media', username: 'u', password: SECRET, content: ['backup'] };
      const res = await call('POST', '', { cookie, payload: cifs });
      expect(res.statusCode).toBe(502);
      expect(res.body).not.toContain(SECRET);
      expect(logged()).not.toContain(SECRET);
    });

    it('edit cifs with a new password: sent to PVE once, absent from the response and logs (control: the key is logged)', async () => {
      const cookie = await setupAllowed('smb1');
      fakePve.setStorageConfig('smb1', { storage: 'smb1', type: 'cifs' });
      const logged = spyOnLogs();
      const res = await call('PUT', '/smb1', { cookie, payload: { password: SECRET } });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ ok: true, storage: 'smb1', changed: ['password'] });
      expect(fakePve.storageConfigCalls[0]!.body).toStrictEqual({ password: SECRET });
      expect(res.body).not.toContain(SECRET);
      expect(logged()).toContain('password');
      expect(logged()).not.toContain(SECRET);
    });

    it('a 400 for a bad body does not log or echo the submitted password', async () => {
      const cookie = await setupAllowed();
      const logged = spyOnLogs();
      const res = await call('POST', '', { cookie, payload: { ...PBS, username: 'no-at-sign' } });
      expect(res.statusCode).toBe(400);
      expect(res.body).not.toContain(SECRET);
      expect(logged()).not.toContain(SECRET);
    });
  });

  describe('edit', () => {
    it('sends content and nodes as comma-joined strings', async () => {
      const cookie = await setupAllowed('nfs1');
      fakePve.setStorageConfig('nfs1', { storage: 'nfs1', type: 'nfs' });
      const res = await call('PUT', '/nfs1', { cookie, payload: { content: ['backup', 'iso'], nodes: ['pve1', 'pve2'] } });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ ok: true, storage: 'nfs1', changed: ['content', 'nodes'] });
      expect(fakePve.storageConfigCalls).toStrictEqual([
        { method: 'PUT', path: '/storage/nfs1', body: { content: 'backup,iso', nodes: 'pve1,pve2' } },
      ]);
    });

    it('a cleared nodes list (null or empty) becomes delete: nodes', async () => {
      const cookie = await setupAllowed('nfs1');
      fakePve.setStorageConfig('nfs1', { storage: 'nfs1', type: 'nfs' });
      expect((await call('PUT', '/nfs1', { cookie, payload: { nodes: null, disable: false } })).statusCode).toBe(200);
      expect((await call('PUT', '/nfs1', { cookie, payload: { nodes: [] } })).statusCode).toBe(200);
      expect(fakePve.storageConfigCalls.map((c) => c.body)).toStrictEqual([
        { disable: '0', delete: 'nodes' },
        { delete: 'nodes' },
      ]);
    });

    it('several cleared properties share one delete list; prune sets or clears prune-backups', async () => {
      const cookie = await setupAllowed('nfs1');
      fakePve.setStorageConfig('nfs1', { storage: 'nfs1', type: 'nfs' });
      await call('PUT', '/nfs1', { cookie, payload: { nodes: null, options: null, prune: null } });
      await call('PUT', '/nfs1', { cookie, payload: { prune: { keepLast: 2, keepYearly: 1 }, options: 'vers=3' } });
      await call('PUT', '/nfs1', { cookie, payload: { prune: {} } });
      expect(fakePve.storageConfigCalls.map((c) => c.body)).toStrictEqual([
        { delete: 'nodes,options,prune-backups' },
        { 'prune-backups': 'keep-last=2,keep-yearly=1', options: 'vers=3' },
        { delete: 'prune-backups' },
      ]);
    });

    it('dir: shared and disable are sent as 0/1', async () => {
      const cookie = await setupAllowed('dir1');
      fakePve.setStorageConfig('dir1', { storage: 'dir1', type: 'dir' });
      const res = await call('PUT', '/dir1', { cookie, payload: { shared: false, disable: true, bwlimit: 51200, preallocation: 'full' } });
      expect(res.statusCode).toBe(200);
      expect(fakePve.storageConfigCalls[0]!.body).toStrictEqual({
        disable: '1',
        shared: '0',
        bwlimit: '51200',
        preallocation: 'full',
      });
    });

    it('password { keep: true } sends nothing to PVE at all', async () => {
      const cookie = await setupAllowed('pbs1');
      fakePve.setStorageConfig('pbs1', { storage: 'pbs1', type: 'pbs' });
      const res = await call('PUT', '/pbs1', { cookie, payload: { password: { keep: true } } });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ ok: true, storage: 'pbs1', changed: [] });
      expect(fakePve.storageConfigCalls).toHaveLength(0);
    });

    it('password { keep: true } beside other changes leaves the password out of the form', async () => {
      const cookie = await setupAllowed('pbs1');
      fakePve.setStorageConfig('pbs1', { storage: 'pbs1', type: 'pbs' });
      const res = await call('PUT', '/pbs1', {
        cookie,
        payload: { password: { keep: true }, fingerprint: FINGERPRINT, namespace: null },
      });
      expect(res.statusCode).toBe(200);
      expect(fakePve.storageConfigCalls[0]!.body).toStrictEqual({ fingerprint: FINGERPRINT, delete: 'namespace' });
    });

    it('400s a field that does not apply to the storage type, without a PVE write', async () => {
      const cookie = await setupAllowed('nfs1', 'zfs1', 'pbs1');
      fakePve.setStorageConfig('nfs1', { storage: 'nfs1', type: 'nfs' });
      fakePve.setStorageConfig('zfs1', { storage: 'zfs1', type: 'zfspool' });
      fakePve.setStorageConfig('pbs1', { storage: 'pbs1', type: 'pbs' });
      const shared = await call('PUT', '/nfs1', { cookie, payload: { shared: true } });
      expect(shared.statusCode).toBe(400);
      expect(shared.json()).toMatchObject({ error: 'invalid-field-for-type' });
      expect((await call('PUT', '/zfs1', { cookie, payload: { options: 'x' } })).statusCode).toBe(400);
      expect((await call('PUT', '/pbs1', { cookie, payload: { preallocation: 'off' } })).statusCode).toBe(400);
      expect(fakePve.storageConfigCalls).toHaveLength(0);
    });

    it('400s content the storage type does not support', async () => {
      const cookie = await setupAllowed('zfs1', 'pbs1');
      fakePve.setStorageConfig('zfs1', { storage: 'zfs1', type: 'zfspool' });
      fakePve.setStorageConfig('pbs1', { storage: 'pbs1', type: 'pbs' });
      const zfs = await call('PUT', '/zfs1', { cookie, payload: { content: ['images', 'iso'] } });
      expect(zfs.statusCode).toBe(400);
      expect(zfs.json()).toMatchObject({ error: 'invalid-content' });
      expect((await call('PUT', '/pbs1', { cookie, payload: { content: ['backup', 'iso'] } })).statusCode).toBe(400);
      expect(fakePve.storageConfigCalls).toHaveLength(0);
    });

    it('400s an empty body, an unknown key and a bad storage id; 404 from PVE for an unknown storage', async () => {
      const cookie = await setupAllowed('nfs1', 'ghost');
      fakePve.setStorageConfig('nfs1', { storage: 'nfs1', type: 'nfs' });
      expect((await call('PUT', '/nfs1', { cookie, payload: {} })).statusCode).toBe(400);
      expect((await call('PUT', '/nfs1', { cookie, payload: { server: 'evil' } })).statusCode).toBe(400);
      expect((await call('PUT', '/1bad', { cookie, payload: { disable: true } })).statusCode).toBe(400);
      const ghost = await call('PUT', '/ghost', { cookie, payload: { disable: true } });
      expect(ghost.statusCode).toBe(404);
      expect(ghost.json()).toMatchObject({ error: 'pve-rejected' });
      expect(fakePve.storageConfigCalls).toHaveLength(0);
    });

    it('relays a PVE 4xx (with its field errors) and maps a 5xx to 502', async () => {
      const cookie = await setupAllowed('nfs1');
      fakePve.setStorageConfig('nfs1', { storage: 'nfs1', type: 'nfs' });
      fakePve.setStorageConfigError({ status: 400, message: 'Parameter verification failed.', errors: { options: 'invalid format' } });
      const rejected = await call('PUT', '/nfs1', { cookie, payload: { options: 'vers=9' } });
      expect(rejected.statusCode).toBe(400);
      expect(rejected.json()).toEqual({
        error: 'pve-rejected',
        message: 'Parameter verification failed. options: invalid format',
      });
      fakePve.setStorageConfigError({ status: 500, message: 'boom' });
      const down = await call('PUT', '/nfs1', { cookie, payload: { options: 'vers=4' } });
      expect(down.statusCode).toBe(502);
      expect(down.json()).toEqual({ error: 'pve-unreachable' });
    });
  });

  describe('add: PVE errors', () => {
    it('relays a PVE 4xx and maps a 5xx to 502', async () => {
      const cookie = await setupAllowed();
      fakePve.setStorageConfigError({ status: 400, message: 'storage ID nfs1 already defined' });
      const rejected = await call('POST', '', { cookie, payload: NFS });
      expect(rejected.statusCode).toBe(400);
      expect(rejected.json()).toEqual({ error: 'pve-rejected', message: 'storage ID nfs1 already defined' });
      fakePve.setStorageConfigError({ status: 503, message: 'unavailable' });
      const down = await call('POST', '', { cookie, payload: NFS });
      expect(down.statusCode).toBe(502);
      expect(down.json()).toEqual({ error: 'pve-unreachable' });
    });
  });

  describe('delete', () => {
    it('sends DELETE /storage/{id} and reports ok', async () => {
      const cookie = await setupAllowed('nfs1');
      const res = await call('DELETE', '/nfs1', { cookie });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ ok: true });
      expect(fakePve.storageConfigCalls).toStrictEqual([{ method: 'DELETE', path: '/storage/nfs1', body: {} }]);
    });

    it('refuses the built-in local storage with a 400, before any PVE call', async () => {
      const cookie = await setupAllowed('local');
      const res = await call('DELETE', '/local', { cookie });
      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({ error: 'cannot-remove-local' });
      expect(fakePve.storageConfigCalls).toHaveLength(0);
    });

    it('400s a bad id and relays a PVE 4xx / 5xx', async () => {
      const cookie = await setupAllowed('nfs1');
      expect((await call('DELETE', '/1bad', { cookie })).statusCode).toBe(400);
      fakePve.setStorageConfigError({ status: 400, message: 'storage is still in use' });
      const rejected = await call('DELETE', '/nfs1', { cookie });
      expect(rejected.statusCode).toBe(400);
      expect(rejected.json()).toEqual({ error: 'pve-rejected', message: 'storage is still in use' });
      fakePve.setStorageConfigError({ status: 500, message: 'boom' });
      expect((await call('DELETE', '/nfs1', { cookie })).statusCode).toBe(502);
    });
  });

  describe('reads go through the read-only proxy', () => {
    it('GET /api/pve/nodes/{node}/scan/nfs reaches PVE with its query and returns the rows', async () => {
      const cookie = await setupSession();
      fakePve.setScanResult('nfs', [{ path: '/srv/pve', options: '*' }]);
      const res = await app.inject({ method: 'GET', url: '/api/pve/nodes/pve1/scan/nfs?server=10.0.0.5', headers: { cookie } });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ data: [{ path: '/srv/pve', options: '*' }] });
      expect(fakePve.scanCalls).toStrictEqual([{ kind: 'nfs', query: { server: '10.0.0.5' } }]);
    });

    it('the proxy still refuses a write to /storage', async () => {
      const cookie = await setupAllowed();
      const res = await app.inject({ method: 'POST', url: '/api/pve/storage', headers: { cookie }, payload: {} });
      expect(res.statusCode).toBe(405);
      expect(fakePve.storageConfigCalls).toHaveLength(0);
    });
  });

  describe('composition helpers', () => {
    it('composePruneBackups orders keys, honours keep-all and returns undefined for nothing', () => {
      expect(composePruneBackups({ keepYearly: 1, keepLast: 3, keepDaily: 0 })).toBe('keep-last=3,keep-daily=0,keep-yearly=1');
      expect(composePruneBackups({ keepAll: true })).toBe('keep-all=1');
      expect(composePruneBackups({})).toBeUndefined();
    });

    it('composeAddForm omits false booleans and an empty node list', () => {
      expect(
        composeAddForm({ type: 'dir', storage: 'dir1', path: '/mnt/a', content: ['iso'], shared: false, disable: false, nodes: [] }),
      ).toStrictEqual({ storage: 'dir1', type: 'dir', path: '/mnt/a', content: 'iso' });
    });

    it('composeEditForm reports the keys it changes, never values', () => {
      const { form, changed } = composeEditForm({ password: SECRET, nodes: null });
      expect(form).toStrictEqual({ password: SECRET, delete: 'nodes' });
      expect(changed).toStrictEqual(['nodes', 'password']);
    });
  });
});
