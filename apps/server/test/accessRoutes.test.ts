import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FastifyBaseLogger, FastifyInstance, InjectOptions } from 'fastify';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { startFakePve, type FakePve } from './helpers/fakePve.js';

const PASSWORD = 'Sup3r-S3cret-Pa55word!';
const CURRENT_PASSWORD = 'Curr3nt-Pa55word-Zed';

describe('datacenter access routes (T68)', () => {
  let fakePve: FakePve;
  let app: FastifyInstance;

  afterEach(async () => {
    vi.restoreAllMocks();
    await app?.close();
    await fakePve?.close();
  });

  /** Signs in as `root@pam` (default) or `chris@pve`. */
  async function setupSession(as: 'root@pam' | 'chris@pve' = 'root@pam'): Promise<string> {
    fakePve = await startFakePve({ users: { 'root@pam': 'goodpass', 'chris@pve': 'chrispass' } });
    app = await buildApp({ config: loadConfig({ NODE_ENV: 'test', PVE_URL: fakePve.url }) });
    const [username, realm] = as.split('@') as [string, string];
    const login = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { username, password: as === 'root@pam' ? 'goodpass' : 'chrispass', realm },
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
    options: { cookie?: string; payload?: unknown } = {},
  ) {
    const injectOptions: InjectOptions = { method, url: `/api/actions/datacenter/access${path}` };
    if (options.cookie !== undefined) injectOptions.headers = { cookie: options.cookie };
    if (options.payload !== undefined) injectOptions.payload = options.payload as NonNullable<InjectOptions['payload']>;
    return app.inject(injectOptions);
  }

  /** Same capture mechanism as `cloudInitRoutes.test.ts`: every logger level method (root + each
   * per-request child) is spied on and the recorded arguments run through pino's serializers. */
  function captureLogCalls(): unknown[][] {
    const calls: unknown[][] = [];
    const levels = ['trace', 'debug', 'info', 'warn', 'error', 'fatal'] as const;
    const serialize = (logger: FastifyBaseLogger, args: unknown[]): unknown[] => {
      const serializers = (logger as unknown as Record<symbol, Record<string, (v: unknown) => unknown> | undefined>)[
        Symbol.for('pino.serializers')
      ];
      const [first, ...rest] = args;
      if (typeof first !== 'object' || first === null || serializers === undefined) return args;
      const written: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(first)) {
        const serializer = serializers[key];
        written[key] = serializer ? serializer(value) : value;
      }
      return [written, ...rest];
    };
    const instrument = (logger: FastifyBaseLogger) => {
      for (const level of levels) {
        const original = logger[level].bind(logger) as (...args: unknown[]) => void;
        vi.spyOn(logger, level).mockImplementation(((...args: unknown[]) => {
          calls.push(serialize(logger, args));
          original(...args);
        }) as never);
      }
    };
    instrument(app.log);
    const originalChild = app.log.child.bind(app.log) as (...args: unknown[]) => FastifyBaseLogger;
    vi.spyOn(app.log, 'child').mockImplementation(((...args: unknown[]) => {
      const child = originalChild(...args);
      instrument(child);
      return child;
    }) as never);
    return calls;
  }

  describe('token mode', () => {
    it('every write 403s without any PVE call', async () => {
      await setupTokenMode();
      const attempts: Array<[Parameters<typeof call>[0], string, unknown]> = [
        ['POST', '/users', { userid: 'a@pve' }],
        ['PUT', '/users/a@pve', { comment: 'x' }],
        ['DELETE', '/users/a@pve', undefined],
        ['PUT', '/password', { userid: 'a@pve', password: PASSWORD }],
        ['POST', '/groups', { groupid: 'ops' }],
        ['PUT', '/groups/ops', { comment: 'x' }],
        ['DELETE', '/groups/ops', undefined],
        ['POST', '/acl', { path: '/', roles: ['PVEAuditor'], users: ['a@pve'] }],
        ['POST', '/users/a@pve/tokens', { tokenid: 'ci' }],
        ['PUT', '/users/a@pve/tokens/ci', { comment: 'x' }],
        ['DELETE', '/users/a@pve/tokens/ci', undefined],
      ];
      for (const [method, path, payload] of attempts) {
        const res = await call(method, path, payload === undefined ? {} : { payload });
        expect(res.statusCode, `${method} ${path}`).toBe(403);
        expect(res.json()).toEqual({ error: 'writes-disabled-in-token-mode' });
      }
      expect(fakePve.accessCalls).toHaveLength(0);
      expect(fakePve.accessPermissionPaths).toHaveLength(0);
    });
  });

  describe('authentication', () => {
    it('401s without a session on every kind of route', async () => {
      fakePve = await startFakePve();
      app = await buildApp({ config: loadConfig({ NODE_ENV: 'test', PVE_URL: fakePve.url }) });
      expect((await call('POST', '/users', { payload: { userid: 'a@pve' } })).statusCode).toBe(401);
      expect((await call('DELETE', '/users/a@pve')).statusCode).toBe(401);
      expect((await call('PUT', '/password', { payload: { userid: 'a@pve', password: PASSWORD } })).statusCode).toBe(401);
      expect((await call('POST', '/groups', { payload: { groupid: 'ops' } })).statusCode).toBe(401);
      expect((await call('POST', '/acl', { payload: { path: '/', roles: ['x'], users: ['a@pve'] } })).statusCode).toBe(401);
      expect((await call('POST', '/users/a@pve/tokens', { payload: { tokenid: 'ci' } })).statusCode).toBe(401);
      expect(fakePve.accessCalls).toHaveLength(0);
    });
  });

  describe('users', () => {
    it('POST creates a pve user with the exact PVE body, checking Realm.AllocateUser on the realm path', async () => {
      const cookie = await setupSession();
      fakePve.setPathPermissions('/access/realm/pve', { 'Realm.AllocateUser': true });
      const res = await call('POST', '/users', {
        cookie,
        payload: {
          userid: 'chris@pve',
          password: PASSWORD,
          enable: true,
          expire: 1893456000,
          firstname: 'Chris',
          lastname: 'Shirley',
          email: 'chris@example.com',
          groups: ['admins', 'ops'],
          comment: 'Lab admin',
        },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toStrictEqual({ ok: true, userid: 'chris@pve' });
      expect(res.body).not.toContain(PASSWORD);
      expect(fakePve.accessPermissionPaths).toStrictEqual(['/access/realm/pve']);
      expect(fakePve.accessCalls).toStrictEqual([
        {
          method: 'POST',
          path: '/api2/json/access/users',
          body: {
            userid: 'chris@pve',
            password: PASSWORD,
            enable: '1',
            expire: '1893456000',
            firstname: 'Chris',
            lastname: 'Shirley',
            email: 'chris@example.com',
            groups: 'admins,ops',
            comment: 'Lab admin',
          },
        },
      ]);
    });

    it('POST of a minimal pam user sends only the userid and checks the pam realm path', async () => {
      const cookie = await setupSession();
      fakePve.setPathPermissions('/access/realm/pam', { 'Realm.AllocateUser': true });
      const res = await call('POST', '/users', { cookie, payload: { userid: 'ops@pam', enable: false } });
      expect(res.statusCode).toBe(200);
      expect(fakePve.accessPermissionPaths).toStrictEqual(['/access/realm/pam']);
      expect(fakePve.accessCalls[0]!.body).toStrictEqual({ userid: 'ops@pam', enable: '0' });
    });

    it('POST rejects a bad userid, a short password, unknown keys and a non-pve password before any PVE call', async () => {
      const cookie = await setupSession();
      for (const payload of [
        { userid: 'nobody' },
        { userid: 'a@b@c' },
        { userid: 'bad name@pve' },
        { userid: 'a@pve', password: 'short' },
        { userid: 'a@pve', password: 'x'.repeat(65) },
        { userid: 'a@pve', email: 'not-an-email' },
        { userid: 'a@pve', email: 'Name <a@b.co>' },
        { userid: 'a@pve', keys: 'x' },
        { userid: 'a@pve', comment: 'line\nbreak' },
        { userid: 'a@pve', groups: ['bad group'] },
        { userid: 'a@pve', expire: -1 },
      ]) {
        const res = await call('POST', '/users', { cookie, payload });
        expect(res.statusCode, JSON.stringify(payload)).toBe(400);
      }
      const pam = await call('POST', '/users', { cookie, payload: { userid: 'a@pam', password: PASSWORD } });
      expect(pam.statusCode).toBe(400);
      expect(pam.json()).toMatchObject({ error: 'password-only-for-pve-realm' });
      expect(pam.body).not.toContain(PASSWORD);
      expect(fakePve.accessCalls).toHaveLength(0);
      expect(fakePve.accessPermissionPaths).toHaveLength(0);
    });

    it('POST takes the realm from the part after the @ (custom realm names included)', async () => {
      const cookie = await setupSession();
      fakePve.setPathPermissions('/access/realm/corp-ldap', { 'Realm.AllocateUser': true });
      const res = await call('POST', '/users', { cookie, payload: { userid: 'a.b-c_d@corp-ldap' } });
      expect(res.statusCode).toBe(200);
      expect(fakePve.accessPermissionPaths).toStrictEqual(['/access/realm/corp-ldap']);
      expect(fakePve.accessCalls[0]!.body).toStrictEqual({ userid: 'a.b-c_d@corp-ldap' });
    });

    it('POST rejects a non-integer, negative or absurd expire', async () => {
      const cookie = await setupSession();
      for (const expire of [1.5, -5, 5_000_000_000, '2030-01-01']) {
        const res = await call('POST', '/users', { cookie, payload: { userid: 'a@pam', expire } });
        expect(res.statusCode, String(expire)).toBe(400);
      }
      expect(fakePve.accessCalls).toHaveLength(0);
    });

    it('POST 403s with the missing privilege when the caller lacks Realm.AllocateUser', async () => {
      const cookie = await setupSession();
      const res = await call('POST', '/users', { cookie, payload: { userid: 'a@pve' } });
      expect(res.statusCode).toBe(403);
      expect(res.json()).toStrictEqual({ error: 'forbidden', missing: 'Realm.AllocateUser' });
      expect(fakePve.accessCalls).toHaveLength(0);
    });

    it('PUT sends the changed fields; an explicit null clears the field (empty value, expire 0)', async () => {
      const cookie = await setupSession();
      fakePve.setPathPermissions('/access', { 'User.Modify': true });
      const res = await call('PUT', '/users/chris@pve', {
        cookie,
        payload: { enable: false, expire: null, firstname: null, lastname: 'S', email: null, groups: ['ops'], comment: null },
      });
      expect(res.statusCode).toBe(200);
      expect(fakePve.accessPermissionPaths).toStrictEqual(['/access']);
      expect(fakePve.accessCalls).toStrictEqual([
        {
          method: 'PUT',
          path: '/api2/json/access/users/chris%40pve',
          body: { enable: '0', expire: '0', firstname: '', lastname: 'S', email: '', groups: 'ops', comment: '' },
        },
      ]);
    });

    it('PUT with groups null (or empty) clears the groups', async () => {
      const cookie = await setupSession();
      fakePve.setPathPermissions('/access', { 'User.Modify': true });
      await call('PUT', '/users/chris@pve', { cookie, payload: { groups: null } });
      await call('PUT', '/users/chris@pve', { cookie, payload: { groups: [] } });
      expect(fakePve.accessCalls.map((c) => c.body)).toStrictEqual([{ groups: '' }, { groups: '' }]);
    });

    it('PUT rejects an empty change set, a userid or password in the body and a bad path userid', async () => {
      const cookie = await setupSession();
      fakePve.setPathPermissions('/access', { 'User.Modify': true });
      expect((await call('PUT', '/users/chris@pve', { cookie, payload: {} })).json()).toMatchObject({ error: 'no-changes' });
      expect((await call('PUT', '/users/chris@pve', { cookie, payload: { userid: 'x@pve', comment: 'a' } })).statusCode).toBe(400);
      expect((await call('PUT', '/users/chris@pve', { cookie, payload: { password: PASSWORD } })).statusCode).toBe(400);
      expect((await call('PUT', '/users/nobody', { cookie, payload: { comment: 'a' } })).statusCode).toBe(400);
      expect(fakePve.accessCalls).toHaveLength(0);
    });

    it('PUT 403s without User.Modify on /access', async () => {
      const cookie = await setupSession();
      const res = await call('PUT', '/users/chris@pve', { cookie, payload: { comment: 'a' } });
      expect(res.statusCode).toBe(403);
      expect(res.json()).toStrictEqual({ error: 'forbidden', missing: 'User.Modify' });
      expect(fakePve.accessCalls).toHaveLength(0);
    });

    it('DELETE removes the user at the exact PVE path', async () => {
      const cookie = await setupSession();
      fakePve.setPathPermissions('/access', { 'User.Modify': true });
      const res = await call('DELETE', '/users/old.user@pve', { cookie });
      expect(res.statusCode).toBe(200);
      expect(fakePve.accessCalls).toStrictEqual([
        { method: 'DELETE', path: '/api2/json/access/users/old.user%40pve', body: {} },
      ]);
    });

    it('DELETE refuses root@pam with 400, before any permission check or PVE call', async () => {
      const cookie = await setupSession('chris@pve');
      fakePve.setPathPermissions('/access', { 'User.Modify': true });
      const res = await call('DELETE', '/users/root@pam', { cookie });
      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({ error: 'cannot-delete-root' });
      expect(fakePve.accessCalls).toHaveLength(0);
      expect(fakePve.accessPermissionPaths).toHaveLength(0);
    });

    it("DELETE refuses the caller's own account with 400 cannot-delete-self", async () => {
      const cookie = await setupSession('chris@pve');
      fakePve.setPathPermissions('/access', { 'User.Modify': true });
      const res = await call('DELETE', '/users/chris@pve', { cookie });
      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({ error: 'cannot-delete-self' });
      expect(fakePve.accessCalls).toHaveLength(0);
    });

    it('DELETE rejects a userid without a realm before any PVE call', async () => {
      const cookie = await setupSession();
      fakePve.setPathPermissions('/access', { 'User.Modify': true });
      const res = await call('DELETE', '/users/nobody', { cookie });
      expect(res.statusCode).toBe(400);
      expect(fakePve.accessCalls).toHaveLength(0);
      expect(fakePve.accessPermissionPaths).toHaveLength(0);
    });

    it('DELETE 403s without User.Modify', async () => {
      const cookie = await setupSession();
      const res = await call('DELETE', '/users/other@pve', { cookie });
      expect(res.statusCode).toBe(403);
      expect(res.json()).toStrictEqual({ error: 'forbidden', missing: 'User.Modify' });
    });
  });

  describe('password', () => {
    it("changes the caller's own password without any permission lookup", async () => {
      const cookie = await setupSession('chris@pve');
      const res = await call('PUT', '/password', {
        cookie,
        payload: { userid: 'chris@pve', password: PASSWORD, confirmationPassword: CURRENT_PASSWORD },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toStrictEqual({ ok: true });
      expect(res.body).not.toContain(PASSWORD);
      expect(res.body).not.toContain(CURRENT_PASSWORD);
      expect(fakePve.accessPermissionPaths).toHaveLength(0);
      expect(fakePve.accessCalls).toStrictEqual([
        {
          method: 'PUT',
          path: '/api2/json/access/password',
          body: { userid: 'chris@pve', password: PASSWORD, 'confirmation-password': CURRENT_PASSWORD },
        },
      ]);
    });

    it("another user's password needs User.Modify on /access", async () => {
      const cookie = await setupSession();
      const denied = await call('PUT', '/password', { cookie, payload: { userid: 'other@pve', password: PASSWORD } });
      expect(denied.statusCode).toBe(403);
      expect(denied.json()).toStrictEqual({ error: 'forbidden', missing: 'User.Modify' });
      expect(denied.body).not.toContain(PASSWORD);
      expect(fakePve.accessCalls).toHaveLength(0);

      fakePve.setPathPermissions('/access', { 'User.Modify': true });
      const ok = await call('PUT', '/password', { cookie, payload: { userid: 'other@pve', password: PASSWORD } });
      expect(ok.statusCode).toBe(200);
      expect(fakePve.accessCalls[0]!.body).toStrictEqual({ userid: 'other@pve', password: PASSWORD });
    });

    it('rejects short or long passwords and extra keys', async () => {
      const cookie = await setupSession('chris@pve');
      for (const payload of [
        { userid: 'chris@pve', password: 'short' },
        { userid: 'chris@pve', password: 'x'.repeat(65) },
        { userid: 'chris@pve' },
        { userid: 'chris@pve', password: PASSWORD, extra: 1 },
      ]) {
        expect((await call('PUT', '/password', { cookie, payload })).statusCode).toBe(400);
      }
      expect(fakePve.accessCalls).toHaveLength(0);
    });
  });

  describe('the password never reaches the logger', () => {
    it('control: the capture does see a leak when a log call is handed the password', async () => {
      await setupSession();
      const calls = captureLogCalls();
      app.log.info({ body: { password: PASSWORD } }, 'deliberate leak');
      expect(calls.some((args) => JSON.stringify(args).includes(PASSWORD))).toBe(true);
    });

    it('success paths (create user, change password) log the userid only', async () => {
      const cookie = await setupSession();
      fakePve.setPathPermissions('/access/realm/pve', { 'Realm.AllocateUser': true });
      const calls = captureLogCalls();
      const created = await call('POST', '/users', { cookie, payload: { userid: 'new@pve', password: PASSWORD } });
      expect(created.statusCode).toBe(200);
      const changed = await call('PUT', '/password', {
        cookie,
        payload: { userid: 'root@pam', password: PASSWORD, confirmationPassword: CURRENT_PASSWORD },
      });
      expect(changed.statusCode).toBe(200);
      expect(fakePve.accessCalls[0]!.body.password).toBe(PASSWORD);
      expect(calls.find((args) => args[1] === 'Access user created')).toBeDefined();
      expect(calls.find((args) => args[1] === 'Access password changed')).toBeDefined();
      for (const args of calls) {
        const serialized = JSON.stringify(args);
        expect(serialized).not.toContain(PASSWORD);
        expect(serialized).not.toContain(CURRENT_PASSWORD);
      }
    });

    it('PVE 4xx / 5xx, 400 and 403 paths never log or return it either', async () => {
      const cookie = await setupSession();
      fakePve.setPathPermissions('/access/realm/pve', { 'Realm.AllocateUser': true });
      const calls = captureLogCalls();
      const payload = { userid: 'new@pve', password: PASSWORD };

      fakePve.setAccessError({ status: 500, message: 'boom' });
      const down = await call('POST', '/users', { cookie, payload });
      expect(down.statusCode).toBe(502);
      expect(down.body).not.toContain(PASSWORD);

      fakePve.setAccessError({ status: 400, message: 'Parameter verification failed.' });
      const rejected = await call('POST', '/users', { cookie, payload });
      expect(rejected.statusCode).toBe(400);
      expect(rejected.body).not.toContain(PASSWORD);
      const pwRejected = await call('PUT', '/password', { cookie, payload: { userid: 'root@pam', password: PASSWORD } });
      expect(pwRejected.statusCode).toBe(400);
      expect(pwRejected.body).not.toContain(PASSWORD);
      fakePve.setAccessError(undefined);

      const invalid = await call('POST', '/users', { cookie, payload: { ...payload, userid: 'bad user@pve' } });
      expect(invalid.statusCode).toBe(400);
      expect(invalid.body).not.toContain(PASSWORD);
      const forbidden = await call('PUT', '/password', { cookie, payload: { userid: 'other@pve', password: PASSWORD } });
      expect(forbidden.statusCode).toBe(403);
      expect(forbidden.body).not.toContain(PASSWORD);

      expect(calls.length).toBeGreaterThan(0);
      for (const args of calls) {
        expect(JSON.stringify(args)).not.toContain(PASSWORD);
      }
    });
  });

  describe('groups', () => {
    it('POST / PUT / DELETE hit the exact PVE paths with Group.Allocate on /access/groups', async () => {
      const cookie = await setupSession();
      fakePve.setPathPermissions('/access/groups', { 'Group.Allocate': true });
      expect((await call('POST', '/groups', { cookie, payload: { groupid: 'ops-team', comment: 'Operators' } })).statusCode).toBe(200);
      expect((await call('PUT', '/groups/ops-team', { cookie, payload: { comment: '' } })).statusCode).toBe(200);
      expect((await call('DELETE', '/groups/ops-team', { cookie })).statusCode).toBe(200);
      expect(fakePve.accessCalls).toStrictEqual([
        { method: 'POST', path: '/api2/json/access/groups', body: { groupid: 'ops-team', comment: 'Operators' } },
        { method: 'PUT', path: '/api2/json/access/groups/ops-team', body: { comment: '' } },
        { method: 'DELETE', path: '/api2/json/access/groups/ops-team', body: {} },
      ]);
      expect(new Set(fakePve.accessPermissionPaths)).toStrictEqual(new Set(['/access/groups']));
    });

    it('rejects a bad groupid / unknown keys and 403s without Group.Allocate', async () => {
      const cookie = await setupSession();
      expect((await call('POST', '/groups', { cookie, payload: { groupid: 'bad id' } })).statusCode).toBe(400);
      expect((await call('POST', '/groups', { cookie, payload: { groupid: 'ok', users: 'a' } })).statusCode).toBe(400);
      expect((await call('PUT', '/groups/bad id', { cookie, payload: { comment: 'x' } })).statusCode).toBe(400);
      expect((await call('PUT', '/groups/ok', { cookie, payload: {} })).statusCode).toBe(400);
      expect((await call('DELETE', '/groups/bad id', { cookie })).statusCode).toBe(400);
      const denied = await call('POST', '/groups', { cookie, payload: { groupid: 'ok' } });
      expect(denied.statusCode).toBe(403);
      expect(denied.json()).toStrictEqual({ error: 'forbidden', missing: 'Group.Allocate' });
      expect(fakePve.accessCalls).toHaveLength(0);
    });
  });

  describe('permissions (ACL)', () => {
    it('add: users form, propagate default true, delete 0, privilege checked on the ACL path', async () => {
      const cookie = await setupSession();
      fakePve.setVmPermissions(100, { 'Permissions.Modify': true });
      const res = await call('POST', '/acl', {
        cookie,
        payload: { path: '/vms/100', roles: ['PVEVMAdmin', 'PVEAuditor'], users: ['chris@pve', 'ops@pam'] },
      });
      expect(res.statusCode).toBe(200);
      expect(fakePve.accessCalls).toStrictEqual([
        {
          method: 'PUT',
          path: '/api2/json/access/acl',
          body: { path: '/vms/100', roles: 'PVEVMAdmin,PVEAuditor', propagate: '1', delete: '0', users: 'chris@pve,ops@pam' },
        },
      ]);
    });

    it('remove: delete 1 and propagate false, groups form, on a pool path', async () => {
      const cookie = await setupSession();
      fakePve.setPathPermissions('/pool/lab', { 'Permissions.Modify': true });
      const res = await call('POST', '/acl', {
        cookie,
        payload: { path: '/pool/lab', roles: ['PVEAdmin'], groups: ['admins'], propagate: false, remove: true },
      });
      expect(res.statusCode).toBe(200);
      expect(fakePve.accessPermissionPaths).toStrictEqual(['/pool/lab']);
      expect(fakePve.accessCalls[0]!.body).toStrictEqual({
        path: '/pool/lab',
        roles: 'PVEAdmin',
        propagate: '0',
        delete: '1',
        groups: 'admins',
      });
    });

    it('tokens form uses the full token id; the root path checks Permissions.Modify on /', async () => {
      const cookie = await setupSession();
      fakePve.setRootPermissions({ 'Permissions.Modify': true });
      const res = await call('POST', '/acl', {
        cookie,
        payload: { path: '/', roles: ['PVEAuditor'], tokens: ['chris@pve!monitor'] },
      });
      expect(res.statusCode).toBe(200);
      expect(fakePve.accessCalls[0]!.body).toStrictEqual({
        path: '/',
        roles: 'PVEAuditor',
        propagate: '1',
        delete: '0',
        tokens: 'chris@pve!monitor',
      });
    });

    it('requires exactly one of users / groups / tokens and valid path, roles and ids', async () => {
      const cookie = await setupSession();
      fakePve.setRootPermissions({ 'Permissions.Modify': true });
      const good = { path: '/', roles: ['PVEAuditor'], users: ['a@pve'] };
      for (const payload of [
        { path: '/', roles: ['PVEAuditor'] },
        { ...good, groups: ['g'] },
        { ...good, tokens: ['a@pve!tok'] },
        { ...good, users: [] },
        { ...good, roles: [] },
        { ...good, roles: ['bad role'] },
        { ...good, path: 'vms/100' },
        { ...good, path: '/vms/../access' },
        { ...good, path: '/vms/100?x=1' },
        { ...good, users: ['nobody'] },
        { path: '/', roles: ['PVEAuditor'], tokens: ['a@pve'] },
        { ...good, extra: true },
      ]) {
        const res = await call('POST', '/acl', { cookie, payload });
        expect(res.statusCode, JSON.stringify(payload)).toBe(400);
      }
      expect(fakePve.accessCalls).toHaveLength(0);
      expect(fakePve.accessPermissionPaths).toHaveLength(0);
    });

    it('403s without Permissions.Modify on the path', async () => {
      const cookie = await setupSession();
      fakePve.setPathPermissions('/access/groups', { 'Permissions.Modify': true });
      const res = await call('POST', '/acl', { cookie, payload: { path: '/access', roles: ['PVEAdmin'], users: ['a@pve'] } });
      expect(res.statusCode).toBe(403);
      expect(res.json()).toStrictEqual({ error: 'forbidden', missing: 'Permissions.Modify' });
      expect(fakePve.accessCalls).toHaveLength(0);
    });
  });

  describe('API tokens', () => {
    it('create returns the secret once, with exact PVE path and body, and logs only the token id', async () => {
      const cookie = await setupSession();
      fakePve.setPathPermissions('/access', { 'User.Modify': true });
      const calls = captureLogCalls();

      const res = await call('POST', '/users/chris@pve/tokens', {
        cookie,
        payload: { tokenid: 'monitoring', comment: 'Grafana', expire: 0, privsep: false },
      });
      expect(res.statusCode).toBe(200);
      expect(res.headers['cache-control']).toBe('no-store');
      expect(res.json()).toStrictEqual({ ok: true, fullTokenid: 'chris@pve!monitoring', value: fakePve.accessTokenSecret });
      expect(fakePve.accessCalls).toStrictEqual([
        {
          method: 'POST',
          path: '/api2/json/access/users/chris%40pve/token/monitoring',
          body: { privsep: '0', comment: 'Grafana', expire: '0' },
        },
      ]);
      expect(calls.find((args) => args[1] === 'Access API token created')).toBeDefined();
      for (const args of calls) {
        expect(JSON.stringify(args)).not.toContain(fakePve.accessTokenSecret);
      }
    });

    it('privsep defaults to true', async () => {
      const cookie = await setupSession();
      fakePve.setPathPermissions('/access', { 'User.Modify': true });
      await call('POST', '/users/chris@pve/tokens', { cookie, payload: { tokenid: 'ci' } });
      expect(fakePve.accessCalls[0]!.body).toStrictEqual({ privsep: '1' });
    });

    it('a failed create never returns or logs a secret', async () => {
      const cookie = await setupSession();
      fakePve.setPathPermissions('/access', { 'User.Modify': true });
      const calls = captureLogCalls();
      fakePve.setAccessError({ status: 400, message: 'token already exists' });
      const res = await call('POST', '/users/chris@pve/tokens', { cookie, payload: { tokenid: 'ci' } });
      expect(res.statusCode).toBe(400);
      expect(res.json()).toStrictEqual({ error: 'pve-rejected', message: 'token already exists' });
      expect(res.body).not.toContain(fakePve.accessTokenSecret);
      for (const args of calls) {
        expect(JSON.stringify(args)).not.toContain(fakePve.accessTokenSecret);
      }
    });

    it("the caller's own tokens need no User.Modify; another user's do", async () => {
      const cookie = await setupSession('chris@pve');
      const own = await call('POST', '/users/chris@pve/tokens', { cookie, payload: { tokenid: 'mine' } });
      expect(own.statusCode).toBe(200);
      expect((await call('PUT', '/users/chris@pve/tokens/mine', { cookie, payload: { comment: 'x' } })).statusCode).toBe(200);
      expect((await call('DELETE', '/users/chris@pve/tokens/mine', { cookie })).statusCode).toBe(200);
      expect(fakePve.accessPermissionPaths).toHaveLength(0);

      const other = await call('POST', '/users/other@pve/tokens', { cookie, payload: { tokenid: 'theirs' } });
      expect(other.statusCode).toBe(403);
      expect(other.json()).toStrictEqual({ error: 'forbidden', missing: 'User.Modify' });
      expect(fakePve.accessPermissionPaths).toStrictEqual(['/access']);
      expect(fakePve.accessCalls).toHaveLength(3);
    });

    it('PUT and DELETE hit the exact token paths', async () => {
      const cookie = await setupSession();
      fakePve.setPathPermissions('/access', { 'User.Modify': true });
      const put = await call('PUT', '/users/chris@pve/tokens/ci', {
        cookie,
        payload: { comment: 'CI', expire: 1893456000, privsep: true },
      });
      expect(put.statusCode).toBe(200);
      const del = await call('DELETE', '/users/chris@pve/tokens/ci', { cookie });
      expect(del.statusCode).toBe(200);
      expect(fakePve.accessCalls).toStrictEqual([
        {
          method: 'PUT',
          path: '/api2/json/access/users/chris%40pve/token/ci',
          body: { comment: 'CI', expire: '1893456000', privsep: '1' },
        },
        { method: 'DELETE', path: '/api2/json/access/users/chris%40pve/token/ci', body: {} },
      ]);
    });

    it('rejects a bad tokenid / unknown keys / empty update', async () => {
      const cookie = await setupSession();
      fakePve.setPathPermissions('/access', { 'User.Modify': true });
      expect((await call('POST', '/users/chris@pve/tokens', { cookie, payload: { tokenid: 'x' } })).statusCode).toBe(400);
      expect((await call('POST', '/users/chris@pve/tokens', { cookie, payload: { tokenid: 'bad id' } })).statusCode).toBe(400);
      expect((await call('POST', '/users/chris@pve/tokens', { cookie, payload: { tokenid: 'ok', value: 'x' } })).statusCode).toBe(400);
      expect((await call('POST', '/users/nobody/tokens', { cookie, payload: { tokenid: 'ok' } })).statusCode).toBe(400);
      expect((await call('PUT', '/users/chris@pve/tokens/ci', { cookie, payload: {} })).json()).toMatchObject({ error: 'no-changes' });
      expect((await call('DELETE', '/users/chris@pve/tokens/x', { cookie })).statusCode).toBe(400);
      expect(fakePve.accessCalls).toHaveLength(0);
    });
  });

  describe('PVE failures', () => {
    it('relays a PVE 4xx as pve-rejected with the sanitized message and field errors', async () => {
      const cookie = await setupSession();
      fakePve.setPathPermissions('/access/realm/pve', { 'Realm.AllocateUser': true });
      fakePve.setAccessError({ status: 400, message: 'Parameter verification failed.', errors: { userid: 'user already exists' } });
      const res = await call('POST', '/users', { cookie, payload: { userid: 'dup@pve' } });
      expect(res.statusCode).toBe(400);
      expect(res.json()).toStrictEqual({
        error: 'pve-rejected',
        message: 'Parameter verification failed. userid: user already exists',
      });
    });

    it("relays PVE's own 403 as pve-rejected (finer-grained rights are PVE's rule)", async () => {
      const cookie = await setupSession();
      fakePve.setPathPermissions('/access/groups', { 'Group.Allocate': true });
      fakePve.setAccessError({ status: 403, message: 'Permission check failed (groups)' });
      const res = await call('POST', '/groups', { cookie, payload: { groupid: 'ops' } });
      expect(res.statusCode).toBe(403);
      expect(res.json()).toStrictEqual({ error: 'pve-rejected', message: 'Permission check failed (groups)' });
    });

    it('sanitizes a PVE message: control characters stripped, length capped', async () => {
      const cookie = await setupSession();
      fakePve.setPathPermissions('/access/groups', { 'Group.Allocate': true });
      fakePve.setAccessError({ status: 400, message: `bad\u0007 value ${'x'.repeat(400)}` });
      const res = await call('POST', '/groups', { cookie, payload: { groupid: 'ops' } });
      expect(res.statusCode).toBe(400);
      const message = (res.json() as { message: string }).message;
      expect(message.startsWith('bad value x')).toBe(true);
      expect(message).not.toContain('\u0007');
      expect(message.length).toBeLessThanOrEqual(301);
    });

    it('maps a PVE 5xx to 502 pve-unreachable on every kind of write', async () => {
      const cookie = await setupSession();
      fakePve.setPathPermissions('/access', { 'User.Modify': true });
      fakePve.setPathPermissions('/access/groups', { 'Group.Allocate': true });
      fakePve.setRootPermissions({ 'Permissions.Modify': true });
      fakePve.setAccessError({ status: 500, message: 'internal' });
      for (const [method, path, payload] of [
        ['PUT', '/users/a@pve', { comment: 'x' }],
        ['DELETE', '/users/a@pve', undefined],
        ['POST', '/groups', { groupid: 'ops' }],
        ['POST', '/acl', { path: '/', roles: ['PVEAuditor'], users: ['a@pve'] }],
        ['POST', '/users/a@pve/tokens', { tokenid: 'ci' }],
      ] as const) {
        const res = await call(method, path, payload === undefined ? { cookie } : { cookie, payload });
        expect(res.statusCode, `${method} ${path}`).toBe(502);
        expect(res.json()).toStrictEqual({ error: 'pve-unreachable' });
      }
    });
  });
});
