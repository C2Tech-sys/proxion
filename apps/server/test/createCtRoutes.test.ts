import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FastifyBaseLogger, FastifyInstance, InjectOptions } from 'fastify';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { composeCreateCtParams } from '../src/actions/createCtRoutes.js';
import { startFakePve, type FakePve } from './helpers/fakePve.js';

// Test-only literal: it exists to prove the password never reaches a log line or a response.
const PASSWORD = 'Sup3r-S3cret-Pa55word!';
const KEY_ED = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl admin@lab';
const KEY_RSA = 'ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAABAQC7+/abc= ops@host';
const TEMPLATE = 'local:vztmpl/debian-12-standard_12.7-1_amd64.tar.zst';
const URL = '/pve1/lxc/create';
const VMID = 150;

type Payload = Record<string, unknown>;

/** A complete, valid body (DHCP NIC, root password); each test overrides what it exercises. */
function payload(over: Payload = {}): Payload {
  return {
    vmid: VMID,
    hostname: 'web01',
    password: PASSWORD,
    template: { storage: 'local', volid: TEMPLATE },
    rootfs: { storage: 'local-lvm', sizeGiB: 8 },
    cpu: { cores: 1 },
    memory: { memoryMiB: 512, swapMiB: 512 },
    net: { bridge: 'vmbr0', ip: 'dhcp' },
    ...over,
  };
}

describe('create container route (T62)', () => {
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

  /** A session holding VM.Allocate on the new id and Datastore.AllocateSpace on `local-lvm`. */
  async function setupReady(): Promise<string> {
    const cookie = await setupSession();
    fakePve.setVmPermissions(VMID, { 'VM.Allocate': true });
    fakePve.setStoragePermissions('local-lvm', { 'Datastore.AllocateSpace': true });
    return cookie;
  }

  function create(options: { cookie?: string; payload?: unknown; url?: string } = {}) {
    const injectOptions: InjectOptions = { method: 'POST', url: `/api/actions/guest${options.url ?? URL}` };
    if (options.cookie !== undefined) injectOptions.headers = { cookie: options.cookie };
    if (options.payload !== undefined) injectOptions.payload = options.payload as NonNullable<InjectOptions['payload']>;
    return app.inject(injectOptions);
  }

  /** POSTs `body` expecting a 202 and returns what PVE received. */
  async function createOk(body: Payload) {
    const cookie = await setupReady();
    const res = await create({ cookie, payload: body });
    expect(res.statusCode).toBe(202);
    expect(fakePve.createCalls).toHaveLength(1);
    return { res, pve: fakePve.createCalls[0]! };
  }

  describe('token mode, authentication and privileges', () => {
    it('403 writes-disabled-in-token-mode, with no PVE call', async () => {
      await setupTokenMode();
      const res = await create({ payload: payload() });
      expect(res.statusCode).toBe(403);
      expect(res.json()).toEqual({ error: 'writes-disabled-in-token-mode' });
      expect(fakePve.createCalls).toHaveLength(0);
    });

    it('401s without a session', async () => {
      await setupSession();
      const res = await create({ payload: payload() });
      expect(res.statusCode).toBe(401);
      expect(fakePve.createCalls).toHaveLength(0);
    });

    it('400 for a node that is not a node name', async () => {
      const cookie = await setupReady();
      const res = await create({ cookie, url: '/bad_node!/lxc/create', payload: payload() });
      expect(res.statusCode).toBe(400);
      expect(fakePve.createCalls).toHaveLength(0);
    });

    it('403 naming VM.Allocate, without any PVE write', async () => {
      const cookie = await setupSession();
      fakePve.setVmPermissions(VMID, { 'VM.Allocate': false });
      fakePve.setStoragePermissions('local-lvm', { 'Datastore.AllocateSpace': true });
      const res = await create({ cookie, payload: payload() });
      expect(res.statusCode).toBe(403);
      expect(res.json()).toEqual({ error: 'forbidden', missing: 'VM.Allocate' });
      expect(fakePve.createCalls).toHaveLength(0);
    });

    it('403 naming Datastore.AllocateSpace on the root disk storage, without any PVE write', async () => {
      const cookie = await setupSession();
      fakePve.setVmPermissions(VMID, { 'VM.Allocate': true });
      fakePve.setStoragePermissions('local-lvm', { 'Datastore.Audit': true });
      const res = await create({ cookie, payload: payload() });
      expect(res.statusCode).toBe(403);
      expect(res.json()).toEqual({ error: 'forbidden', missing: 'Datastore.AllocateSpace' });
      expect(fakePve.createCalls).toHaveLength(0);
    });

    it('does not require anything on the template storage (PVE enforces that itself)', async () => {
      const { res } = await createOk(payload());
      expect(res.statusCode).toBe(202);
    });

    it('409 vmid-taken when the cluster already lists the id, without a PVE write', async () => {
      const cookie = await setupReady();
      fakePve.setExistingGuest(VMID, 'stopped');
      const res = await create({ cookie, payload: payload() });
      expect(res.statusCode).toBe(409);
      expect(res.json()).toMatchObject({ error: 'vmid-taken' });
      expect(fakePve.createCalls).toHaveLength(0);
    });
  });

  describe('body validation (400)', () => {
    /** Every payload is rejected with a 400 and never reaches PVE; the response never echoes it. */
    async function expectAll400(...bodies: unknown[]) {
      const cookie = await setupReady();
      for (const body of bodies) {
        const res = await create({ cookie, payload: body });
        expect(res.statusCode, JSON.stringify(body)).toBe(400);
        expect(res.body).not.toContain(PASSWORD);
      }
      expect(fakePve.createCalls).toHaveLength(0);
    }

    it('rejects an empty body and an unknown key', async () => {
      await expectAll400({}, payload({ extra: 1 }), payload({ cpu: { cores: 1, sockets: 2 } }));
    });

    it('rejects a bad vmid', async () => {
      await expectAll400(payload({ vmid: 99 }), payload({ vmid: 1000000000 }), payload({ vmid: 150.5 }), payload({ vmid: '150' }));
    });

    it('rejects a bad hostname', async () => {
      await expectAll400(
        payload({ hostname: '' }),
        payload({ hostname: '-bad' }),
        payload({ hostname: 'has space' }),
        payload({ hostname: 'a,rootfs=x' }),
        payload({ hostname: `${'a'.repeat(64)}.example.com` }),
      );
    });

    it('rejects a password under 5 or over 256 characters', async () => {
      await expectAll400(payload({ password: '1234' }), payload({ password: 'x'.repeat(257) }));
    });

    it('requires a password or at least one SSH key', async () => {
      const cookie = await setupReady();
      for (const body of [payload({ password: undefined }), payload({ password: undefined, sshKeys: [] })]) {
        const res = await create({ cookie, payload: body });
        expect(res.statusCode).toBe(400);
        expect(res.json()).toMatchObject({ message: 'A root password or an SSH public key is required' });
      }
      expect(fakePve.createCalls).toHaveLength(0);
    });

    it('rejects an SSH key that is not an OpenSSH public key line', async () => {
      await expectAll400(
        payload({ sshKeys: ['not a key'] }),
        payload({ sshKeys: ['ssh-ed25519 AAAA\nssh-rsa BBBB'] }),
        payload({ sshKeys: ['ssh-foo AAAA'] }),
      );
    });

    it('rejects a template that is not on the named storage or not a plain file name', async () => {
      await expectAll400(
        payload({ template: { storage: 'local', volid: 'other:vztmpl/debian.tar.zst' } }),
        payload({ template: { storage: 'local', volid: 'local:iso/debian.iso' } }),
        payload({ template: { storage: 'local', volid: 'local:vztmpl/../../etc/passwd' } }),
        payload({ template: { storage: 'local', volid: 'local:vztmpl/' } }),
        payload({ template: { storage: 'bad storage', volid: 'bad storage:vztmpl/x.tar.zst' } }),
      );
    });

    it('rejects a bad root disk', async () => {
      await expectAll400(
        payload({ rootfs: { storage: 'local-lvm', sizeGiB: 0 } }),
        payload({ rootfs: { storage: 'local-lvm', sizeGiB: 65537 } }),
        payload({ rootfs: { storage: 'local-lvm', sizeGiB: 1.5 } }),
        payload({ rootfs: { storage: 'local-lvm,size=1', sizeGiB: 8 } }),
        payload({ rootfs: { storage: 'local-lvm', sizeGiB: 8, mountoptions: 'noatime' } }),
      );
    });

    it('rejects out-of-range CPU and memory', async () => {
      await expectAll400(
        payload({ cpu: { cores: 0 } }),
        payload({ cpu: { cores: 129 } }),
        payload({ cpu: { cores: 1, cpulimit: 129 } }),
        payload({ cpu: { cores: 1, cpuunits: 100001 } }),
        payload({ memory: { memoryMiB: 15, swapMiB: 0 } }),
        payload({ memory: { memoryMiB: 512, swapMiB: -1 } }),
        payload({ memory: { memoryMiB: 4194305, swapMiB: 0 } }),
      );
    });

    it('rejects a net that is missing (it must be an object or an explicit null)', async () => {
      await expectAll400(payload({ net: undefined }));
    });

    it('rejects bad NIC fields', async () => {
      await expectAll400(
        payload({ net: { bridge: 'vmbr0,firewall=0' } }),
        payload({ net: { bridge: 'vmbr0', name: 'wlan0' } }),
        payload({ net: { bridge: 'vmbr0', ip: '10.0.0.5' } }),
        payload({ net: { bridge: 'vmbr0', ip: '10.0.0.5/33' } }),
        payload({ net: { bridge: 'vmbr0', ip6: 'maybe' } }),
        payload({ net: { bridge: 'vmbr0', tag: 4095 } }),
        payload({ net: { bridge: 'vmbr0', mtu: 63 } }),
        payload({ net: { bridge: 'vmbr0', hwaddr: '01:00:5E:00:00:01' } }),
        payload({ net: { bridge: 'vmbr0', hwaddr: 'nope' } }),
        payload({ net: { bridge: 'vmbr0', rate: 10 } }),
      );
    });

    it('400 for a gateway without a static address of its own family', async () => {
      const cookie = await setupReady();
      const dhcp = await create({ cookie, payload: payload({ net: { bridge: 'vmbr0', ip: 'dhcp', gw: '10.0.0.1' } }) });
      expect(dhcp.statusCode).toBe(400);
      expect(dhcp.json()).toMatchObject({ message: 'gw needs a static ip (CIDR)' });
      const none = await create({ cookie, payload: payload({ net: { bridge: 'vmbr0', gw: '10.0.0.1' } }) });
      expect(none.json()).toMatchObject({ message: 'gw needs a static ip (CIDR)' });
      const v6 = await create({ cookie, payload: payload({ net: { bridge: 'vmbr0', ip6: 'auto', gw6: 'fe80::1' } }) });
      expect(v6.statusCode).toBe(400);
      expect(v6.json()).toMatchObject({ message: 'gw6 needs a static ip6 (CIDR)' });
      expect(fakePve.createCalls).toHaveLength(0);
    });

    it('rejects bad DNS settings, pool and tags', async () => {
      await expectAll400(
        payload({ dns: { nameserver: ['1.1.1.1', '8.8.8.8', '9.9.9.9', '8.8.4.4'] } }),
        payload({ dns: { nameserver: ['dns.example.com'] } }),
        payload({ dns: { searchdomain: 'bad domain' } }),
        payload({ pool: 'bad pool' }),
        payload({ tags: ['bad tag'] }),
        payload({ tags: ['a;b'] }),
        payload({ start: 'yes' }),
      );
    });
  });

  describe('composition (what PVE receives)', () => {
    it('(a) debian template, 8 GiB on local-lvm, DHCP NIC, nesting, unprivileged', async () => {
      const { res, pve } = await createOk(payload());
      expect(pve.type).toBe('lxc');
      expect(pve.body).toStrictEqual({
        vmid: '150',
        hostname: 'web01',
        ostemplate: TEMPLATE,
        password: PASSWORD,
        unprivileged: '1',
        features: 'nesting=1',
        rootfs: 'local-lvm:8',
        cores: '1',
        memory: '512',
        swap: '512',
        net0: 'name=eth0,bridge=vmbr0,ip=dhcp,firewall=1',
        start: '0',
      });
      expect(res.json()).toEqual({
        upid: `UPID:fakepve:00000001:00000000:00000000:vzrestore:${VMID}:root@pam:`,
        vmid: VMID,
      });
    });

    it('(b) static IPv4 + gateway, nameserver + searchdomain, no swap', async () => {
      const { pve } = await createOk(
        payload({
          net: { bridge: 'vmbr1', ip: '10.0.0.5/24', gw: '10.0.0.1' },
          dns: { nameserver: ['1.1.1.1', '2606:4700:4700::1111'], searchdomain: 'lab.example.com' },
          memory: { memoryMiB: 1024, swapMiB: 0 },
        }),
      );
      expect(pve.body).toStrictEqual({
        vmid: '150',
        hostname: 'web01',
        ostemplate: TEMPLATE,
        password: PASSWORD,
        unprivileged: '1',
        features: 'nesting=1',
        rootfs: 'local-lvm:8',
        cores: '1',
        memory: '1024',
        swap: '0',
        net0: 'name=eth0,bridge=vmbr1,ip=10.0.0.5/24,gw=10.0.0.1,firewall=1',
        nameserver: '1.1.1.1 2606:4700:4700::1111',
        searchdomain: 'lab.example.com',
        start: '0',
      });
    });

    it('(c) no NIC: net is null and no net0 is sent', async () => {
      const { pve } = await createOk(payload({ net: null }));
      expect(pve.body).not.toHaveProperty('net0');
      expect(Object.keys(pve.body).filter((k) => k.startsWith('net'))).toStrictEqual([]);
    });

    it('SSH keys: joined with a newline and NOT URL-encoded; works without a password', async () => {
      const { pve } = await createOk(payload({ password: undefined, sshKeys: [KEY_ED, KEY_RSA] }));
      expect(pve.body['ssh-public-keys']).toBe(`${KEY_ED}\n${KEY_RSA}`);
      expect(pve.body['ssh-public-keys']).not.toContain('%0A');
      expect(pve.body).not.toHaveProperty('password');
    });

    it('a password and SSH keys travel together', async () => {
      const { pve } = await createOk(payload({ sshKeys: [KEY_ED] }));
      expect(pve.body).toMatchObject({ password: PASSWORD, 'ssh-public-keys': KEY_ED });
    });

    it('rootfs ACL and quota flags', async () => {
      const { pve } = await createOk(payload({ rootfs: { storage: 'local-lvm', sizeGiB: 32, acl: true, quota: true } }));
      expect(pve.body.rootfs).toBe('local-lvm:32,acl=1,quota=1');
    });

    it('false ACL/quota flags add nothing', async () => {
      const { pve } = await createOk(payload({ rootfs: { storage: 'local-lvm', sizeGiB: 4, acl: false, quota: false } }));
      expect(pve.body.rootfs).toBe('local-lvm:4');
    });

    it('cpulimit and cpuunits are sent only when given', async () => {
      const { pve } = await createOk(payload({ cpu: { cores: 4, cpulimit: 1.5, cpuunits: 2048 } }));
      expect(pve.body).toMatchObject({ cores: '4', cpulimit: '1.5', cpuunits: '2048' });
    });

    it('privileged container without nesting: unprivileged 0 and no features key', async () => {
      const { pve } = await createOk(payload({ unprivileged: false, nesting: false }));
      expect(pve.body.unprivileged).toBe('0');
      expect(pve.body).not.toHaveProperty('features');
    });

    it('pool, tags (semicolon-joined) and start after create', async () => {
      const { pve } = await createOk(payload({ pool: 'lab', tags: ['prod', 'web'], start: true }));
      expect(pve.body).toMatchObject({ pool: 'lab', tags: 'prod;web', start: '1' });
    });

    it('every NIC option: VLAN, firewall off, MAC, MTU, static IPv6 + gateway, custom name', async () => {
      const { pve } = await createOk(
        payload({
          net: {
            name: 'eth1',
            bridge: 'vmbr0',
            ip: 'manual',
            ip6: '2001:db8::5/64',
            gw6: '2001:db8::1',
            tag: 20,
            firewall: false,
            hwaddr: 'BC:24:11:AA:BB:CC',
            mtu: 1400,
          },
        }),
      );
      expect(pve.body.net0).toBe(
        'name=eth1,bridge=vmbr0,hwaddr=BC:24:11:AA:BB:CC,ip=manual,ip6=2001:db8::5/64,gw6=2001:db8::1,tag=20,firewall=0,mtu=1400',
      );
    });

    it('SLAAC IPv6 and an empty or absent dns block leave the container to inherit the host resolver', async () => {
      const { pve } = await createOk(payload({ net: { bridge: 'vmbr0', ip: 'dhcp', ip6: 'auto' }, dns: { nameserver: [] } }));
      expect(pve.body.net0).toBe('name=eth0,bridge=vmbr0,ip=dhcp,ip6=auto,firewall=1');
      expect(pve.body).not.toHaveProperty('nameserver');
      expect(pve.body).not.toHaveProperty('searchdomain');
    });

    it('never sends ostype (PVE detects it from the template)', async () => {
      const { pve } = await createOk(payload());
      expect(pve.body).not.toHaveProperty('ostype');
    });

    it('composeCreateCtParams is pure: the same body maps to the same parameters', () => {
      const body = {
        vmid: 123,
        hostname: 'x',
        start: false,
        unprivileged: true,
        nesting: false,
        password: 'abcde',
        template: { storage: 'local', volid: TEMPLATE },
        rootfs: { storage: 'local-lvm', sizeGiB: 2 },
        cpu: { cores: 2 },
        memory: { memoryMiB: 256, swapMiB: 0 },
        net: null,
      };
      expect(composeCreateCtParams(body)).toStrictEqual({
        vmid: 123,
        hostname: 'x',
        ostemplate: TEMPLATE,
        password: 'abcde',
        unprivileged: true,
        rootfs: 'local-lvm:2',
        cores: 2,
        memory: 256,
        swap: 0,
        start: false,
      });
    });
  });

  describe('PVE failures', () => {
    it('relays a PVE 4xx as pve-rejected with the sanitized message', async () => {
      const cookie = await setupReady();
      fakePve.setCreateError('lxc', VMID, 400, 'Parameter verification failed.', { ostemplate: 'no such template' });
      const res = await create({ cookie, payload: payload() });
      expect(res.statusCode).toBe(400);
      expect(res.json()).toEqual({
        error: 'pve-rejected',
        message: 'Parameter verification failed. ostemplate: no such template',
      });
    });

    it("relays PVE's own 403 for a template storage the caller cannot read", async () => {
      const cookie = await setupReady();
      fakePve.setCreateError('lxc', VMID, 403, 'Permission check failed (/storage/local, Datastore.Audit)');
      const res = await create({ cookie, payload: payload() });
      expect(res.statusCode).toBe(403);
      expect(res.json()).toEqual({
        error: 'pve-rejected',
        message: 'Permission check failed (/storage/local, Datastore.Audit)',
      });
    });

    it('maps a PVE 5xx to 502 pve-unreachable', async () => {
      const cookie = await setupReady();
      fakePve.setCreateError('lxc', VMID, 500, 'boom');
      const res = await create({ cookie, payload: payload() });
      expect(res.statusCode).toBe(502);
      expect(res.json()).toEqual({ error: 'pve-unreachable' });
    });
  });

  describe('the root password never reaches the logger or a response', () => {
    /**
     * Same mechanism as `cloudInitRoutes.test.ts`: the app's logger is `silent` under
     * NODE_ENV=test, so every level method of the root logger AND of each per-request child logger
     * is spied on, recording the arguments each call was handed (run through the logger's own pino
     * serializers first, so what is asserted on is what pino would write).
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

    it('a successful create logs who/where/which id only, and never echoes the password', async () => {
      const cookie = await setupReady();
      const calls = captureLogCalls();
      const res = await create({ cookie, payload: payload({ sshKeys: [KEY_ED] }) });
      expect(res.statusCode).toBe(202);
      expect(res.body).not.toContain(PASSWORD);
      expect(fakePve.createCalls[0]!.body.password).toBe(PASSWORD);

      const logged = calls.find((args) => args[1] === 'Container create requested');
      expect(logged).toBeDefined();
      expect(logged![0]).toMatchObject({ node: 'pve1', vmid: VMID });
      expect(Object.keys(logged![0] as object).sort()).toStrictEqual(['node', 'upid', 'username', 'vmid']);
      for (const args of calls) {
        const serialized = JSON.stringify(args);
        expect(serialized).not.toContain(PASSWORD);
        expect(serialized).not.toContain(KEY_ED);
      }
    });

    it('PVE 4xx and 5xx, a taken id, a missing privilege and a 400 never log or return it either', async () => {
      const cookie = await setupReady();
      const calls = captureLogCalls();

      fakePve.setCreateError('lxc', VMID, 500, 'boom');
      const down = await create({ cookie, payload: payload() });
      expect(down.statusCode).toBe(502);
      expect(down.body).not.toContain(PASSWORD);

      fakePve.setCreateError('lxc', VMID, 400, 'Parameter verification failed.');
      const rejected = await create({ cookie, payload: payload() });
      expect(rejected.statusCode).toBe(400);
      expect(rejected.body).not.toContain(PASSWORD);

      const invalid = await create({ cookie, payload: payload({ hostname: 'NOT valid' }) });
      expect(invalid.statusCode).toBe(400);
      expect(invalid.body).not.toContain(PASSWORD);

      fakePve.setExistingGuest(VMID, 'running');
      const taken = await create({ cookie, payload: payload() });
      expect(taken.statusCode).toBe(409);
      expect(taken.body).not.toContain(PASSWORD);

      fakePve.setVmPermissions(VMID, { 'VM.Allocate': false });
      const forbidden = await create({ cookie, payload: payload() });
      expect(forbidden.statusCode).toBe(403);
      expect(forbidden.body).not.toContain(PASSWORD);

      expect(calls.length).toBeGreaterThan(0);
      for (const args of calls) {
        expect(JSON.stringify(args)).not.toContain(PASSWORD);
      }
    });

    it('the route is never handed the request body to log', async () => {
      const cookie = await setupReady();
      const calls = captureLogCalls();
      await create({ cookie, payload: payload({ sshKeys: [KEY_ED], hostname: 'secret-host-name' }) });
      expect(calls.length).toBeGreaterThan(0);
      for (const args of calls) {
        const serialized = JSON.stringify(args);
        expect(serialized).not.toContain(PASSWORD);
        expect(serialized).not.toContain(KEY_ED);
        expect(serialized).not.toContain('secret-host-name');
      }
    });
  });
});
