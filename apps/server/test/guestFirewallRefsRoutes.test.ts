import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance, InjectOptions } from 'fastify';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { startFakePve, type FakePve } from './helpers/fakePve.js';

const FW_PRIV = { 'VM.Config.Network': true };

type Method = 'POST' | 'PUT' | 'DELETE';

interface RouteCase {
  name: string;
  method: Method;
  path: string;
  payload?: unknown;
}

// Every write route, with a minimal valid request, on the qemu guest 100.
const G = '/pve1/qemu/100/firewall';
const ALL_ROUTES: RouteCase[] = [
  { name: 'alias add', method: 'POST', path: `${G}/aliases`, payload: { name: 'office', cidr: '10.0.0.0/24' } },
  { name: 'alias edit', method: 'PUT', path: `${G}/aliases/office`, payload: { cidr: '10.0.0.0/24' } },
  { name: 'alias delete', method: 'DELETE', path: `${G}/aliases/office` },
  { name: 'ipset create', method: 'POST', path: `${G}/ipsets`, payload: { name: 'trusted' } },
  { name: 'ipset delete', method: 'DELETE', path: `${G}/ipsets/trusted` },
  { name: 'ipset entry add', method: 'POST', path: `${G}/ipsets/trusted`, payload: { cidr: '10.0.0.0/24' } },
  { name: 'ipset entry edit', method: 'PUT', path: `${G}/ipsets/trusted/10.0.0.0%2F24`, payload: { nomatch: true } },
  { name: 'ipset entry delete', method: 'DELETE', path: `${G}/ipsets/trusted/10.0.0.0%2F24` },
];

describe('guest firewall alias and IP set routes (T73)', () => {
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
    const cookie = raw.split(';')[0]!;
    fakePve.setVmPermissions(100, FW_PRIV);
    fakePve.setVmPermissions(101, FW_PRIV);
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

  function call(method: Method, path: string, options: { cookie?: string; payload?: unknown } = {}) {
    const injectOptions: InjectOptions = { method, url: `/api/actions/guest${path}` };
    if (options.cookie !== undefined) injectOptions.headers = { cookie: options.cookie };
    if (options.payload !== undefined) injectOptions.payload = options.payload as NonNullable<InjectOptions['payload']>;
    return app.inject(injectOptions);
  }

  const PVE = '/api2/json/nodes/pve1/qemu/100/firewall';
  const PVE_LXC = '/api2/json/nodes/pve1/lxc/101/firewall';

  describe('token mode', () => {
    it('every route 403s before any PVE call', async () => {
      await setupTokenMode();
      for (const route of ALL_ROUTES) {
        const res = await call(route.method, route.path, { payload: route.payload });
        expect(res.statusCode, route.name).toBe(403);
        expect(res.json()).toEqual({ error: 'writes-disabled-in-token-mode' });
      }
      expect(fakePve.guestRefsCalls).toHaveLength(0);
    });
  });

  describe('authentication and privilege', () => {
    it('401s without a session on every route', async () => {
      await setupSession();
      for (const route of ALL_ROUTES) {
        const res = await call(route.method, route.path, { payload: route.payload });
        expect(res.statusCode, route.name).toBe(401);
      }
      expect(fakePve.guestRefsCalls).toHaveLength(0);
    });

    it.each(['alias add', 'alias edit', 'alias delete'])('403s naming VM.Config.Network on %s', async (name) => {
      const cookie = await setupSession();
      fakePve.setVmPermissions(100, { 'VM.Config.Network': false, 'VM.Config.CPU': true });
      const route = ALL_ROUTES.find((r) => r.name === name)!;
      const res = await call(route.method, route.path, { cookie, payload: route.payload });
      expect(res.statusCode).toBe(403);
      expect(res.json()).toEqual({ error: 'forbidden', missing: 'VM.Config.Network' });
      expect(fakePve.guestRefsCalls).toHaveLength(0);
    });

    it.each(['ipset create', 'ipset delete', 'ipset entry add', 'ipset entry edit', 'ipset entry delete'])(
      '403s naming VM.Config.Network on %s',
      async (name) => {
        const cookie = await setupSession();
        fakePve.setVmPermissions(100, { 'VM.Config.Network': false });
        const route = ALL_ROUTES.find((r) => r.name === name)!;
        const res = await call(route.method, route.path, { cookie, payload: route.payload });
        expect(res.statusCode).toBe(403);
        expect(res.json()).toEqual({ error: 'forbidden', missing: 'VM.Config.Network' });
        expect(fakePve.guestRefsCalls).toHaveLength(0);
      },
    );

    it('checks the privilege on the addressed guest only', async () => {
      const cookie = await setupSession();
      fakePve.setVmPermissions(100, { 'VM.Config.Network': false });
      const denied = await call('POST', `${G}/aliases`, { cookie, payload: { name: 'office', cidr: '10.0.0.1' } });
      const allowed = await call('POST', '/pve1/lxc/101/firewall/aliases', {
        cookie,
        payload: { name: 'office', cidr: '10.0.0.1' },
      });
      expect(denied.statusCode).toBe(403);
      expect(allowed.statusCode).toBe(201);
      expect(fakePve.guestRefsCalls).toHaveLength(1);
    });
  });

  describe('aliases: exact PVE calls', () => {
    it('POST /aliases creates an alias (qemu path), forwarding the comment only when sent', async () => {
      const cookie = await setupSession();
      const res = await call('POST', `${G}/aliases`, {
        cookie,
        payload: { name: 'web-net', cidr: '10.1.0.0/24', comment: 'Web tier' },
      });
      expect(res.statusCode).toBe(201);
      expect(res.json()).toEqual({ ok: true });
      await call('POST', `${G}/aliases`, { cookie, payload: { name: 'v6net', cidr: 'fd00::/64' } });
      expect(fakePve.guestRefsCalls).toStrictEqual([
        { method: 'POST', path: `${PVE}/aliases`, body: { name: 'web-net', cidr: '10.1.0.0/24', comment: 'Web tier' } },
        { method: 'POST', path: `${PVE}/aliases`, body: { name: 'v6net', cidr: 'fd00::/64' } },
      ]);
    });

    it('PUT /aliases/:name renames: the path names the existing alias, rename the new one, digest forwarded', async () => {
      const cookie = await setupSession();
      const res = await call('PUT', `${G}/aliases/web-net`, {
        cookie,
        payload: { cidr: '10.1.0.0/23', rename: 'web-tier', digest: 'd5' },
      });
      expect(res.statusCode).toBe(200);
      expect(fakePve.guestRefsCalls).toStrictEqual([
        { method: 'PUT', path: `${PVE}/aliases/web-net`, body: { cidr: '10.1.0.0/23', rename: 'web-tier', digest: 'd5' } },
      ]);
    });

    it('DELETE /aliases/:name forwards the digest from the query or from a JSON body', async () => {
      const cookie = await setupSession();
      await call('DELETE', `${G}/aliases/web-net?digest=d5`, { cookie });
      await call('DELETE', `${G}/aliases/web-net`, { cookie, payload: { digest: 'd6' } });
      await call('DELETE', `${G}/aliases/web-net`, { cookie });
      expect(fakePve.guestRefsCalls).toStrictEqual([
        { method: 'DELETE', path: `${PVE}/aliases/web-net`, body: { digest: 'd5' } },
        { method: 'DELETE', path: `${PVE}/aliases/web-net`, body: { digest: 'd6' } },
        { method: 'DELETE', path: `${PVE}/aliases/web-net`, body: {} },
      ]);
    });

    it('uses the lxc path for a container', async () => {
      const cookie = await setupSession();
      const res = await call('POST', '/pve1/lxc/101/firewall/aliases', {
        cookie,
        payload: { name: 'ct-net', cidr: '172.16.0.0/16' },
      });
      expect(res.statusCode).toBe(201);
      expect(fakePve.guestRefsCalls).toStrictEqual([
        { method: 'POST', path: `${PVE_LXC}/aliases`, body: { name: 'ct-net', cidr: '172.16.0.0/16' } },
      ]);
    });
  });

  describe('IP sets: exact PVE calls', () => {
    it('POST /ipsets creates a set; rename and digest pass through', async () => {
      const cookie = await setupSession();
      await call('POST', `${G}/ipsets`, { cookie, payload: { name: 'allowed', comment: 'Allowed hosts' } });
      await call('POST', `${G}/ipsets`, {
        cookie,
        payload: { name: 'allowed2', rename: 'allowed', comment: 'renamed', digest: 'd5' },
      });
      expect(fakePve.guestRefsCalls).toStrictEqual([
        { method: 'POST', path: `${PVE}/ipset`, body: { name: 'allowed', comment: 'Allowed hosts' } },
        { method: 'POST', path: `${PVE}/ipset`, body: { name: 'allowed2', comment: 'renamed', rename: 'allowed', digest: 'd5' } },
      ]);
    });

    it('DELETE /ipsets/:name forwards force=1 only when asked (query or body)', async () => {
      const cookie = await setupSession();
      await call('DELETE', `${G}/ipsets/allowed`, { cookie });
      await call('DELETE', `${G}/ipsets/allowed?force=1`, { cookie });
      await call('DELETE', `${G}/ipsets/allowed`, { cookie, payload: { force: true } });
      expect(fakePve.guestRefsCalls).toStrictEqual([
        { method: 'DELETE', path: `${PVE}/ipset/allowed`, body: {} },
        { method: 'DELETE', path: `${PVE}/ipset/allowed`, body: { force: '1' } },
        { method: 'DELETE', path: `${PVE}/ipset/allowed`, body: { force: '1' } },
      ]);
    });

    it('POST /ipsets/:name adds an entry; nomatch becomes 1 (and 0 when false)', async () => {
      const cookie = await setupSession();
      await call('POST', `${G}/ipsets/allowed`, {
        cookie,
        payload: { cidr: '10.1.0.0/24', nomatch: true, comment: 'excluded' },
      });
      await call('POST', `${G}/ipsets/allowed`, { cookie, payload: { cidr: '10.1.0.9', nomatch: false } });
      await call('POST', `${G}/ipsets/allowed`, { cookie, payload: { cidr: '10.1.0.10' } });
      expect(fakePve.guestRefsCalls).toStrictEqual([
        { method: 'POST', path: `${PVE}/ipset/allowed`, body: { cidr: '10.1.0.0/24', nomatch: '1', comment: 'excluded' } },
        { method: 'POST', path: `${PVE}/ipset/allowed`, body: { cidr: '10.1.0.9', nomatch: '0' } },
        { method: 'POST', path: `${PVE}/ipset/allowed`, body: { cidr: '10.1.0.10' } },
      ]);
    });

    it('PUT /ipsets/:name/:cidr keeps the CIDR slash URL-encoded on the way to PVE', async () => {
      const cookie = await setupSession();
      const res = await call('PUT', `${G}/ipsets/allowed/10.1.0.0%2F24`, {
        cookie,
        payload: { nomatch: false, comment: 'back in', digest: 'd5' },
      });
      expect(res.statusCode).toBe(200);
      expect(fakePve.guestRefsCalls).toStrictEqual([
        { method: 'PUT', path: `${PVE}/ipset/allowed/10.1.0.0%2F24`, body: { nomatch: '0', comment: 'back in', digest: 'd5' } },
      ]);
    });

    it('DELETE /ipsets/:name/:cidr uses the encoded CIDR path (IPv4 and IPv6) with the digest', async () => {
      const cookie = await setupSession();
      await call('DELETE', `${G}/ipsets/allowed/10.1.0.0%2F24?digest=d5`, { cookie });
      await call('DELETE', `${G}/ipsets/allowed/${encodeURIComponent('fd00::/64')}`, { cookie });
      expect(fakePve.guestRefsCalls).toStrictEqual([
        { method: 'DELETE', path: `${PVE}/ipset/allowed/10.1.0.0%2F24`, body: { digest: 'd5' } },
        { method: 'DELETE', path: `${PVE}/ipset/allowed/fd00%3A%3A%2F64`, body: {} },
      ]);
    });

    it('uses the lxc path for a container (entry add)', async () => {
      const cookie = await setupSession();
      await call('POST', '/pve1/lxc/101/firewall/ipsets/allowed', { cookie, payload: { cidr: '10.1.0.0/24' } });
      expect(fakePve.guestRefsCalls).toStrictEqual([
        { method: 'POST', path: `${PVE_LXC}/ipset/allowed`, body: { cidr: '10.1.0.0/24' } },
      ]);
    });
  });

  describe('validation (400, never reaches PVE)', () => {
    it.each([
      ['POST', `${G}/aliases`, { name: '1bad', cidr: '10.0.0.1' }],
      ['POST', `${G}/aliases`, { name: 'a', cidr: '10.0.0.1' }],
      ['POST', `${G}/aliases`, { name: 'bad name', cidr: '10.0.0.1' }],
      ['POST', `${G}/aliases`, { name: 'x'.repeat(65), cidr: '10.0.0.1' }],
      ['POST', `${G}/aliases`, { name: 'office', cidr: 'not-an-ip' }],
      ['POST', `${G}/aliases`, { name: 'office', cidr: '10.0.0.0/33' }],
      ['POST', `${G}/aliases`, { name: 'office', cidr: 'fd00::/129' }],
      ['POST', `${G}/aliases`, { name: 'office', cidr: '10.0.0.1', extra: true }],
      ['POST', `${G}/aliases`, { name: 'office', cidr: '10.0.0.1', comment: 'two\nlines' }],
      ['PUT', `${G}/aliases/office`, { cidr: 'nope' }],
      ['PUT', `${G}/aliases/office`, { cidr: '10.0.0.1', rename: 'bad name' }],
      ['PUT', `${G}/aliases/office`, { cidr: '10.0.0.1', digest: 'bad digest!' }],
      ['PUT', `${G}/aliases/1bad`, { cidr: '10.0.0.1' }],
      ['DELETE', `${G}/aliases/1bad`, undefined],
      ['DELETE', `${G}/aliases/office?digest=bad%20digest`, undefined],
      ['DELETE', `${G}/aliases/office?extra=1`, undefined],
      ['POST', `${G}/ipsets`, { name: 'bad name' }],
      ['POST', `${G}/ipsets/allowed`, { cidr: 'not-an-ip' }],
      ['POST', `${G}/ipsets/allowed`, { cidr: '10.0.0.0/24', extra: true }],
      ['PUT', `${G}/ipsets/allowed/10.0.0.0%2F24`, {}],
      ['PUT', `${G}/ipsets/allowed/not-an-ip`, { nomatch: true }],
      ['DELETE', `${G}/ipsets/allowed?force=maybe`, undefined],
      ['DELETE', `${G}/ipsets/allowed?digest=d5`, undefined],
      ['DELETE', `${G}/ipsets/allowed/10.0.0.0%2F99`, undefined],
    ] as Array<[Method, string, unknown]>)('%s %s rejects an invalid request', async (method, path, payload) => {
      const cookie = await setupSession();
      const res = await call(method, path, { cookie, payload });
      expect(res.statusCode).toBe(400);
      expect(fakePve.guestRefsCalls).toHaveLength(0);
    });

    it('rejects a bad type, node or vmid in the path', async () => {
      const cookie = await setupSession();
      const payload = { name: 'office', cidr: '10.0.0.1' };
      for (const path of ['/pve1/vm/100/firewall/aliases', '/pve1/qemu/abc/firewall/aliases', '/pve1/qemu/0/firewall/aliases']) {
        const res = await call('POST', path, { cookie, payload });
        expect(res.statusCode, path).toBe(400);
      }
      expect(fakePve.guestRefsCalls).toHaveLength(0);
    });

    it('refuses a digest sent in both the query and the body with different values', async () => {
      const cookie = await setupSession();
      const res = await call('DELETE', `${G}/aliases/office?digest=d5`, { cookie, payload: { digest: 'd6' } });
      expect(res.statusCode).toBe(400);
      expect(fakePve.guestRefsCalls).toHaveLength(0);
    });
  });

  describe('PVE errors', () => {
    it('relays a PVE 4xx as pve-rejected with the PVE message', async () => {
      const cookie = await setupSession();
      fakePve.setGuestRefsError({ status: 400, message: "alias 'office' already exists" });
      const res = await call('POST', `${G}/aliases`, { cookie, payload: { name: 'office', cidr: '10.0.0.1' } });
      expect(res.statusCode).toBe(400);
      expect(res.json()).toEqual({ error: 'pve-rejected', message: "alias 'office' already exists" });
    });

    it('relays a stale digest on a delete as pve-rejected', async () => {
      const cookie = await setupSession();
      fakePve.setGuestRefsError({ status: 400, message: 'detected modified configuration - file changed by other user!' });
      const res = await call('DELETE', `${G}/ipsets/allowed/10.0.0.0%2F24?digest=stale`, { cookie });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toBe('pve-rejected');
    });

    it('maps a PVE 5xx to 502 pve-unreachable on every route', async () => {
      const cookie = await setupSession();
      fakePve.setGuestRefsError({ status: 500, message: 'internal error' });
      for (const route of ALL_ROUTES) {
        const res = await call(route.method, route.path, { cookie, payload: route.payload });
        expect(res.statusCode, route.name).toBe(502);
        expect(res.json()).toEqual({ error: 'pve-unreachable' });
      }
      expect(fakePve.guestRefsCalls).toHaveLength(ALL_ROUTES.length);
    });
  });

  describe('reads through the read-only proxy', () => {
    it('serves the aliases, IP sets, one set and the refs of a guest, and still refuses a write', async () => {
      const cookie = await setupSession();
      const read = async (path: string) => {
        const res = await app.inject({ method: 'GET', url: `/api/pve/nodes/pve1/qemu/100/firewall${path}`, headers: { cookie } });
        expect(res.statusCode, path).toBe(200);
        return (res.json() as { data: Array<Record<string, unknown>> }).data;
      };
      expect((await read('/aliases'))[0]).toMatchObject({ name: 'web-net', cidr: '10.1.0.0/24' });
      expect((await read('/ipset'))[0]).toMatchObject({ name: 'allowed' });
      expect((await read('/ipset/allowed'))[0]).toMatchObject({ cidr: '10.1.0.5' });
      expect((await read('/refs')).map((r) => r.ref)).toEqual(['guest/web-net', '+dc/trusted']);

      const write = await app.inject({
        method: 'POST',
        url: '/api/pve/nodes/pve1/qemu/100/firewall/aliases',
        headers: { cookie },
        payload: { name: 'x', cidr: '10.0.0.1' },
      });
      expect(write.statusCode).toBeGreaterThanOrEqual(400);
      expect(fakePve.guestRefsCalls).toHaveLength(0);
    });
  });
});
