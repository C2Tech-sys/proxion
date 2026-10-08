import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance, InjectOptions } from 'fastify';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { startFakePve, type FakePve } from './helpers/fakePve.js';

const BASE = '/api/actions/datacenter/backup-jobs';

describe('datacenter backup job routes', () => {
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

  function call(
    method: 'POST' | 'PUT' | 'DELETE',
    path: string,
    options: { cookie?: string; payload?: Record<string, unknown> } = {},
  ) {
    const injectOptions: InjectOptions = { method, url: `${BASE}${path}` };
    if (options.cookie !== undefined) injectOptions.headers = { cookie: options.cookie };
    if (options.payload !== undefined) injectOptions.payload = options.payload;
    return app.inject(injectOptions);
  }

  const minimalCreate = {
    schedule: '02:00',
    storage: 'backup-nfs',
    selection: { kind: 'all' },
  };

  /** Session with Sys.Modify on `/` and two existing jobs. */
  async function setupAdmin(): Promise<string> {
    const cookie = await setupSession();
    fakePve.setRootPermissions({ 'Sys.Modify': true });
    fakePve.setBackupJobs([
      { id: 'nightly', schedule: '02:00', storage: 'backup-nfs', all: 1, exclude: '104', pool: undefined },
      { id: 'weekly', schedule: 'sun 01:00', storage: 'backup-nfs', pool: 'prod', comment: 'weekly prod' },
    ]);
    return cookie;
  }

  describe('create (POST /)', () => {
    it('403s in token mode before any PVE call', async () => {
      await setupTokenMode();
      const before = fakePve.requestCount;
      const res = await call('POST', '', { payload: minimalCreate });
      expect(res.statusCode).toBe(403);
      expect(res.json()).toEqual({ error: 'writes-disabled-in-token-mode' });
      expect(fakePve.requestCount).toBe(before);
      expect(fakePve.backupJobCalls).toHaveLength(0);
    });

    it('401s without a session', async () => {
      await setupSession();
      const res = await call('POST', '', { payload: minimalCreate });
      expect(res.statusCode).toBe(401);
      expect(fakePve.backupJobCalls).toHaveLength(0);
    });

    it('403s without Sys.Modify on / and writes nothing', async () => {
      const cookie = await setupSession();
      const res = await call('POST', '', { cookie, payload: minimalCreate });
      expect(res.statusCode).toBe(403);
      expect(res.json()).toEqual({ error: 'forbidden', missing: 'Sys.Modify' });
      expect(fakePve.backupJobCalls).toHaveLength(0);
    });

    it('rejects a schedule outside the calendar-event alphabet (400)', async () => {
      const cookie = await setupAdmin();
      for (const schedule of ['02:00; rm -rf /', '', '   ', 'x'.repeat(129), 'mon\n02:00']) {
        const res = await call('POST', '', { cookie, payload: { ...minimalCreate, schedule } });
        expect(res.statusCode).toBe(400);
      }
      expect(fakePve.backupJobCalls).toHaveLength(0);
    });

    it('rejects a missing storage, a bad storage id, an unknown key and a bad mode/compress (400)', async () => {
      const cookie = await setupAdmin();
      const bad: Array<Record<string, unknown>> = [
        { schedule: '02:00', selection: { kind: 'all' } },
        { ...minimalCreate, storage: 'bad storage!' },
        { ...minimalCreate, dumpdir: '/tmp' },
        { ...minimalCreate, mode: 'hibernate' },
        { ...minimalCreate, compress: 'bzip2' },
        { ...minimalCreate, node: null },
      ];
      for (const payload of bad) {
        const res = await call('POST', '', { cookie, payload });
        expect(res.statusCode).toBe(400);
      }
      expect(fakePve.backupJobCalls).toHaveLength(0);
    });

    it('sends the documented defaults for a minimal body (enabled, snapshot, zstd) and returns the new id', async () => {
      const cookie = await setupAdmin();
      const res = await call('POST', '', { cookie, payload: minimalCreate });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ ok: true, id: 'backup-fake-1' });
      expect(fakePve.backupJobCalls).toHaveLength(1);
      expect(fakePve.backupJobCalls[0]).toStrictEqual({
        method: 'POST',
        id: '',
        body: {
          schedule: '02:00',
          enabled: '1',
          storage: 'backup-nfs',
          mode: 'snapshot',
          compress: 'zstd',
          all: '1',
        },
      });
    });

    it('composes an all-guests selection with an exclude list', async () => {
      const cookie = await setupAdmin();
      const res = await call('POST', '', {
        cookie,
        payload: { ...minimalCreate, selection: { kind: 'all', exclude: [100, 101] } },
      });
      expect(res.statusCode).toBe(200);
      expect(fakePve.backupJobCalls[0]?.body).toMatchObject({ all: '1', exclude: '100,101' });
      expect(fakePve.backupJobCalls[0]?.body).not.toHaveProperty('pool');
      expect(fakePve.backupJobCalls[0]?.body).not.toHaveProperty('vmid');
    });

    it('composes a pool selection', async () => {
      const cookie = await setupAdmin();
      const res = await call('POST', '', {
        cookie,
        payload: { ...minimalCreate, selection: { kind: 'pool', pool: 'prod' } },
      });
      expect(res.statusCode).toBe(200);
      const body = fakePve.backupJobCalls[0]?.body ?? {};
      expect(body.pool).toBe('prod');
      expect(body).not.toHaveProperty('all');
      expect(body).not.toHaveProperty('vmid');
    });

    it('composes a guest-list selection as a comma-joined vmid', async () => {
      const cookie = await setupAdmin();
      const res = await call('POST', '', {
        cookie,
        payload: { ...minimalCreate, selection: { kind: 'vmids', vmids: [100, 102] } },
      });
      expect(res.statusCode).toBe(200);
      const body = fakePve.backupJobCalls[0]?.body ?? {};
      expect(body.vmid).toBe('100,102');
      expect(body).not.toHaveProperty('all');
      expect(body).not.toHaveProperty('pool');
    });

    it('rejects an empty guest list, an invalid pool name and a malformed selection (400)', async () => {
      const cookie = await setupAdmin();
      const selections: unknown[] = [
        { kind: 'vmids', vmids: [] },
        { kind: 'vmids', vmids: [5] },
        { kind: 'pool', pool: 'a b' },
        { kind: 'pool' },
        { kind: 'everything' },
        { kind: 'all', pool: 'prod' },
      ];
      for (const selection of selections) {
        const res = await call('POST', '', { cookie, payload: { ...minimalCreate, selection } });
        expect(res.statusCode).toBe(400);
      }
      expect(fakePve.backupJobCalls).toHaveLength(0);
    });

    it('composes the prune-backups property string in PVE order and keep-all alone', async () => {
      const cookie = await setupAdmin();
      let res = await call('POST', '', {
        cookie,
        payload: { ...minimalCreate, pruneBackups: { keepDaily: 7, keepLast: 3 } },
      });
      expect(res.statusCode).toBe(200);
      expect(fakePve.backupJobCalls[0]?.body['prune-backups']).toBe('keep-last=3,keep-daily=7');

      res = await call('POST', '', { cookie, payload: { ...minimalCreate, pruneBackups: { keepAll: true } } });
      expect(res.statusCode).toBe(200);
      expect(fakePve.backupJobCalls[1]?.body['prune-backups']).toBe('keep-all=1');

      await call('POST', '', {
        cookie,
        payload: { ...minimalCreate, pruneBackups: { keepWeekly: 4, keepMonthly: 6, keepYearly: 1, keepHourly: 2 } },
      });
      expect(fakePve.backupJobCalls[2]?.body['prune-backups']).toBe(
        'keep-hourly=2,keep-weekly=4,keep-monthly=6,keep-yearly=1',
      );
    });

    it('omits an empty prune policy and rejects keepAll mixed with keep-* or an out-of-range value (400)', async () => {
      const cookie = await setupAdmin();
      let res = await call('POST', '', { cookie, payload: { ...minimalCreate, pruneBackups: {} } });
      expect(res.statusCode).toBe(200);
      expect(fakePve.backupJobCalls[0]?.body).not.toHaveProperty('prune-backups');

      for (const pruneBackups of [{ keepAll: true, keepLast: 3 }, { keepLast: 366 }, { keepLast: 1.5 }, { keep: 1 }]) {
        res = await call('POST', '', { cookie, payload: { ...minimalCreate, pruneBackups } });
        expect(res.statusCode).toBe(400);
      }
      expect(fakePve.backupJobCalls).toHaveLength(1);
    });

    it('joins mailto with commas and maps the notification keys', async () => {
      const cookie = await setupAdmin();
      const res = await call('POST', '', {
        cookie,
        payload: {
          ...minimalCreate,
          mailto: ['ops@example.com', 'backup@example.org'],
          mailnotification: 'failure',
          notificationMode: 'legacy-sendmail',
        },
      });
      expect(res.statusCode).toBe(200);
      expect(fakePve.backupJobCalls[0]?.body).toMatchObject({
        mailto: 'ops@example.com,backup@example.org',
        mailnotification: 'failure',
        'notification-mode': 'legacy-sendmail',
      });
    });

    it('rejects a mailto entry that is not a bare address and more than 10 recipients (400)', async () => {
      const cookie = await setupAdmin();
      const lists: string[][] = [
        ['ops@example.com,evil@example.com'],
        ['Ops <ops@example.com>'],
        ['not-an-address'],
        Array.from({ length: 11 }, (_, i) => `u${i}@example.com`),
      ];
      for (const mailto of lists) {
        const res = await call('POST', '', { cookie, payload: { ...minimalCreate, mailto } });
        expect(res.statusCode).toBe(400);
      }
      const res = await call('POST', '', { cookie, payload: { ...minimalCreate, mailnotification: 'never' } });
      expect(res.statusCode).toBe(400);
      expect(fakePve.backupJobCalls).toHaveLength(0);
    });

    it('maps the advanced options to their PVE names', async () => {
      const cookie = await setupAdmin();
      const res = await call('POST', '', {
        cookie,
        payload: {
          ...minimalCreate,
          enabled: false,
          mode: 'stop',
          compress: '0',
          node: 'pve2',
          comment: 'nightly full',
          repeatMissed: true,
          bwlimit: 51200,
          zstd: 4,
          ionice: 7,
          lockwait: 60,
          stopwait: 5,
          protected: true,
        },
      });
      expect(res.statusCode).toBe(200);
      expect(fakePve.backupJobCalls[0]?.body).toStrictEqual({
        schedule: '02:00',
        enabled: '0',
        storage: 'backup-nfs',
        mode: 'stop',
        compress: '0',
        all: '1',
        node: 'pve2',
        comment: 'nightly full',
        'repeat-missed': '1',
        bwlimit: '51200',
        zstd: '4',
        ionice: '7',
        lockwait: '60',
        stopwait: '5',
        protected: '1',
      });
    });

    it('rejects a multi-line comment, out-of-range numbers and a bad node name (400)', async () => {
      const cookie = await setupAdmin();
      const bad: Array<Record<string, unknown>> = [
        { comment: 'line one\nline two' },
        { comment: 'x'.repeat(513) },
        { ionice: 9 },
        { zstd: 65 },
        { bwlimit: -1 },
        { node: 'pve 1' },
        { node: 'pve1; reboot' },
      ];
      for (const extra of bad) {
        const res = await call('POST', '', { cookie, payload: { ...minimalCreate, ...extra } });
        expect(res.statusCode).toBe(400);
      }
      expect(fakePve.backupJobCalls).toHaveLength(0);
    });

    it('relays a PVE 4xx as pve-rejected with the sanitized message', async () => {
      const cookie = await setupAdmin();
      fakePve.setBackupJobError({ status: 400, message: 'Parameter verification failed.', errors: { schedule: 'invalid format' } });
      const res = await call('POST', '', { cookie, payload: minimalCreate });
      expect(res.statusCode).toBe(400);
      expect(res.json()).toEqual({
        error: 'pve-rejected',
        message: 'Parameter verification failed. schedule: invalid format',
      });
    });

    it('maps a PVE 5xx to 502 pve-unreachable', async () => {
      const cookie = await setupAdmin();
      fakePve.setBackupJobError({ status: 500, message: 'internal error' });
      const res = await call('POST', '', { cookie, payload: minimalCreate });
      expect(res.statusCode).toBe(502);
      expect(res.json()).toEqual({ error: 'pve-unreachable' });
    });
  });

  describe('update (PUT /:id)', () => {
    it('403s in token mode, 401s unauthenticated, and 403s without Sys.Modify', async () => {
      await setupTokenMode();
      let res = await call('PUT', '/nightly', { payload: { enabled: false } });
      expect(res.statusCode).toBe(403);
      expect(res.json()).toEqual({ error: 'writes-disabled-in-token-mode' });
      await app.close();
      await fakePve.close();

      const cookie = await setupSession();
      res = await call('PUT', '/nightly', { payload: { enabled: false } });
      expect(res.statusCode).toBe(401);
      res = await call('PUT', '/nightly', { cookie, payload: { enabled: false } });
      expect(res.statusCode).toBe(403);
      expect(res.json()).toEqual({ error: 'forbidden', missing: 'Sys.Modify' });
      expect(fakePve.backupJobCalls).toHaveLength(0);
    });

    it('rejects a malformed id, an empty body and an unknown key (400)', async () => {
      const cookie = await setupAdmin();
      let res = await call('PUT', '/bad%20id', { cookie, payload: { enabled: false } });
      expect(res.statusCode).toBe(400);
      res = await call('PUT', '/nightly', { cookie, payload: {} });
      expect(res.statusCode).toBe(400);
      res = await call('PUT', '/nightly', { cookie, payload: { enabled: false, vmid: '100' } });
      expect(res.statusCode).toBe(400);
      res = await call('PUT', '/nightly', { cookie, payload: { schedule: 'mon; reboot' } });
      expect(res.statusCode).toBe(400);
      expect(fakePve.backupJobCalls).toHaveLength(0);
    });

    it('404s for a job that does not exist', async () => {
      const cookie = await setupAdmin();
      const res = await call('PUT', '/nope', { cookie, payload: { enabled: false } });
      expect(res.statusCode).toBe(404);
      expect(res.json()).toMatchObject({ error: 'not-found' });
      expect(fakePve.backupJobCalls).toHaveLength(0);
    });

    it('sends only the toggled key for an enable/disable', async () => {
      const cookie = await setupAdmin();
      const res = await call('PUT', '/nightly', { cookie, payload: { enabled: false } });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ ok: true, id: 'nightly' });
      expect(fakePve.backupJobCalls).toStrictEqual([{ method: 'PUT', id: 'nightly', body: { enabled: '0' } }]);
    });

    it('switching to a pool selection deletes all, exclude and vmid', async () => {
      const cookie = await setupAdmin();
      const res = await call('PUT', '/nightly', { cookie, payload: { selection: { kind: 'pool', pool: 'prod' } } });
      expect(res.statusCode).toBe(200);
      expect(fakePve.backupJobCalls[0]?.body).toStrictEqual({ pool: 'prod', delete: 'all,exclude,vmid' });
    });

    it('switching to a guest list deletes all, exclude and pool', async () => {
      const cookie = await setupAdmin();
      const res = await call('PUT', '/weekly', {
        cookie,
        payload: { selection: { kind: 'vmids', vmids: [100, 102] } },
      });
      expect(res.statusCode).toBe(200);
      expect(fakePve.backupJobCalls[0]?.body).toStrictEqual({ vmid: '100,102', delete: 'all,exclude,pool' });
    });

    it('switching to all-guests deletes pool and vmid (and exclude when none is given)', async () => {
      const cookie = await setupAdmin();
      let res = await call('PUT', '/weekly', { cookie, payload: { selection: { kind: 'all' } } });
      expect(res.statusCode).toBe(200);
      expect(fakePve.backupJobCalls[0]?.body).toStrictEqual({ all: '1', delete: 'exclude,pool,vmid' });

      res = await call('PUT', '/weekly', { cookie, payload: { selection: { kind: 'all', exclude: [100, 101] } } });
      expect(res.statusCode).toBe(200);
      expect(fakePve.backupJobCalls[1]?.body).toStrictEqual({ all: '1', exclude: '100,101', delete: 'pool,vmid' });
    });

    it('turns an explicit null into PVE delete entries (comment, node, mailto, prune, numbers)', async () => {
      const cookie = await setupAdmin();
      const res = await call('PUT', '/weekly', {
        cookie,
        payload: {
          comment: null,
          node: null,
          mailto: null,
          mailnotification: null,
          notificationMode: null,
          pruneBackups: null,
          repeatMissed: null,
          bwlimit: null,
          zstd: null,
          ionice: null,
          lockwait: null,
          stopwait: null,
          protected: null,
        },
      });
      expect(res.statusCode).toBe(200);
      expect(fakePve.backupJobCalls[0]?.body).toStrictEqual({
        delete:
          'node,mailto,mailnotification,notification-mode,prune-backups,comment,repeat-missed,bwlimit,zstd,ionice,lockwait,stopwait,protected',
      });
    });

    it('clears pool via a selection switch while editing other fields together', async () => {
      const cookie = await setupAdmin();
      const res = await call('PUT', '/weekly', {
        cookie,
        payload: {
          schedule: 'sat 22:30',
          selection: { kind: 'all', exclude: [100] },
          comment: null,
          mailto: ['ops@example.com'],
          pruneBackups: { keepLast: 3, keepDaily: 7 },
        },
      });
      expect(res.statusCode).toBe(200);
      expect(fakePve.backupJobCalls[0]?.body).toStrictEqual({
        schedule: 'sat 22:30',
        all: '1',
        exclude: '100',
        mailto: 'ops@example.com',
        'prune-backups': 'keep-last=3,keep-daily=7',
        delete: 'pool,vmid,comment',
      });
    });

    it('treats an emptied mailto list and an emptied prune policy as a clear', async () => {
      const cookie = await setupAdmin();
      const res = await call('PUT', '/weekly', { cookie, payload: { mailto: [], pruneBackups: {} } });
      expect(res.statusCode).toBe(200);
      expect(fakePve.backupJobCalls[0]?.body).toStrictEqual({ delete: 'mailto,prune-backups' });
    });

    it('relays a PVE 4xx and maps a 5xx to 502', async () => {
      const cookie = await setupAdmin();
      fakePve.setBackupJobError({ status: 403, message: 'Permission check failed (/, Sys.Modify)' });
      let res = await call('PUT', '/nightly', { cookie, payload: { enabled: false } });
      expect(res.statusCode).toBe(403);
      expect(res.json()).toEqual({ error: 'pve-rejected', message: 'Permission check failed (/, Sys.Modify)' });

      fakePve.setBackupJobError({ status: 500, message: 'boom' });
      res = await call('PUT', '/nightly', { cookie, payload: { enabled: false } });
      expect(res.statusCode).toBe(502);
      expect(res.json()).toEqual({ error: 'pve-unreachable' });
    });
  });

  describe('delete (DELETE /:id)', () => {
    it('403s in token mode, 401s unauthenticated, 403s without Sys.Modify', async () => {
      await setupTokenMode();
      let res = await call('DELETE', '/nightly');
      expect(res.statusCode).toBe(403);
      expect(res.json()).toEqual({ error: 'writes-disabled-in-token-mode' });
      await app.close();
      await fakePve.close();

      const cookie = await setupSession();
      res = await call('DELETE', '/nightly');
      expect(res.statusCode).toBe(401);
      res = await call('DELETE', '/nightly', { cookie });
      expect(res.statusCode).toBe(403);
      expect(res.json()).toEqual({ error: 'forbidden', missing: 'Sys.Modify' });
      expect(fakePve.backupJobCalls).toHaveLength(0);
    });

    it('rejects a malformed id (400) and 404s a job the list does not contain', async () => {
      const cookie = await setupAdmin();
      let res = await call('DELETE', '/bad%20id', { cookie });
      expect(res.statusCode).toBe(400);
      res = await call('DELETE', '/nope', { cookie });
      expect(res.statusCode).toBe(404);
      expect(res.json()).toMatchObject({ error: 'not-found' });
      expect(fakePve.backupJobCalls).toHaveLength(0);
    });

    it('deletes the job through DELETE /cluster/backup/{id}', async () => {
      const cookie = await setupAdmin();
      const res = await call('DELETE', '/nightly', { cookie });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ ok: true });
      expect(fakePve.backupJobCalls).toStrictEqual([{ method: 'DELETE', id: 'nightly', body: {} }]);
    });

    it('relays a PVE 4xx and maps a 5xx to 502', async () => {
      const cookie = await setupAdmin();
      fakePve.setBackupJobError({ status: 400, message: 'job is busy' });
      let res = await call('DELETE', '/nightly', { cookie });
      expect(res.statusCode).toBe(400);
      expect(res.json()).toEqual({ error: 'pve-rejected', message: 'job is busy' });
      fakePve.setBackupJobError({ status: 500, message: 'boom' });
      res = await call('DELETE', '/nightly', { cookie });
      expect(res.statusCode).toBe(502);
      expect(res.json()).toEqual({ error: 'pve-unreachable' });
    });
  });

  describe('run now (POST /:id/run)', () => {
    /** Two nodes, guests 100/101 on pve1 and 102 on pve2 (pool `prod`: 100 and 102), node pve3 offline. */
    function clusterResources(): unknown[] {
      return [
        { id: 'node/pve1', type: 'node', node: 'pve1', status: 'online' },
        { id: 'node/pve2', type: 'node', node: 'pve2', status: 'online' },
        { id: 'node/pve3', type: 'node', node: 'pve3', status: 'offline' },
        { id: 'qemu/100', type: 'qemu', vmid: 100, node: 'pve1', status: 'running', pool: 'prod' },
        { id: 'lxc/101', type: 'lxc', vmid: 101, node: 'pve1', status: 'running' },
        { id: 'qemu/102', type: 'qemu', vmid: 102, node: 'pve2', status: 'stopped', pool: 'prod' },
        { id: 'qemu/103', type: 'qemu', vmid: 103, node: 'pve3', status: 'unknown' },
      ];
    }

    async function setupRunnable(): Promise<string> {
      const cookie = await setupSession();
      fakePve.setClusterResources(clusterResources());
      fakePve.setStoragePermissions('backup-nfs', { 'Datastore.AllocateSpace': true });
      for (const vmid of [100, 101, 102, 103]) fakePve.setVmPermissions(vmid, { 'VM.Backup': true });
      fakePve.setBackupJobs([
        {
          id: 'nightly',
          schedule: '02:00',
          storage: 'backup-nfs',
          mode: 'snapshot',
          compress: 'zstd',
          all: 1,
          exclude: '101',
          mailto: 'ops@example.com',
          mailnotification: 'failure',
          'notification-mode': 'auto',
          'prune-backups': { 'keep-last': 3, 'keep-daily': 7 },
          bwlimit: 1000,
          zstd: 2,
          ionice: 6,
          comment: 'must not be forwarded',
          enabled: 1,
        },
        { id: 'prod', schedule: 'sun 01:00', storage: 'backup-nfs', pool: 'prod', node: 'pve2' },
        { id: 'pick', schedule: 'sun 02:00', storage: 'backup-nfs', vmid: '100,102' },
        { id: 'empty', schedule: 'sun 03:00', storage: 'backup-nfs' },
        { id: 'nostore', schedule: 'sun 04:00', vmid: '100' },
      ]);
      return cookie;
    }

    it('403s in token mode before any PVE call and 401s unauthenticated', async () => {
      await setupTokenMode();
      const before = fakePve.requestCount;
      let res = await call('POST', '/nightly/run');
      expect(res.statusCode).toBe(403);
      expect(res.json()).toEqual({ error: 'writes-disabled-in-token-mode' });
      expect(fakePve.requestCount).toBe(before);
      await app.close();
      await fakePve.close();

      await setupSession();
      res = await call('POST', '/nightly/run');
      expect(res.statusCode).toBe(401);
      expect(fakePve.vzdumpCalls).toHaveLength(0);
    });

    it('rejects a malformed id (400), an unknown body key (400) and a missing job (404)', async () => {
      const cookie = await setupRunnable();
      let res = await call('POST', '/bad%20id/run', { cookie });
      expect(res.statusCode).toBe(400);
      res = await call('POST', '/nightly/run', { cookie, payload: { storage: 'other' } });
      expect(res.statusCode).toBe(400);
      res = await call('POST', '/nope/run', { cookie });
      expect(res.statusCode).toBe(404);
      expect(fakePve.vzdumpCalls).toHaveLength(0);
    });

    it('runs a cluster-wide all-guests job once per node that holds a selected guest', async () => {
      const cookie = await setupRunnable();
      const res = await call('POST', '/nightly/run', { cookie });
      expect(res.statusCode).toBe(202);
      expect(res.json()).toEqual({
        upids: [
          'UPID:fakepve:00000001:00000000:00000000:vzdump:0:root@pam:',
          'UPID:fakepve:00000001:00000000:00000000:vzdump:0:root@pam:',
        ],
      });
      // pve1 (guest 100; 101 is excluded but the job's own exclude is forwarded), pve2 (102); pve3 is offline.
      expect(fakePve.vzdumpCalls).toHaveLength(2);
      const expected = {
        storage: 'backup-nfs',
        mode: 'snapshot',
        compress: 'zstd',
        all: '1',
        exclude: '101',
        mailto: 'ops@example.com',
        mailnotification: 'failure',
        'notification-mode': 'auto',
        'prune-backups': 'keep-last=3,keep-daily=7',
        bwlimit: '1000',
        zstd: '2',
        ionice: '6',
      };
      expect(fakePve.vzdumpCalls[0]?.body).toStrictEqual(expected);
      expect(fakePve.vzdumpCalls[1]?.body).toStrictEqual(expected);
    });

    it('runs a node-restricted pool job on its node only, with the pool', async () => {
      const cookie = await setupRunnable();
      const res = await call('POST', '/prod/run', { cookie });
      expect(res.statusCode).toBe(202);
      expect(res.json().upids).toHaveLength(1);
      expect(fakePve.vzdumpCalls).toHaveLength(1);
      expect(fakePve.vzdumpCalls[0]?.body).toStrictEqual({
        storage: 'backup-nfs',
        pool: 'prod',
      });
    });

    it('runs a guest-list job with the comma-joined vmid on each node that holds one', async () => {
      const cookie = await setupRunnable();
      const res = await call('POST', '/pick/run', { cookie });
      expect(res.statusCode).toBe(202);
      expect(fakePve.vzdumpCalls.map((c) => c.body)).toStrictEqual([
        { storage: 'backup-nfs', vmid: '100,102' },
        { storage: 'backup-nfs', vmid: '100,102' },
      ]);
    });

    it('403s VM.Backup when any selected guest lacks it, and starts nothing', async () => {
      const cookie = await setupRunnable();
      fakePve.setVmPermissions(102, { 'VM.Backup': false });
      const res = await call('POST', '/nightly/run', { cookie });
      expect(res.statusCode).toBe(403);
      expect(res.json()).toEqual({ error: 'forbidden', missing: 'VM.Backup' });
      expect(fakePve.vzdumpCalls).toHaveLength(0);
    });

    it('403s Datastore.AllocateSpace when the storage grants nothing, and starts nothing', async () => {
      const cookie = await setupRunnable();
      fakePve.setStoragePermissions('backup-nfs', {});
      const res = await call('POST', '/nightly/run', { cookie });
      expect(res.statusCode).toBe(403);
      expect(res.json()).toEqual({ error: 'forbidden', missing: 'Datastore.AllocateSpace' });
      expect(fakePve.vzdumpCalls).toHaveLength(0);
    });

    it('does not need Sys.Modify on /', async () => {
      const cookie = await setupRunnable();
      fakePve.setRootPermissions({});
      const res = await call('POST', '/pick/run', { cookie });
      expect(res.statusCode).toBe(202);
    });

    it('400s a job that selects no guests, has no selection, or has no storage', async () => {
      const cookie = await setupRunnable();
      let res = await call('POST', '/empty/run', { cookie });
      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({ error: 'job-has-no-selection' });
      res = await call('POST', '/nostore/run', { cookie });
      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({ error: 'job-has-no-storage' });
      fakePve.setClusterResources(clusterResources().filter((r) => (r as { type: string }).type === 'node'));
      res = await call('POST', '/pick/run', { cookie });
      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({ error: 'no-guests' });
      expect(fakePve.vzdumpCalls).toHaveLength(0);
    });

    it('relays a PVE 4xx from vzdump and maps a 5xx to 502', async () => {
      const cookie = await setupRunnable();
      fakePve.setVzdumpError(400, 'storage is not available');
      let res = await call('POST', '/pick/run', { cookie });
      expect(res.statusCode).toBe(400);
      expect(res.json()).toEqual({ error: 'pve-rejected', message: 'storage is not available' });

      fakePve.setVzdumpError(500, 'boom');
      res = await call('POST', '/pick/run', { cookie });
      expect(res.statusCode).toBe(502);
      expect(res.json()).toEqual({ error: 'pve-unreachable' });
    });
  });
});
