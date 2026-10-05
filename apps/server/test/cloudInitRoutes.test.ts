import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FastifyBaseLogger, FastifyInstance, InjectOptions } from 'fastify';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { composeCloudInitConfig } from '../src/actions/cloudInitRoutes.js';
import { startFakePve, type FakePve } from './helpers/fakePve.js';

const CI_PRIV = { 'VM.Config.Cloudinit': true };
const PASSWORD = 'Sup3r-S3cret-Pa55word!';

const KEY_ED = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl admin@lab';
const KEY_RSA = 'ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAABAQC7+/abc= ops@host';

describe('guest cloud-init routes (T54)', () => {
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

  function call(method: 'PATCH' | 'POST', path: string, options: { cookie?: string; payload?: unknown } = {}) {
    const injectOptions: InjectOptions = { method, url: `/api/actions/guest${path}` };
    if (options.cookie !== undefined) injectOptions.headers = { cookie: options.cookie };
    if (options.payload !== undefined) injectOptions.payload = options.payload as NonNullable<InjectOptions['payload']>;
    return app.inject(injectOptions);
  }

  const PATCH_URL = '/pve1/qemu/100/cloud-init';
  const REGEN_URL = '/pve1/qemu/100/cloud-init/regenerate';

  /** A session with the privilege and a config that has two NICs, ready for a PATCH. */
  async function setupReady(): Promise<string> {
    const cookie = await setupSession();
    fakePve.setVmPermissions(100, CI_PRIV);
    fakePve.setGuestConfig('qemu', 100, {
      net0: 'virtio=BC:24:11:64:00:01,bridge=vmbr0',
      net1: 'virtio=BC:24:11:64:00:02,bridge=vmbr1',
    });
    return cookie;
  }

  describe('token mode', () => {
    it('PATCH and regenerate 403 without any PVE call', async () => {
      await setupTokenMode();
      const patch = await call('PATCH', PATCH_URL, { payload: { user: 'debian' } });
      expect(patch.statusCode).toBe(403);
      expect(patch.json()).toEqual({ error: 'writes-disabled-in-token-mode' });
      const regen = await call('POST', REGEN_URL);
      expect(regen.statusCode).toBe(403);
      expect(regen.json()).toEqual({ error: 'writes-disabled-in-token-mode' });
      expect(fakePve.configCalls).toHaveLength(0);
      expect(fakePve.cloudInitRegenerateCalls).toHaveLength(0);
    });
  });

  describe('authentication, applicability and privilege', () => {
    it('401s without a session (PATCH and regenerate)', async () => {
      await setupSession();
      expect((await call('PATCH', PATCH_URL, { payload: { user: 'debian' } })).statusCode).toBe(401);
      expect((await call('POST', REGEN_URL)).statusCode).toBe(401);
    });

    it('400 not-applicable for an lxc guest, before any PVE call', async () => {
      const cookie = await setupSession();
      fakePve.setVmPermissions(200, CI_PRIV);
      const patch = await call('PATCH', '/pve1/lxc/200/cloud-init', { cookie, payload: { user: 'debian' } });
      expect(patch.statusCode).toBe(400);
      expect(patch.json()).toMatchObject({ error: 'not-applicable' });
      const regen = await call('POST', '/pve1/lxc/200/cloud-init/regenerate', { cookie });
      expect(regen.statusCode).toBe(400);
      expect(regen.json()).toMatchObject({ error: 'not-applicable' });
      expect(fakePve.configCalls).toHaveLength(0);
      expect(fakePve.cloudInitRegenerateCalls).toHaveLength(0);
    });

    it('400 for a bad vmid', async () => {
      const cookie = await setupSession();
      const res = await call('PATCH', '/pve1/qemu/abc/cloud-init', { cookie, payload: { user: 'debian' } });
      expect(res.statusCode).toBe(400);
    });

    it('403 naming VM.Config.Cloudinit for PATCH and regenerate, without any PVE write', async () => {
      const cookie = await setupSession();
      fakePve.setVmPermissions(100, { 'VM.Config.Network': true, 'VM.Config.Cloudinit': false });
      const patch = await call('PATCH', PATCH_URL, { cookie, payload: { user: 'debian' } });
      expect(patch.statusCode).toBe(403);
      expect(patch.json()).toEqual({ error: 'forbidden', missing: 'VM.Config.Cloudinit' });
      const regen = await call('POST', REGEN_URL, { cookie });
      expect(regen.statusCode).toBe(403);
      expect(regen.json()).toEqual({ error: 'forbidden', missing: 'VM.Config.Cloudinit' });
      expect(fakePve.configCalls).toHaveLength(0);
      expect(fakePve.cloudInitRegenerateCalls).toHaveLength(0);
    });
  });

  describe('body validation (400)', () => {
    async function expect400(payload: unknown) {
      const cookie = await setupReady();
      const res = await call('PATCH', PATCH_URL, { cookie, payload });
      expect(res.statusCode).toBe(400);
      expect(fakePve.configCalls).toHaveLength(0);
      return res;
    }

    it('rejects an empty body and an unknown key', async () => {
      await expect400({});
      await expect400({ user: 'debian', extra: 1 });
    });

    it('rejects a bad user (uppercase, leading digit, injection, too long)', async () => {
      await expect400({ user: 'Debian' });
      await expect400({ user: '1debian' });
      await expect400({ user: 'debian,cipassword=x' });
      await expect400({ user: 'a'.repeat(65) });
    });

    it('rejects an empty or oversized password', async () => {
      await expect400({ password: '' });
      await expect400({ password: 'x'.repeat(257) });
    });

    it('rejects an ssh key that is not an OpenSSH public key line', async () => {
      await expect400({ sshKeys: ['not a key'] });
      await expect400({ sshKeys: ['ssh-ed25519 AAAA\nssh-rsa BBBB'] });
      await expect400({ sshKeys: ['ssh-foo AAAA'] });
    });

    it('rejects more than three nameservers and a non-IP nameserver', async () => {
      await expect400({ nameserver: ['1.1.1.1', '8.8.8.8', '9.9.9.9', '8.8.4.4'] });
      await expect400({ nameserver: ['dns.example.com'] });
    });

    it('rejects a bad searchdomain, upgrade type and citype', async () => {
      await expect400({ searchdomain: 'bad domain' });
      await expect400({ searchdomain: '-bad.example.com' });
      await expect400({ upgrade: 'yes' });
      await expect400({ type: 'cloudbase' });
    });

    it('rejects a bad ipconfig key and bad address forms', async () => {
      await expect400({ ipconfig: { eth0: { ip: 'dhcp' } } });
      await expect400({ ipconfig: { net32: { ip: 'dhcp' } } });
      await expect400({ ipconfig: { net0: { ip: '10.0.0.5' } } });
      await expect400({ ipconfig: { net0: { ip: '10.0.0.5/33' } } });
      await expect400({ ipconfig: { net0: { ip6: 'maybe' } } });
      await expect400({ ipconfig: { net0: {} } });
    });

    it('rejects a gateway without a static address of its own family', async () => {
      const dhcp = await expect400({ ipconfig: { net0: { ip: 'dhcp', gw: '10.0.0.1' } } });
      expect(dhcp.json()).toMatchObject({ error: 'Invalid request body', message: 'net0: gw needs a static ip (CIDR)' });
      const none = await expect400({ ipconfig: { net0: { gw: '10.0.0.1' } } });
      expect(none.json()).toMatchObject({ message: 'net0: gw needs a static ip (CIDR)' });
      const v6 = await expect400({ ipconfig: { net0: { ip6: 'auto', gw6: 'fe80::1' } } });
      expect(v6.json()).toMatchObject({ message: 'net0: gw6 needs a static ip6 (CIDR)' });
    });

    it('400 unknown-device for an ipconfig on a NIC the guest does not have', async () => {
      const cookie = await setupReady();
      const res = await call('PATCH', PATCH_URL, { cookie, payload: { ipconfig: { net9: { ip: 'dhcp' } } } });
      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({ error: 'unknown-device' });
      expect(fakePve.configCalls).toHaveLength(0);
    });
  });

  describe('composition (what PVE receives)', () => {
    async function patchOk(payload: unknown) {
      const cookie = await setupReady();
      const res = await call('PATCH', PATCH_URL, { cookie, payload });
      expect(res.statusCode).toBe(200);
      expect(fakePve.configCalls).toHaveLength(1);
      return { res, body: fakePve.configCalls[0]!.body };
    }

    it('user -> ciuser', async () => {
      const { res, body } = await patchOk({ user: 'debian' });
      expect(body).toStrictEqual({ ciuser: 'debian' });
      expect(res.json()).toEqual({ ok: true, pending: [] });
      expect(fakePve.configCalls[0]!.path).toBe('/api2/json/nodes/pve1/qemu/100/config');
    });

    it('password -> cipassword (for PVE to hash), never echoed', async () => {
      const { res, body } = await patchOk({ password: PASSWORD });
      expect(body).toStrictEqual({ cipassword: PASSWORD });
      expect(res.body).not.toContain(PASSWORD);
    });

    it('sshKeys -> sshkeys: two keys joined with a newline and URL-encoded', async () => {
      const { body } = await patchOk({ sshKeys: [KEY_ED, KEY_RSA] });
      expect(body).toStrictEqual({ sshkeys: encodeURIComponent(`${KEY_ED}\n${KEY_RSA}`) });
      expect(body.sshkeys).toContain('%0A');
      expect(body.sshkeys).toContain('%2B%2F');
      expect(decodeURIComponent(body.sshkeys!).split('\n')).toStrictEqual([KEY_ED, KEY_RSA]);
    });

    it('nameserver -> a space-joined list; searchdomain; upgrade -> ciupgrade 1/0; type -> citype', async () => {
      const { body } = await patchOk({
        nameserver: ['1.1.1.1', '2606:4700:4700::1111'],
        searchdomain: 'lab.example.com',
        upgrade: true,
        type: 'configdrive2',
      });
      expect(body).toStrictEqual({
        nameserver: '1.1.1.1 2606:4700:4700::1111',
        searchdomain: 'lab.example.com',
        ciupgrade: '1',
        citype: 'configdrive2',
      });
    });

    it('upgrade false -> ciupgrade 0', async () => {
      const { body } = await patchOk({ upgrade: false });
      expect(body).toStrictEqual({ ciupgrade: '0' });
    });

    it('ipconfig static + gateway -> ipconfig0 ip=...,gw=...', async () => {
      const { body } = await patchOk({ ipconfig: { net0: { ip: '10.0.0.5/24', gw: '10.0.0.1' } } });
      expect(body).toStrictEqual({ ipconfig0: 'ip=10.0.0.5/24,gw=10.0.0.1' });
    });

    it('ipconfig dhcp + ip6 auto -> ipconfig0 ip=dhcp,ip6=auto; two NICs in one call', async () => {
      const { body } = await patchOk({
        ipconfig: {
          net0: { ip: 'dhcp', ip6: 'auto' },
          net1: { ip: '192.168.5.9/24', gw: '192.168.5.1', ip6: '2001:db8::5/64', gw6: '2001:db8::1' },
        },
      });
      expect(body).toStrictEqual({
        ipconfig0: 'ip=dhcp,ip6=auto',
        ipconfig1: 'ip=192.168.5.9/24,gw=192.168.5.1,ip6=2001:db8::5/64,gw6=2001:db8::1',
      });
    });
  });

  describe('delete forms', () => {
    it('null user/password/searchdomain/type and empty sshKeys/nameserver -> one delete list', async () => {
      const cookie = await setupReady();
      const res = await call('PATCH', PATCH_URL, {
        cookie,
        payload: { user: null, password: null, sshKeys: [], nameserver: [], searchdomain: null, type: null },
      });
      expect(res.statusCode).toBe(200);
      expect(fakePve.configCalls[0]!.body).toStrictEqual({
        delete: 'ciuser,cipassword,sshkeys,nameserver,searchdomain,citype',
      });
    });

    it('a null ipconfig deletes ipconfig<n>, even for a NIC the guest no longer has', async () => {
      const cookie = await setupReady();
      const res = await call('PATCH', PATCH_URL, { cookie, payload: { ipconfig: { net1: null, net9: null } } });
      expect(res.statusCode).toBe(200);
      expect(fakePve.configCalls[0]!.body).toStrictEqual({ delete: 'ipconfig1,ipconfig9' });
    });

    it('a set and a delete travel together in one PUT', async () => {
      const cookie = await setupReady();
      const res = await call('PATCH', PATCH_URL, { cookie, payload: { user: 'admin', searchdomain: null } });
      expect(res.statusCode).toBe(200);
      expect(fakePve.configCalls).toHaveLength(1);
      expect(fakePve.configCalls[0]!.body).toStrictEqual({ ciuser: 'admin', delete: 'searchdomain' });
    });

    it('composeCloudInitConfig is pure: the same body maps to the same change', () => {
      expect(composeCloudInitConfig({ user: null, upgrade: true })).toStrictEqual({
        set: { ciupgrade: '1' },
        remove: ['ciuser'],
      });
    });
  });

  describe('pending report', () => {
    it('lists the keys PVE reports with a pending value or delete, and no values', async () => {
      const cookie = await setupReady();
      fakePve.setCloudInitRows(100, [
        { key: 'ciuser', value: 'old', pending: 'debian' },
        { key: 'sshkeys', value: 'x', delete: 1 },
        { key: 'nameserver', value: '1.1.1.1' },
        { key: 'cipassword', value: '********' },
      ]);
      const res = await call('PATCH', PATCH_URL, { cookie, payload: { user: 'debian' } });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ ok: true, pending: ['ciuser', 'sshkeys'] });
    });

    it('a failing pending read does not fail the applied change', async () => {
      const cookie = await setupReady();
      fakePve.setCloudInitReadError(100, 500);
      const res = await call('PATCH', PATCH_URL, { cookie, payload: { user: 'debian' } });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ ok: true, pending: [] });
    });
  });

  describe('PVE failures', () => {
    it('relays a PVE 4xx as pve-rejected with the sanitized message', async () => {
      const cookie = await setupReady();
      fakePve.setConfigError('qemu', 100, 400, 'Parameter verification failed.', { ciuser: 'invalid format' });
      const res = await call('PATCH', PATCH_URL, { cookie, payload: { user: 'debian' } });
      expect(res.statusCode).toBe(400);
      expect(res.json()).toEqual({
        error: 'pve-rejected',
        message: 'Parameter verification failed. ciuser: invalid format',
      });
    });

    it('maps a PVE 5xx to 502 pve-unreachable', async () => {
      const cookie = await setupReady();
      fakePve.setConfigError('qemu', 100, 500, 'boom');
      const res = await call('PATCH', PATCH_URL, { cookie, payload: { user: 'debian' } });
      expect(res.statusCode).toBe(502);
      expect(res.json()).toEqual({ error: 'pve-unreachable' });
    });
  });

  describe('regenerate', () => {
    it('PUTs the cloudinit endpoint and answers { ok: true }', async () => {
      const cookie = await setupReady();
      const res = await call('POST', REGEN_URL, { cookie });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ ok: true });
      expect(fakePve.cloudInitRegenerateCalls).toStrictEqual([{ vmid: 100, body: {} }]);
      // It regenerates the drive only; it never touches the config.
      expect(fakePve.configCalls).toHaveLength(0);
    });

    it('relays a PVE 4xx and maps a 5xx', async () => {
      const cookie = await setupReady();
      fakePve.setCloudInitRegenerateError(100, 400, 'no cloudinit drive found');
      const rejected = await call('POST', REGEN_URL, { cookie });
      expect(rejected.statusCode).toBe(400);
      expect(rejected.json()).toEqual({ error: 'pve-rejected', message: 'no cloudinit drive found' });
      fakePve.setCloudInitRegenerateError(100, 500, 'boom');
      const down = await call('POST', REGEN_URL, { cookie });
      expect(down.statusCode).toBe(502);
      expect(down.json()).toEqual({ error: 'pve-unreachable' });
    });
  });

  describe('the password never reaches the logger', () => {
    /**
     * Mechanism: the app's logger is `silent` under NODE_ENV=test, so its output cannot be read
     * back. Instead every level method (trace..fatal) of the root logger AND of every child logger
     * Fastify creates per request (`req.log`, which is what `app.log`/`req.log` calls in the route
     * resolve to) is spied on, recording the arguments each call was handed -- silent level or not,
     * the arguments are what a real logger would serialize. Each recorded object is first run
     * through the logger's own pino serializers (`req`, `res`, `err`), so what is asserted on is
     * what pino would actually write -- Fastify's own "incoming request" line hands pino the raw
     * request, whose serializer keeps only method/url/host/remote address, never the body. The
     * test then asserts the password appears in none of them, and that the route's own "saved"
     * line was observed (so the spy provably sees this route's log calls).
     */
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

    it('control: the capture does see a leak when a log call is handed the password', async () => {
      await setupReady();
      const calls = captureLogCalls();
      app.log.info({ body: { password: PASSWORD } }, 'deliberate leak');
      expect(calls.some((args) => JSON.stringify(args).includes(PASSWORD))).toBe(true);
    });

    it('a successful save logs the changed field names only', async () => {
      const cookie = await setupReady();
      const calls = captureLogCalls();
      const res = await call('PATCH', PATCH_URL, { cookie, payload: { user: 'debian', password: PASSWORD } });
      expect(res.statusCode).toBe(200);
      expect(res.body).not.toContain(PASSWORD);
      expect(fakePve.configCalls[0]!.body).toMatchObject({ cipassword: PASSWORD });

      const saved = calls.find((args) => args[1] === 'Guest cloud-init settings saved');
      expect(saved).toBeDefined();
      expect(saved![0]).toMatchObject({ fields: ['user', 'password'] });
      for (const args of calls) {
        expect(JSON.stringify(args)).not.toContain(PASSWORD);
      }
    });

    it('a PVE failure (4xx and 5xx), a failed pending read and a 400 never log or return it either', async () => {
      const cookie = await setupReady();
      const calls = captureLogCalls();

      fakePve.setConfigError('qemu', 100, 500, 'boom');
      const down = await call('PATCH', PATCH_URL, { cookie, payload: { password: PASSWORD } });
      expect(down.statusCode).toBe(502);
      expect(down.body).not.toContain(PASSWORD);

      fakePve.setConfigError('qemu', 100, 400, 'Parameter verification failed.');
      const rejected = await call('PATCH', PATCH_URL, { cookie, payload: { password: PASSWORD } });
      expect(rejected.statusCode).toBe(400);
      expect(rejected.body).not.toContain(PASSWORD);

      const invalid = await call('PATCH', PATCH_URL, { cookie, payload: { password: PASSWORD, user: 'NOT valid' } });
      expect(invalid.statusCode).toBe(400);
      expect(invalid.body).not.toContain(PASSWORD);

      expect(calls.length).toBeGreaterThan(0);
      for (const args of calls) {
        expect(JSON.stringify(args)).not.toContain(PASSWORD);
      }
    });

    it('the route is never handed the request body to log', async () => {
      const cookie = await setupReady();
      const calls = captureLogCalls();
      await call('PATCH', PATCH_URL, { cookie, payload: { user: 'debian', password: PASSWORD, sshKeys: [KEY_ED] } });
      expect(calls.length).toBeGreaterThan(0);
      for (const args of calls) {
        const serialized = JSON.stringify(args);
        expect(serialized).not.toContain(PASSWORD);
        expect(serialized).not.toContain(KEY_ED);
      }
    });
  });
});
