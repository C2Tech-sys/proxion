import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance, InjectOptions } from 'fastify';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { startFakePve, type FakePve } from './helpers/fakePve.js';

const SYS_MODIFY = { 'Sys.Modify': true };
const PVE = '/api2/json/cluster/firewall';

type Method = 'POST' | 'PUT' | 'DELETE';
interface RouteCase {
  name: string;
  method: Method;
  path: string;
  payload?: unknown;
}

/** One valid request per route, so the auth gates can be proven on every one. */
const ALL_ROUTES: RouteCase[] = [
  { name: 'rule add', method: 'POST', path: '/rules', payload: { type: 'in', action: 'ACCEPT' } },
  { name: 'rule edit', method: 'PUT', path: '/rules/1', payload: { enable: false } },
  { name: 'rule delete', method: 'DELETE', path: '/rules/1' },
  { name: 'options', method: 'PUT', path: '/options', payload: { enable: true } },
  { name: 'group create', method: 'POST', path: '/groups', payload: { group: 'webservers' } },
  { name: 'group delete', method: 'DELETE', path: '/groups/webservers' },
  { name: 'group rule add', method: 'POST', path: '/groups/webservers/rules', payload: { type: 'in', action: 'ACCEPT' } },
  { name: 'group rule edit', method: 'PUT', path: '/groups/webservers/rules/0', payload: { enable: false } },
  { name: 'group rule delete', method: 'DELETE', path: '/groups/webservers/rules/0' },
  { name: 'alias add', method: 'POST', path: '/aliases', payload: { name: 'office', cidr: '10.0.0.0/24' } },
  { name: 'alias edit', method: 'PUT', path: '/aliases/office', payload: { cidr: '10.0.0.0/24' } },
  { name: 'alias delete', method: 'DELETE', path: '/aliases/office' },
  { name: 'ipset create', method: 'POST', path: '/ipsets', payload: { name: 'trusted' } },
  { name: 'ipset delete', method: 'DELETE', path: '/ipsets/trusted' },
  { name: 'ipset entry add', method: 'POST', path: '/ipsets/trusted', payload: { cidr: '10.0.0.0/24' } },
  { name: 'ipset entry edit', method: 'PUT', path: '/ipsets/trusted/10.0.0.0%2F24', payload: { nomatch: true } },
  { name: 'ipset entry delete', method: 'DELETE', path: '/ipsets/trusted/10.0.0.0%2F24' },
];

function routesOf(...prefixes: string[]): RouteCase[] {
  return ALL_ROUTES.filter((route) => prefixes.some((prefix) => route.name.startsWith(prefix)));
}

describe('datacenter firewall routes (T67)', () => {
  let fakePve: FakePve;
  let app: FastifyInstance;

  afterEach(async () => {
    await app?.close();
    await fakePve?.close();
  });

  async function setupSession(options: { sysModify?: boolean } = {}): Promise<string> {
    fakePve = await startFakePve();
    if (options.sysModify !== false) fakePve.setRootPermissions(SYS_MODIFY);
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
    fakePve.setRootPermissions(SYS_MODIFY);
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
    const injectOptions: InjectOptions = { method, url: `/api/actions/datacenter/firewall${path}` };
    if (options.cookie !== undefined) injectOptions.headers = { cookie: options.cookie };
    if (options.payload !== undefined) injectOptions.payload = options.payload as NonNullable<InjectOptions['payload']>;
    return app.inject(injectOptions);
  }

  describe('token mode', () => {
    it('every route 403s without reaching PVE', async () => {
      await setupTokenMode();
      for (const route of ALL_ROUTES) {
        const res = await call(route.method, route.path, { payload: route.payload });
        expect(res.statusCode, route.name).toBe(403);
        expect(res.json(), route.name).toEqual({ error: 'writes-disabled-in-token-mode' });
      }
      expect(fakePve.clusterFirewallCalls).toHaveLength(0);
    });
  });

  describe('authentication and privilege', () => {
    it('401s without a session on every route', async () => {
      await setupSession();
      for (const route of ALL_ROUTES) {
        const res = await call(route.method, route.path, { payload: route.payload });
        expect(res.statusCode, route.name).toBe(401);
      }
      expect(fakePve.clusterFirewallCalls).toHaveLength(0);
    });

    it.each([
      ['rules', routesOf('rule ')],
      ['options', routesOf('options')],
      ['security groups', routesOf('group ', 'group rule')],
      ['aliases', routesOf('alias')],
      ['IP sets', routesOf('ipset')],
    ])('403s naming Sys.Modify on every %s route without it', async (_label, routes) => {
      const cookie = await setupSession({ sysModify: false });
      expect(routes.length).toBeGreaterThan(0);
      for (const route of routes) {
        const res = await call(route.method, route.path, { cookie, payload: route.payload });
        expect(res.statusCode, route.name).toBe(403);
        expect(res.json(), route.name).toEqual({ error: 'forbidden', missing: 'Sys.Modify' });
      }
      expect(fakePve.clusterFirewallCalls).toHaveLength(0);
    });

    it('a different root privilege is not enough', async () => {
      const cookie = await setupSession({ sysModify: false });
      fakePve.setRootPermissions({ 'Sys.Audit': true, 'Sys.Modify': false });
      const res = await call('PUT', '/options', { cookie, payload: { enable: true } });
      expect(res.statusCode).toBe(403);
      expect(res.json()).toEqual({ error: 'forbidden', missing: 'Sys.Modify' });
      expect(fakePve.clusterFirewallCalls).toHaveLength(0);
    });

    it('rejects an invalid body with 400 before any permission lookup or PVE write', async () => {
      const cookie = await setupSession({ sysModify: false });
      const res = await call('POST', '/rules', { cookie, payload: { type: 'in', action: 'MAYBE' } });
      expect(res.statusCode).toBe(400);
      expect(fakePve.clusterFirewallCalls).toHaveLength(0);
    });
  });

  describe('rules', () => {
    it('POST /rules sends the exact PVE body and answers 201', async () => {
      const cookie = await setupSession();
      const res = await call('POST', '/rules', {
        cookie,
        payload: { type: 'in', action: 'ACCEPT', proto: 'tcp', dport: '22', source: '10.0.0.0/24', comment: 'ssh', pos: 0, digest: 'abc123' },
      });
      expect(res.statusCode).toBe(201);
      expect(res.json()).toEqual({ ok: true });
      expect(fakePve.clusterFirewallCalls).toStrictEqual([
        {
          method: 'POST',
          path: `${PVE}/rules`,
          body: {
            type: 'in',
            action: 'ACCEPT',
            enable: '1',
            proto: 'tcp',
            dport: '22',
            source: '10.0.0.0/24',
            comment: 'ssh',
            pos: '0',
            digest: 'abc123',
          },
        },
      ]);
    });

    it('POST /rules accepts a group rule naming a security group', async () => {
      const cookie = await setupSession();
      const res = await call('POST', '/rules', { cookie, payload: { type: 'group', action: 'webservers', enable: false } });
      expect(res.statusCode).toBe(201);
      expect(fakePve.clusterFirewallCalls).toStrictEqual([
        { method: 'POST', path: `${PVE}/rules`, body: { type: 'group', action: 'webservers', enable: '0' } },
      ]);
    });

    it.each([
      ['an action that does not match the type', { type: 'in', action: 'webservers' }],
      ['a verdict on a group rule', { type: 'group', action: 'DROP' }],
      ['an unknown key', { type: 'in', action: 'ACCEPT', forward: true }],
      ['an out-of-range port', { type: 'in', action: 'ACCEPT', dport: '70000' }],
      ['an unknown protocol', { type: 'in', action: 'ACCEPT', proto: 'sctp' }],
      ['a multi-line comment', { type: 'in', action: 'ACCEPT', comment: 'a\nb' }],
      ['a forward rule', { type: 'forward', action: 'ACCEPT' }],
    ])('POST /rules rejects %s with 400', async (_label, payload) => {
      const cookie = await setupSession();
      const res = await call('POST', '/rules', { cookie, payload });
      expect(res.statusCode).toBe(400);
      expect(fakePve.clusterFirewallCalls).toHaveLength(0);
    });

    it('PUT /rules/:pos toggles with the digest', async () => {
      const cookie = await setupSession();
      const res = await call('PUT', '/rules/2', { cookie, payload: { enable: false, digest: 'abc123' } });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ ok: true });
      expect(fakePve.clusterFirewallCalls).toStrictEqual([
        { method: 'PUT', path: `${PVE}/rules/2`, body: { enable: '0', digest: 'abc123' } },
      ]);
    });

    it('PUT /rules/:pos moves a rule and clears fields through the delete list', async () => {
      const cookie = await setupSession();
      await call('PUT', '/rules/3', { cookie, payload: { moveto: 0 } });
      await call('PUT', '/rules/3', { cookie, payload: { action: 'DROP', delete: ['comment', 'icmpType', 'dport'] } });
      expect(fakePve.clusterFirewallCalls).toStrictEqual([
        { method: 'PUT', path: `${PVE}/rules/3`, body: { moveto: '0' } },
        { method: 'PUT', path: `${PVE}/rules/3`, body: { action: 'DROP', delete: 'comment,icmp-type,dport' } },
      ]);
    });

    it.each([
      ['an empty body', '/rules/1', {}],
      ['only a digest', '/rules/1', { digest: 'abc' }],
      ['a field both set and deleted', '/rules/1', { comment: 'x', delete: ['comment'] }],
      ['a non-numeric position', '/rules/first', { enable: true }],
    ])('PUT rejects %s with 400', async (_label, path, payload) => {
      const cookie = await setupSession();
      const res = await call('PUT', path, { cookie, payload });
      expect(res.statusCode).toBe(400);
      expect(fakePve.clusterFirewallCalls).toHaveLength(0);
    });

    it('DELETE /rules/:pos forwards the digest query', async () => {
      const cookie = await setupSession();
      const res = await call('DELETE', '/rules/4?digest=abc123', { cookie });
      expect(res.statusCode).toBe(200);
      expect(fakePve.clusterFirewallCalls).toStrictEqual([
        { method: 'DELETE', path: `${PVE}/rules/4`, body: { digest: 'abc123' } },
      ]);
    });

    it('DELETE /rules/:pos without a digest sends none', async () => {
      const cookie = await setupSession();
      await call('DELETE', '/rules/0', { cookie });
      expect(fakePve.clusterFirewallCalls).toStrictEqual([{ method: 'DELETE', path: `${PVE}/rules/0`, body: {} }]);
    });
  });

  describe('options', () => {
    it('PUT /options composes log_ratelimit and sends the exact PVE body', async () => {
      const cookie = await setupSession();
      const res = await call('PUT', '/options', {
        cookie,
        payload: {
          enable: true,
          policy_in: 'DROP',
          policy_out: 'ACCEPT',
          ebtables: false,
          log_ratelimit: { enabled: true, burst: 5, rate: '1/second' },
          digest: 'd1',
        },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ ok: true });
      expect(fakePve.clusterFirewallCalls).toStrictEqual([
        {
          method: 'PUT',
          path: `${PVE}/options`,
          body: {
            enable: '1',
            policy_in: 'DROP',
            policy_out: 'ACCEPT',
            ebtables: '0',
            log_ratelimit: 'enable=1,burst=5,rate=1/second',
            digest: 'd1',
          },
        },
      ]);
    });

    it('PUT /options with the rate limit switched off sends only enable=0', async () => {
      const cookie = await setupSession();
      await call('PUT', '/options', { cookie, payload: { log_ratelimit: { enabled: false } } });
      expect(fakePve.clusterFirewallCalls).toStrictEqual([
        { method: 'PUT', path: `${PVE}/options`, body: { log_ratelimit: 'enable=0' } },
      ]);
    });

    it.each([
      ['an empty body', {}],
      ['only a digest', { digest: 'abc' }],
      ['a malformed rate', { log_ratelimit: { enabled: true, rate: 'fast' } }],
      ['an injected property string', { log_ratelimit: { enabled: true, rate: '1/second,burst=9' } }],
      ['a negative burst', { log_ratelimit: { enabled: true, burst: -1 } }],
      ['an unknown policy', { policy_in: 'MAYBE' }],
      ['an unmanaged option', { policy_forward: 'DROP' }],
    ])('PUT /options rejects %s with 400', async (_label, payload) => {
      const cookie = await setupSession();
      const res = await call('PUT', '/options', { cookie, payload });
      expect(res.statusCode).toBe(400);
      expect(fakePve.clusterFirewallCalls).toHaveLength(0);
    });
  });

  describe('security groups', () => {
    it('POST /groups creates a group', async () => {
      const cookie = await setupSession();
      const res = await call('POST', '/groups', { cookie, payload: { group: 'webservers', comment: 'Web tier' } });
      expect(res.statusCode).toBe(201);
      expect(fakePve.clusterFirewallCalls).toStrictEqual([
        { method: 'POST', path: `${PVE}/groups`, body: { group: 'webservers', comment: 'Web tier' } },
      ]);
    });

    it('POST /groups updates an existing group through rename (the existing name) and forwards the digest', async () => {
      const cookie = await setupSession();
      const res = await call('POST', '/groups', { cookie, payload: { group: 'webservers', rename: 'web-tier', digest: 'd2' } });
      expect(res.statusCode).toBe(201);
      expect(fakePve.clusterFirewallCalls).toStrictEqual([
        { method: 'POST', path: `${PVE}/groups`, body: { group: 'webservers', rename: 'web-tier', digest: 'd2' } },
      ]);
    });

    it.each([
      ['a name starting with a digit', { group: '1web' }],
      ['a one-character name', { group: 'w' }],
      ['a 21-character name', { group: 'a'.repeat(21) }],
      ['a name with a slash', { group: 'web/servers' }],
      ['a bad rename', { group: 'webservers', rename: 'bad name' }],
    ])('POST /groups rejects %s with 400', async (_label, payload) => {
      const cookie = await setupSession();
      const res = await call('POST', '/groups', { cookie, payload });
      expect(res.statusCode).toBe(400);
      expect(fakePve.clusterFirewallCalls).toHaveLength(0);
    });

    it('DELETE /groups/:group removes the group (PVE takes no digest there)', async () => {
      const cookie = await setupSession();
      const res = await call('DELETE', '/groups/webservers', { cookie });
      expect(res.statusCode).toBe(200);
      expect(fakePve.clusterFirewallCalls).toStrictEqual([{ method: 'DELETE', path: `${PVE}/groups/webservers`, body: {} }]);
      expect((await call('DELETE', '/groups/webservers?digest=abc', { cookie })).statusCode).toBe(400);
    });

    it('POST /groups/:group/rules posts the rule to the group path, not the body', async () => {
      const cookie = await setupSession();
      const res = await call('POST', '/groups/webservers/rules', {
        cookie,
        payload: { type: 'in', action: 'ACCEPT', proto: 'tcp', dport: '443', comment: 'https', pos: 1 },
      });
      expect(res.statusCode).toBe(201);
      expect(fakePve.clusterFirewallCalls).toStrictEqual([
        {
          method: 'POST',
          path: `${PVE}/groups/webservers`,
          body: { type: 'in', action: 'ACCEPT', enable: '1', proto: 'tcp', dport: '443', comment: 'https', pos: '1' },
        },
      ]);
    });

    it('group rules cannot nest another group', async () => {
      const cookie = await setupSession();
      const create = await call('POST', '/groups/webservers/rules', { cookie, payload: { type: 'group', action: 'dbservers' } });
      const update = await call('PUT', '/groups/webservers/rules/0', { cookie, payload: { type: 'group', action: 'dbservers' } });
      const bareName = await call('PUT', '/groups/webservers/rules/0', { cookie, payload: { action: 'dbservers' } });
      expect([create.statusCode, update.statusCode, bareName.statusCode]).toEqual([400, 400, 400]);
      expect(fakePve.clusterFirewallCalls).toHaveLength(0);
    });

    it('PUT and DELETE /groups/:group/rules/:pos address the group rule', async () => {
      const cookie = await setupSession();
      await call('PUT', '/groups/webservers/rules/1', { cookie, payload: { enable: false, moveto: 0, digest: 'd3' } });
      await call('DELETE', '/groups/webservers/rules/1?digest=d3', { cookie });
      expect(fakePve.clusterFirewallCalls).toStrictEqual([
        { method: 'PUT', path: `${PVE}/groups/webservers/1`, body: { enable: '0', moveto: '0', digest: 'd3' } },
        { method: 'DELETE', path: `${PVE}/groups/webservers/1`, body: { digest: 'd3' } },
      ]);
    });
  });

  describe('aliases', () => {
    it('POST /aliases creates an alias', async () => {
      const cookie = await setupSession();
      const res = await call('POST', '/aliases', { cookie, payload: { name: 'office', cidr: '10.0.0.0/24', comment: 'Office LAN' } });
      expect(res.statusCode).toBe(201);
      expect(fakePve.clusterFirewallCalls).toStrictEqual([
        { method: 'POST', path: `${PVE}/aliases`, body: { name: 'office', cidr: '10.0.0.0/24', comment: 'Office LAN' } },
      ]);
    });

    it('POST /aliases accepts a bare IPv4 address, an IPv6 address and an IPv6 CIDR', async () => {
      const cookie = await setupSession();
      for (const cidr of ['192.168.1.5', '2001:db8::1', 'fd00::/64']) {
        const res = await call('POST', '/aliases', { cookie, payload: { name: 'host', cidr } });
        expect(res.statusCode, cidr).toBe(201);
      }
      expect(fakePve.clusterFirewallCalls.map((c) => c.body.cidr)).toEqual(['192.168.1.5', '2001:db8::1', 'fd00::/64']);
    });

    it.each([
      ['an octet out of range', { name: 'office', cidr: '10.0.0.256' }],
      ['an IPv4 prefix over 32', { name: 'office', cidr: '10.0.0.0/33' }],
      ['an IPv6 prefix over 128', { name: 'office', cidr: 'fe80::1/129' }],
      ['a hostname', { name: 'office', cidr: 'example.com' }],
      ['an empty prefix', { name: 'office', cidr: '10.0.0.1/' }],
      ['a name starting with a digit', { name: '1office', cidr: '10.0.0.0/24' }],
      ['a missing cidr', { name: 'office' }],
    ])('POST /aliases rejects %s with 400', async (_label, payload) => {
      const cookie = await setupSession();
      const res = await call('POST', '/aliases', { cookie, payload });
      expect(res.statusCode).toBe(400);
      expect(fakePve.clusterFirewallCalls).toHaveLength(0);
    });

    it('PUT /aliases/:name edits and renames with the digest', async () => {
      const cookie = await setupSession();
      const res = await call('PUT', '/aliases/office', {
        cookie,
        payload: { cidr: '10.1.0.0/16', comment: 'Moved', rename: 'hq', digest: 'd4' },
      });
      expect(res.statusCode).toBe(200);
      expect(fakePve.clusterFirewallCalls).toStrictEqual([
        { method: 'PUT', path: `${PVE}/aliases/office`, body: { cidr: '10.1.0.0/16', comment: 'Moved', rename: 'hq', digest: 'd4' } },
      ]);
    });

    it('DELETE /aliases/:name forwards the digest', async () => {
      const cookie = await setupSession();
      const res = await call('DELETE', '/aliases/office?digest=d4', { cookie });
      expect(res.statusCode).toBe(200);
      expect(fakePve.clusterFirewallCalls).toStrictEqual([
        { method: 'DELETE', path: `${PVE}/aliases/office`, body: { digest: 'd4' } },
      ]);
    });
  });

  describe('IP sets', () => {
    it('POST /ipsets creates a set', async () => {
      const cookie = await setupSession();
      const res = await call('POST', '/ipsets', { cookie, payload: { name: 'trusted', comment: 'Admin hosts' } });
      expect(res.statusCode).toBe(201);
      expect(fakePve.clusterFirewallCalls).toStrictEqual([
        { method: 'POST', path: `${PVE}/ipset`, body: { name: 'trusted', comment: 'Admin hosts' } },
      ]);
    });

    it('POST /ipsets updates an existing set through rename (the existing name), here only its comment', async () => {
      const cookie = await setupSession();
      const res = await call('POST', '/ipsets', { cookie, payload: { name: 'trusted', rename: 'trusted', comment: 'New text', digest: 'd6' } });
      expect(res.statusCode).toBe(201);
      expect(fakePve.clusterFirewallCalls).toStrictEqual([
        { method: 'POST', path: `${PVE}/ipset`, body: { name: 'trusted', rename: 'trusted', comment: 'New text', digest: 'd6' } },
      ]);
    });

    it('POST /ipsets/:name adds an entry with nomatch', async () => {
      const cookie = await setupSession();
      const res = await call('POST', '/ipsets/trusted', {
        cookie,
        payload: { cidr: '10.0.0.0/24', nomatch: true, comment: 'excluded' },
      });
      expect(res.statusCode).toBe(201);
      expect(fakePve.clusterFirewallCalls).toStrictEqual([
        { method: 'POST', path: `${PVE}/ipset/trusted`, body: { cidr: '10.0.0.0/24', nomatch: '1', comment: 'excluded' } },
      ]);
    });

    it('PUT /ipsets/:name/:cidr keeps the CIDR slash URL-encoded on the way to PVE', async () => {
      const cookie = await setupSession();
      const res = await call('PUT', '/ipsets/trusted/10.0.0.0%2F24', {
        cookie,
        payload: { nomatch: false, comment: 'back in', digest: 'd5' },
      });
      expect(res.statusCode).toBe(200);
      expect(fakePve.clusterFirewallCalls).toStrictEqual([
        { method: 'PUT', path: `${PVE}/ipset/trusted/10.0.0.0%2F24`, body: { nomatch: '0', comment: 'back in', digest: 'd5' } },
      ]);
    });

    it('DELETE /ipsets/:name/:cidr uses the encoded CIDR path (IPv4 and IPv6) with the digest', async () => {
      const cookie = await setupSession();
      await call('DELETE', '/ipsets/trusted/10.0.0.0%2F24?digest=d5', { cookie });
      await call('DELETE', `/ipsets/trusted/${encodeURIComponent('fd00::/64')}`, { cookie });
      expect(fakePve.clusterFirewallCalls).toStrictEqual([
        { method: 'DELETE', path: `${PVE}/ipset/trusted/10.0.0.0%2F24`, body: { digest: 'd5' } },
        { method: 'DELETE', path: `${PVE}/ipset/trusted/fd00%3A%3A%2F64`, body: {} },
      ]);
    });

    it('DELETE /ipsets/:name forwards force only when asked', async () => {
      const cookie = await setupSession();
      await call('DELETE', '/ipsets/trusted', { cookie });
      await call('DELETE', '/ipsets/trusted?force=1', { cookie });
      expect(fakePve.clusterFirewallCalls).toStrictEqual([
        { method: 'DELETE', path: `${PVE}/ipset/trusted`, body: {} },
        { method: 'DELETE', path: `${PVE}/ipset/trusted`, body: { force: '1' } },
      ]);
    });

    it.each([
      ['POST', '/ipsets', { name: 'bad name' }],
      ['POST', '/ipsets/trusted', { cidr: 'not-an-ip' }],
      ['POST', '/ipsets/trusted', { cidr: '10.0.0.0/24', extra: true }],
      ['PUT', '/ipsets/trusted/10.0.0.0%2F24', {}],
      ['PUT', '/ipsets/trusted/not-an-ip', { nomatch: true }],
      ['DELETE', '/ipsets/trusted?force=maybe', undefined],
    ] as Array<[Method, string, unknown]>)('%s %s rejects an invalid request with 400', async (method, path, payload) => {
      const cookie = await setupSession();
      const res = await call(method, path, { cookie, payload });
      expect(res.statusCode).toBe(400);
      expect(fakePve.clusterFirewallCalls).toHaveLength(0);
    });
  });

  describe('PVE errors', () => {
    it('relays a PVE 4xx as pve-rejected with the sanitized message', async () => {
      const cookie = await setupSession();
      fakePve.setClusterFirewallError({ status: 400, message: 'unable to parse digest' });
      const res = await call('POST', '/rules', { cookie, payload: { type: 'in', action: 'ACCEPT' } });
      expect(res.statusCode).toBe(400);
      expect(res.json()).toEqual({ error: 'pve-rejected', message: 'unable to parse digest' });
    });

    it('relays a PVE 4xx on a delete (a group still in use)', async () => {
      const cookie = await setupSession();
      fakePve.setClusterFirewallError({ status: 400, message: "security group 'webservers' is still in use" });
      const res = await call('DELETE', '/groups/webservers', { cookie });
      expect(res.statusCode).toBe(400);
      expect(res.json()).toEqual({ error: 'pve-rejected', message: "security group 'webservers' is still in use" });
    });

    it('maps a PVE 5xx to 502 pve-unreachable', async () => {
      const cookie = await setupSession();
      fakePve.setClusterFirewallError({ status: 500, message: 'boom' });
      const res = await call('PUT', '/options', { cookie, payload: { enable: true } });
      expect(res.statusCode).toBe(502);
      expect(res.json()).toEqual({ error: 'pve-unreachable' });
    });

    it('a write works again once PVE recovers', async () => {
      const cookie = await setupSession();
      fakePve.setClusterFirewallError({ status: 500, message: 'boom' });
      expect((await call('PUT', '/options', { cookie, payload: { enable: true } })).statusCode).toBe(502);
      fakePve.setClusterFirewallError(undefined);
      expect((await call('PUT', '/options', { cookie, payload: { enable: true } })).statusCode).toBe(200);
    });
  });
});
