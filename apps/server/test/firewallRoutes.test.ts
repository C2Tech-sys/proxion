import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance, InjectOptions } from 'fastify';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { startFakePve, type FakePve } from './helpers/fakePve.js';

const FW_PRIV = { 'VM.Config.Network': true };

describe('guest firewall routes (T56)', () => {
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
    options: { cookie?: string; payload?: unknown } = {},
  ) {
    const injectOptions: InjectOptions = { method, url: `/api/actions/guest${path}` };
    if (options.cookie !== undefined) injectOptions.headers = { cookie: options.cookie };
    if (options.payload !== undefined) injectOptions.payload = options.payload as NonNullable<InjectOptions['payload']>;
    return app.inject(injectOptions);
  }

  const RULES = '/pve1/qemu/100/firewall/rules';
  const RULE = '/pve1/qemu/100/firewall/rules/2';
  const OPTIONS = '/pve1/qemu/100/firewall/options';
  const SSH_RULE = { type: 'in', action: 'ACCEPT', proto: 'tcp', dport: '22' };

  describe('token mode', () => {
    it('all four routes 403 without reaching PVE', async () => {
      await setupTokenMode();
      const results = [
        await call('POST', RULES, { payload: SSH_RULE }),
        await call('PUT', RULE, { payload: { enable: false } }),
        await call('DELETE', RULE),
        await call('PUT', OPTIONS, { payload: { enable: true } }),
      ];
      for (const res of results) {
        expect(res.statusCode).toBe(403);
        expect(res.json()).toEqual({ error: 'writes-disabled-in-token-mode' });
      }
      expect(fakePve.firewallCalls).toHaveLength(0);
    });
  });

  describe('authentication and privilege', () => {
    it('401s without a session on every route', async () => {
      await setupSession();
      expect((await call('POST', RULES, { payload: SSH_RULE })).statusCode).toBe(401);
      expect((await call('PUT', RULE, { payload: { enable: false } })).statusCode).toBe(401);
      expect((await call('DELETE', RULE)).statusCode).toBe(401);
      expect((await call('PUT', OPTIONS, { payload: { enable: true } })).statusCode).toBe(401);
      expect(fakePve.firewallCalls).toHaveLength(0);
    });

    it('403s naming VM.Config.Network on POST rules', async () => {
      const cookie = await setupSession();
      fakePve.setVmPermissions(100, { 'VM.Config.Network': false, 'VM.Config.CPU': true });
      const res = await call('POST', RULES, { cookie, payload: SSH_RULE });
      expect(res.statusCode).toBe(403);
      expect(res.json()).toEqual({ error: 'forbidden', missing: 'VM.Config.Network' });
      expect(fakePve.firewallCalls).toHaveLength(0);
    });

    it('403s naming VM.Config.Network on PUT rule', async () => {
      const cookie = await setupSession();
      fakePve.setVmPermissions(100, { 'VM.Config.Network': false });
      const res = await call('PUT', RULE, { cookie, payload: { enable: false } });
      expect(res.statusCode).toBe(403);
      expect(res.json()).toEqual({ error: 'forbidden', missing: 'VM.Config.Network' });
      expect(fakePve.firewallCalls).toHaveLength(0);
    });

    it('403s naming VM.Config.Network on DELETE rule', async () => {
      const cookie = await setupSession();
      fakePve.setVmPermissions(100, { 'VM.Config.Network': false });
      const res = await call('DELETE', RULE, { cookie });
      expect(res.statusCode).toBe(403);
      expect(res.json()).toEqual({ error: 'forbidden', missing: 'VM.Config.Network' });
      expect(fakePve.firewallCalls).toHaveLength(0);
    });

    it('403s naming VM.Config.Network on PUT options', async () => {
      const cookie = await setupSession();
      fakePve.setVmPermissions(100, { 'VM.Config.Network': false });
      const res = await call('PUT', OPTIONS, { cookie, payload: { enable: true } });
      expect(res.statusCode).toBe(403);
      expect(res.json()).toEqual({ error: 'forbidden', missing: 'VM.Config.Network' });
      expect(fakePve.firewallCalls).toHaveLength(0);
    });
  });

  describe('POST rules: body validation (400)', () => {
    async function expect400(payload: unknown, path = RULES) {
      const cookie = await setupSession();
      fakePve.setVmPermissions(100, FW_PRIV);
      const res = await call('POST', path, { cookie, payload });
      expect(res.statusCode).toBe(400);
      expect(fakePve.firewallCalls).toHaveLength(0);
    }

    it('rejects an action that does not fit the type', async () => {
      await expect400({ type: 'group', action: 'ACCEPT' });
      await expect400({ type: 'group', action: 'bad name!' });
      await expect400({ type: 'group', action: 'a' });
      await expect400({ type: 'in', action: 'webservers' });
      await expect400({ type: 'out', action: 'accept' });
    });

    it('rejects a missing or unknown type and a missing action', async () => {
      await expect400({ action: 'ACCEPT' });
      await expect400({ type: 'forward', action: 'ACCEPT' });
      await expect400({ type: 'in' });
    });

    it('rejects a bad protocol', async () => {
      await expect400({ ...SSH_RULE, proto: 'sctp' });
      await expect400({ ...SSH_RULE, proto: '256' });
      await expect400({ ...SSH_RULE, proto: 'tcp,udp' });
    });

    it('rejects bad ports', async () => {
      await expect400({ ...SSH_RULE, dport: '22;rm' });
      await expect400({ ...SSH_RULE, dport: '70000' });
      await expect400({ ...SSH_RULE, dport: '80:' });
      await expect400({ ...SSH_RULE, sport: 'Bad Name' });
      await expect400({ ...SSH_RULE, dport: '22,' });
    });

    it('rejects iface net32 and a non-netN interface', async () => {
      await expect400({ ...SSH_RULE, iface: 'net32' });
      await expect400({ ...SSH_RULE, iface: 'eth0' });
    });

    it('rejects a comment with a newline (or over 1024 characters)', async () => {
      await expect400({ ...SSH_RULE, comment: 'line one\nline two' });
      await expect400({ ...SSH_RULE, comment: 'x'.repeat(1025) });
    });

    it('rejects an address with disallowed characters or over 512 characters', async () => {
      await expect400({ ...SSH_RULE, source: '10.0.0.1;drop' });
      await expect400({ ...SSH_RULE, dest: '10.0.0.0/8\n1.1.1.1' });
      await expect400({ ...SSH_RULE, source: '1'.repeat(513) });
    });

    it('rejects a bad macro, log level, pos and icmp type', async () => {
      await expect400({ ...SSH_RULE, macro: 'SSH,Ping' });
      await expect400({ ...SSH_RULE, log: 'verbose' });
      await expect400({ ...SSH_RULE, pos: -1 });
      await expect400({ ...SSH_RULE, icmpType: 'echo request' });
    });

    it('rejects an unknown field', async () => {
      await expect400({ ...SSH_RULE, ipversion: 4 });
      await expect400({ ...SSH_RULE, 'icmp-type': 'echo-request' });
    });

    it('rejects a bad vmid in the path', async () => {
      await expect400(SSH_RULE, '/pve1/qemu/abc/firewall/rules');
    });
  });

  describe('POST rules: exact PVE bodies', () => {
    it('sends a full `in ACCEPT tcp dport 22` rule', async () => {
      const cookie = await setupSession();
      fakePve.setVmPermissions(100, FW_PRIV);
      const res = await call('POST', RULES, {
        cookie,
        payload: {
          type: 'in',
          action: 'ACCEPT',
          enable: true,
          macro: 'SSH',
          proto: 'tcp',
          source: '10.0.0.0/24,+trusted',
          dest: '192.168.1.5',
          sport: '1024:65535',
          dport: '22',
          iface: 'net0',
          log: 'info',
          comment: 'ssh from the office',
          pos: 0,
        },
      });
      expect(res.statusCode).toBe(201);
      expect(res.json()).toEqual({ ok: true });
      expect(fakePve.firewallCalls).toStrictEqual([
        {
          method: 'POST',
          path: '/api2/json/nodes/pve1/qemu/100/firewall/rules',
          body: {
            type: 'in',
            action: 'ACCEPT',
            enable: '1',
            macro: 'SSH',
            proto: 'tcp',
            source: '10.0.0.0/24,+trusted',
            dest: '192.168.1.5',
            sport: '1024:65535',
            dport: '22',
            iface: 'net0',
            log: 'info',
            comment: 'ssh from the office',
            pos: '0',
          },
        },
      ]);
    });

    it('sends a minimal rule with enable defaulting to 1, on an lxc guest', async () => {
      const cookie = await setupSession();
      fakePve.setVmPermissions(200, FW_PRIV);
      const res = await call('POST', '/pve1/lxc/200/firewall/rules', {
        cookie,
        payload: { type: 'out', action: 'DROP', proto: 'udp', dport: 'domain,53' },
      });
      expect(res.statusCode).toBe(201);
      expect(fakePve.firewallCalls).toStrictEqual([
        {
          method: 'POST',
          path: '/api2/json/nodes/pve1/lxc/200/firewall/rules',
          body: { type: 'out', action: 'DROP', enable: '1', proto: 'udp', dport: 'domain,53' },
        },
      ]);
    });

    it('sends a group rule with the group name as the action', async () => {
      const cookie = await setupSession();
      fakePve.setVmPermissions(100, FW_PRIV);
      const res = await call('POST', RULES, {
        cookie,
        payload: { type: 'group', action: 'webservers', iface: 'net1', comment: 'web group' },
      });
      expect(res.statusCode).toBe(201);
      expect(fakePve.firewallCalls[0]!.body).toStrictEqual({
        type: 'group',
        action: 'webservers',
        enable: '1',
        iface: 'net1',
        comment: 'web group',
      });
    });

    it('sends enable=0 for a disabled rule and icmpType as icmp-type', async () => {
      const cookie = await setupSession();
      fakePve.setVmPermissions(100, FW_PRIV);
      const res = await call('POST', RULES, {
        cookie,
        payload: { type: 'in', action: 'ACCEPT', enable: false, proto: 'icmp', icmpType: 'echo-request' },
      });
      expect(res.statusCode).toBe(201);
      expect(fakePve.firewallCalls[0]!.body).toStrictEqual({
        type: 'in',
        action: 'ACCEPT',
        enable: '0',
        proto: 'icmp',
        'icmp-type': 'echo-request',
      });
    });
  });

  describe('PUT rules/:pos', () => {
    async function expect400(payload: unknown, path = RULE) {
      const cookie = await setupSession();
      fakePve.setVmPermissions(100, FW_PRIV);
      const res = await call('PUT', path, { cookie, payload });
      expect(res.statusCode).toBe(400);
      expect(fakePve.firewallCalls).toHaveLength(0);
    }

    it('rejects an empty body, a digest-only body and an unknown field', async () => {
      await expect400({});
      await expect400({ digest: 'abc123' });
      await expect400({ enable: true, skiplock: 1 });
    });

    it('rejects a bad pos, a bad moveto and a bad digest', async () => {
      await expect400({ enable: true }, '/pve1/qemu/100/firewall/rules/-1');
      await expect400({ enable: true }, '/pve1/qemu/100/firewall/rules/abc');
      await expect400({ moveto: -1 });
      await expect400({ moveto: 1.5 });
      await expect400({ enable: true, digest: 'bad digest!' });
    });

    it('rejects a fractional or negative pos in the path without reaching PVE', async () => {
      await expect400({ enable: true }, '/pve1/qemu/100/firewall/rules/1.5');
      await expect400({ enable: true }, '/pve1/qemu/100/firewall/rules/-1');
      await expect400({ enable: true }, '/pve1/qemu/100/firewall/rules/1000001');
    });

    it('rejects a mismatched type/action and a field both set and deleted', async () => {
      await expect400({ type: 'group', action: 'DROP' });
      await expect400({ action: 'bad name!' });
      await expect400({ dport: '22', delete: ['dport'] });
      await expect400({ delete: ['pos'] });
      await expect400({ delete: [] });
    });

    it('sends only the changed fields (pos travels in the path), with enable=0 for a disable toggle', async () => {
      const cookie = await setupSession();
      fakePve.setVmPermissions(100, FW_PRIV);
      const res = await call('PUT', RULE, { cookie, payload: { enable: false, digest: 'abc123' } });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ ok: true });
      expect(fakePve.firewallCalls).toStrictEqual([
        {
          method: 'PUT',
          path: '/api2/json/nodes/pve1/qemu/100/firewall/rules/2',
          body: { enable: '0', digest: 'abc123' },
        },
      ]);
    });

    it('sends moveto', async () => {
      const cookie = await setupSession();
      fakePve.setVmPermissions(100, FW_PRIV);
      const res = await call('PUT', RULE, { cookie, payload: { moveto: 1 } });
      expect(res.statusCode).toBe(200);
      expect(fakePve.firewallCalls[0]!.body).toStrictEqual({ moveto: '1' });
    });

    it('sends a comma-separated delete list (icmpType mapped to icmp-type) next to changed fields', async () => {
      const cookie = await setupSession();
      fakePve.setVmPermissions(100, FW_PRIV);
      const res = await call('PUT', RULE, {
        cookie,
        payload: { action: 'REJECT', delete: ['dport', 'comment', 'icmpType', 'dport'] },
      });
      expect(res.statusCode).toBe(200);
      expect(fakePve.firewallCalls[0]!.body).toStrictEqual({
        action: 'REJECT',
        delete: 'dport,comment,icmp-type',
      });
    });

    it('sends a group retarget (type + action) on an lxc guest', async () => {
      const cookie = await setupSession();
      fakePve.setVmPermissions(200, FW_PRIV);
      const res = await call('PUT', '/pve1/lxc/200/firewall/rules/0', {
        cookie,
        payload: { type: 'group', action: 'dbservers' },
      });
      expect(res.statusCode).toBe(200);
      expect(fakePve.firewallCalls).toStrictEqual([
        {
          method: 'PUT',
          path: '/api2/json/nodes/pve1/lxc/200/firewall/rules/0',
          body: { type: 'group', action: 'dbservers' },
        },
      ]);
    });
  });

  describe('DELETE rules/:pos', () => {
    it('sends the digest as a query parameter (pos travels in the path)', async () => {
      const cookie = await setupSession();
      fakePve.setVmPermissions(100, FW_PRIV);
      const res = await call('DELETE', `${RULE}?digest=abc123`, { cookie });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ ok: true });
      expect(fakePve.firewallCalls).toStrictEqual([
        { method: 'DELETE', path: '/api2/json/nodes/pve1/qemu/100/firewall/rules/2', body: { digest: 'abc123' } },
      ]);
    });

    it('sends no digest when none was given', async () => {
      const cookie = await setupSession();
      fakePve.setVmPermissions(100, FW_PRIV);
      const res = await call('DELETE', RULE, { cookie });
      expect(res.statusCode).toBe(200);
      expect(fakePve.firewallCalls[0]!.body).toStrictEqual({});
    });

    it('rejects a fractional or negative pos in the path without reaching PVE', async () => {
      const cookie = await setupSession();
      fakePve.setVmPermissions(100, FW_PRIV);
      expect((await call('DELETE', '/pve1/qemu/100/firewall/rules/1.5', { cookie })).statusCode).toBe(400);
      expect((await call('DELETE', '/pve1/qemu/100/firewall/rules/-1', { cookie })).statusCode).toBe(400);
      expect((await call('DELETE', '/pve1/qemu/100/firewall/rules/1000001', { cookie })).statusCode).toBe(400);
      expect(fakePve.firewallCalls).toHaveLength(0);
    });

    it('rejects a bad digest and an unknown query key without reaching PVE', async () => {
      const cookie = await setupSession();
      fakePve.setVmPermissions(100, FW_PRIV);
      expect((await call('DELETE', `${RULE}?digest=bad%20digest`, { cookie })).statusCode).toBe(400);
      expect((await call('DELETE', `${RULE}?force=1`, { cookie })).statusCode).toBe(400);
      expect((await call('DELETE', '/pve1/qemu/100/firewall/rules/abc', { cookie })).statusCode).toBe(400);
      expect(fakePve.firewallCalls).toHaveLength(0);
    });
  });

  describe('PUT options', () => {
    async function expect400(payload: unknown) {
      const cookie = await setupSession();
      fakePve.setVmPermissions(100, FW_PRIV);
      const res = await call('PUT', OPTIONS, { cookie, payload });
      expect(res.statusCode).toBe(400);
      expect(fakePve.firewallCalls).toHaveLength(0);
    }

    it('rejects an empty body, a digest-only body, an unknown option, a bad policy and a bad level', async () => {
      await expect400({});
      await expect400({ digest: 'abc123' });
      await expect400({ enable: true, policy_forward: 'DROP' });
      await expect400({ policy_in: 'ALLOW' });
      await expect400({ log_level_out: 'loud' });
      await expect400({ enable: 'yes' });
    });

    it('sends booleans as 1/0 and the policies and log levels as given', async () => {
      const cookie = await setupSession();
      fakePve.setVmPermissions(100, FW_PRIV);
      const res = await call('PUT', OPTIONS, {
        cookie,
        payload: {
          enable: true,
          dhcp: true,
          ndp: false,
          radv: false,
          macfilter: true,
          ipfilter: false,
          policy_in: 'DROP',
          policy_out: 'ACCEPT',
          log_level_in: 'info',
          log_level_out: 'nolog',
          digest: 'abc123',
        },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ ok: true });
      expect(fakePve.firewallCalls).toStrictEqual([
        {
          method: 'PUT',
          path: '/api2/json/nodes/pve1/qemu/100/firewall/options',
          body: {
            enable: '1',
            dhcp: '1',
            ndp: '0',
            radv: '0',
            macfilter: '1',
            ipfilter: '0',
            policy_in: 'DROP',
            policy_out: 'ACCEPT',
            log_level_in: 'info',
            log_level_out: 'nolog',
            digest: 'abc123',
          },
        },
      ]);
    });

    it('sends only the one option changed, on an lxc guest', async () => {
      const cookie = await setupSession();
      fakePve.setVmPermissions(200, FW_PRIV);
      const res = await call('PUT', '/pve1/lxc/200/firewall/options', { cookie, payload: { enable: false } });
      expect(res.statusCode).toBe(200);
      expect(fakePve.firewallCalls).toStrictEqual([
        { method: 'PUT', path: '/api2/json/nodes/pve1/lxc/200/firewall/options', body: { enable: '0' } },
      ]);
    });
  });

  describe('PVE errors', () => {
    it('relays a PVE 4xx as pve-rejected with the per-field detail', async () => {
      const cookie = await setupSession();
      fakePve.setVmPermissions(100, FW_PRIV);
      fakePve.setFirewallError('rules', {
        status: 400,
        message: 'Parameter verification failed.',
        errors: { source: 'invalid address' },
      });
      const res = await call('POST', RULES, { cookie, payload: { ...SSH_RULE, source: 'nope' } });
      expect(res.statusCode).toBe(400);
      expect(res.json()).toEqual({
        error: 'pve-rejected',
        message: 'Parameter verification failed. source: invalid address',
      });
    });

    it('maps a PVE 5xx to 502 pve-unreachable on every route', async () => {
      const cookie = await setupSession();
      fakePve.setVmPermissions(100, FW_PRIV);
      fakePve.setFirewallError('rules', { status: 500, message: 'internal error' });
      fakePve.setFirewallError('options', { status: 503, message: 'busy' });
      for (const res of [
        await call('POST', RULES, { cookie, payload: SSH_RULE }),
        await call('PUT', RULE, { cookie, payload: { enable: false } }),
        await call('DELETE', RULE, { cookie }),
        await call('PUT', OPTIONS, { cookie, payload: { enable: true } }),
      ]) {
        expect(res.statusCode).toBe(502);
        expect(res.json()).toEqual({ error: 'pve-unreachable' });
      }
    });

    it('relays a PVE 4xx (stale digest) on delete and options', async () => {
      const cookie = await setupSession();
      fakePve.setVmPermissions(100, FW_PRIV);
      fakePve.setFirewallError('rules', { status: 400, message: 'detected modified configuration - file changed by other user!' });
      fakePve.setFirewallError('options', { status: 400, message: 'detected modified configuration' });
      const del = await call('DELETE', `${RULE}?digest=abc123`, { cookie });
      expect(del.statusCode).toBe(400);
      expect(del.json().error).toBe('pve-rejected');
      const opts = await call('PUT', OPTIONS, { cookie, payload: { enable: true, digest: 'abc123' } });
      expect(opts.statusCode).toBe(400);
      expect(opts.json().error).toBe('pve-rejected');
    });
  });
});
