import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance, InjectOptions } from 'fastify';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { startFakePve, type FakePve } from './helpers/fakePve.js';

const BASE = '/api/actions/node/pve1/network';
type HttpMethod = NonNullable<InjectOptions['method']>;

describe('node network routes (T69)', () => {
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
    fakePve.setNodePermissions('pve1', { 'Sys.Modify': true });
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

  function call(method: HttpMethod, path: string, cookie?: string, payload?: unknown) {
    const options: InjectOptions = { method, url: `${BASE}${path}` };
    if (cookie !== undefined) options.headers = { cookie };
    if (payload !== undefined) options.payload = payload as NonNullable<InjectOptions['payload']>;
    return app.inject(options);
  }

  async function expect400(path: string, cookie: string, payload: unknown, method: HttpMethod = 'POST') {
    const res = await call(method, path, cookie, payload);
    expect(res.statusCode).toBe(400);
    expect(fakePve.networkCalls).toHaveLength(0);
    return res;
  }

  const BRIDGE = { type: 'bridge', iface: 'vmbr1', bridge_ports: 'eno2', cidr: '10.10.0.2/24' };

  const ALL_WRITES: Array<[HttpMethod, string, unknown]> = [
    ['POST', '', BRIDGE],
    ['PUT', '/vmbr0', { comments: 'x' }],
    ['DELETE', '/vmbr1', undefined],
    ['POST', '/apply', undefined],
    ['POST', '/revert', undefined],
  ];

  describe('gating', () => {
    it('403s every write in token mode before any PVE call', async () => {
      await setupTokenMode();
      for (const [method, path, payload] of ALL_WRITES) {
        const res = await call(method, path, undefined, payload);
        expect(res.statusCode).toBe(403);
        expect(res.json()).toEqual({ error: 'writes-disabled-in-token-mode' });
      }
      expect(fakePve.requestCount).toBe(0);
    });

    it('401s every write without a session', async () => {
      await setupSession();
      for (const [method, path, payload] of ALL_WRITES) {
        const res = await call(method, path, undefined, payload);
        expect(res.statusCode).toBe(401);
      }
      expect(fakePve.networkCalls).toHaveLength(0);
    });

    it('403s without Sys.Modify on the node, naming the missing privilege', async () => {
      const cookie = await setupSession();
      fakePve.setNodePermissions('pve1', { 'Sys.Audit': true });
      for (const [method, path, payload] of ALL_WRITES) {
        const res = await call(method, path, cookie, payload);
        expect(res.statusCode).toBe(403);
        expect(res.json()).toEqual({ error: 'forbidden', missing: 'Sys.Modify' });
      }
      expect(fakePve.networkCalls).toHaveLength(0);
    });

    it("forwards PVE's top-level changes diff through the read-only proxy", async () => {
      const cookie = await setupSession();
      fakePve.setNetworkChanges('pve1', '--- /etc/network/interfaces\n+++ /etc/network/interfaces.new\n+auto vmbr1');
      const res = await app.inject({ method: 'GET', url: '/api/pve/nodes/pve1/network', headers: { cookie } });
      expect(res.statusCode).toBe(200);
      const json = res.json();
      expect(json.changes).toContain('+auto vmbr1');
      expect(Array.isArray(json.data)).toBe(true);
    });
  });

  describe('create', () => {
    it('creates a bridge with the exact PVE body', async () => {
      const cookie = await setupSession();
      const res = await call('POST', '', cookie, BRIDGE);
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ ok: true, iface: 'vmbr1' });
      expect(fakePve.networkCalls).toHaveLength(1);
      expect(fakePve.networkCalls[0]).toStrictEqual({
        method: 'POST',
        path: '/api2/json/nodes/pve1/network',
        body: { type: 'bridge', iface: 'vmbr1', autostart: '1', bridge_ports: 'eno2', cidr: '10.10.0.2/24' },
      });
    });

    it('creates a VLAN-aware bridge with a gateway, mtu and comment', async () => {
      const cookie = await setupSession();
      const res = await call('POST', '', cookie, {
        type: 'bridge',
        iface: 'vmbr2',
        autostart: false,
        method: 'static',
        cidr: '10.20.0.2/24',
        gateway: '10.20.0.1',
        bridge_ports: 'eno3 eno4',
        bridge_vlan_aware: true,
        mtu: 9000,
        comments: 'storage',
      });
      expect(res.statusCode).toBe(200);
      expect(fakePve.networkCalls[0]!.body).toStrictEqual({
        type: 'bridge',
        iface: 'vmbr2',
        autostart: '0',
        cidr: '10.20.0.2/24',
        gateway: '10.20.0.1',
        bridge_ports: 'eno3 eno4',
        bridge_vlan_aware: '1',
        mtu: '9000',
        comments: 'storage',
      });
    });

    it('creates a bond with slaves, mode and hash policy', async () => {
      const cookie = await setupSession();
      const res = await call('POST', '', cookie, {
        type: 'bond',
        iface: 'bond0',
        slaves: 'eno2 eno3',
        bond_mode: '802.3ad',
        bond_xmit_hash_policy: 'layer2+3',
      });
      expect(res.statusCode).toBe(200);
      expect(fakePve.networkCalls[0]!.body).toStrictEqual({
        type: 'bond',
        iface: 'bond0',
        autostart: '1',
        slaves: 'eno2 eno3',
        bond_mode: '802.3ad',
        bond_xmit_hash_policy: 'layer2+3',
      });
    });

    it('creates a VLAN with vlan-id and vlan-raw-device', async () => {
      const cookie = await setupSession();
      const res = await call('POST', '', cookie, {
        type: 'vlan',
        iface: 'vlan20',
        'vlan-id': 20,
        'vlan-raw-device': 'vmbr0',
        cidr: '10.20.0.5/24',
      });
      expect(res.statusCode).toBe(200);
      expect(fakePve.networkCalls[0]!.body).toStrictEqual({
        type: 'vlan',
        iface: 'vlan20',
        autostart: '1',
        'vlan-id': '20',
        'vlan-raw-device': 'vmbr0',
        cidr: '10.20.0.5/24',
      });
    });

    it('accepts a dotted VLAN name without vlan-id', async () => {
      const cookie = await setupSession();
      const res = await call('POST', '', cookie, { type: 'vlan', iface: 'vmbr0.30' });
      expect(res.statusCode).toBe(200);
      expect(fakePve.networkCalls[0]!.body).toStrictEqual({ type: 'vlan', iface: 'vmbr0.30', autostart: '1' });
    });

    it('rejects a gateway without a cidr (400)', async () => {
      const cookie = await setupSession();
      await expect400('', cookie, { type: 'bridge', iface: 'vmbr1', gateway: '10.10.0.1' });
      await expect400('', cookie, { type: 'bridge', iface: 'vmbr1', gateway6: 'fd00::1' });
    });

    it('rejects a bad iface name (regex, length, bridge naming)', async () => {
      const cookie = await setupSession();
      await expect400('', cookie, { type: 'bridge', iface: 'br0' });
      await expect400('', cookie, { type: 'bridge', iface: 'vmbr1; reboot' });
      await expect400('', cookie, { type: 'bond', iface: 'b'.repeat(16), slaves: 'eno1', bond_mode: 'active-backup' });
      await expect400('', cookie, { type: 'bond', iface: 'bond 0', slaves: 'eno1', bond_mode: 'active-backup' });
    });

    it('rejects bad addressing (cidr, gateway, mtu, comment, ports)', async () => {
      const cookie = await setupSession();
      await expect400('', cookie, { ...BRIDGE, cidr: '10.10.0.2' });
      await expect400('', cookie, { ...BRIDGE, cidr: '10.10.0.2/33' });
      await expect400('', cookie, { ...BRIDGE, gateway: '10.10.0.999' });
      await expect400('', cookie, { ...BRIDGE, cidr6: 'fd00::5' });
      await expect400('', cookie, { ...BRIDGE, mtu: 575 });
      await expect400('', cookie, { ...BRIDGE, mtu: 65521 });
      await expect400('', cookie, { ...BRIDGE, comments: 'a'.repeat(257) });
      await expect400('', cookie, { ...BRIDGE, comments: 'line\nbreak' });
      await expect400('', cookie, { ...BRIDGE, bridge_ports: 'eno2;reboot' });
    });

    it('rejects an incomplete bond and an incomplete VLAN', async () => {
      const cookie = await setupSession();
      await expect400('', cookie, { type: 'bond', iface: 'bond0', bond_mode: 'active-backup' });
      await expect400('', cookie, { type: 'bond', iface: 'bond0', slaves: 'eno1' });
      await expect400('', cookie, { type: 'bond', iface: 'bond0', slaves: 'eno1', bond_mode: 'bogus' });
      await expect400('', cookie, { type: 'vlan', iface: 'vlan20' });
      await expect400('', cookie, { type: 'vlan', iface: 'vlan20', 'vlan-id': 4095, 'vlan-raw-device': 'vmbr0' });
    });

    it('rejects type-foreign fields and unknown keys', async () => {
      const cookie = await setupSession();
      const res = await expect400('', cookie, { ...BRIDGE, slaves: 'eno1' });
      expect(res.json().error).toBe('invalid-field-for-type');
      await expect400('', cookie, { ...BRIDGE, 'vlan-id': 5 });
      await expect400('', cookie, { ...BRIDGE, extra: 1 });
      await expect400('', cookie, { type: 'eth', iface: 'eno9' });
    });

    it('refuses DHCP (PVE cannot set it) and inconsistent method/address pairs', async () => {
      const cookie = await setupSession();
      const dhcp = await expect400('', cookie, { ...BRIDGE, method: 'dhcp' });
      expect(dhcp.json().error).toBe('dhcp-unsupported');
      await expect400('', cookie, { type: 'bridge', iface: 'vmbr1', method: 'static' });
      await expect400('', cookie, { ...BRIDGE, method: 'manual' });
    });

    it('relays a PVE 4xx as pve-rejected and a PVE 5xx as pve-unreachable', async () => {
      const cookie = await setupSession();
      fakePve.setNetworkError('create', { status: 400, message: 'interface already exists', errors: { iface: 'exists' } });
      const rejected = await call('POST', '', cookie, BRIDGE);
      expect(rejected.statusCode).toBe(400);
      expect(rejected.json()).toEqual({ error: 'pve-rejected', message: 'interface already exists iface: exists' });
      fakePve.setNetworkError('create', { status: 500, message: 'boom' });
      const down = await call('POST', '', cookie, BRIDGE);
      expect(down.statusCode).toBe(502);
      expect(down.json()).toEqual({ error: 'pve-unreachable' });
    });
  });

  describe('edit', () => {
    it('edits a bridge, sending the interface type PVE requires', async () => {
      const cookie = await setupSession();
      const res = await call('PUT', '/vmbr0', cookie, { comments: 'lan', mtu: 1500, autostart: true });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ ok: true });
      expect(fakePve.networkCalls).toHaveLength(1);
      expect(fakePve.networkCalls[0]).toStrictEqual({
        method: 'PUT',
        path: '/api2/json/nodes/pve1/network/vmbr0',
        body: { type: 'bridge', comments: 'lan', mtu: '1500', autostart: '1' },
      });
    });

    it('clears the gateway with delete: gateway', async () => {
      const cookie = await setupSession();
      const res = await call('PUT', '/vmbr0', cookie, { gateway: null });
      expect(res.statusCode).toBe(200);
      expect(fakePve.networkCalls[0]!.body).toStrictEqual({ type: 'bridge', delete: 'gateway' });
    });

    it('joins several cleared fields into one delete list', async () => {
      const cookie = await setupSession();
      await call('PUT', '/vmbr0', cookie, { gateway: null, comments: null, mtu: null });
      expect(fakePve.networkCalls[0]!.body).toStrictEqual({ type: 'bridge', delete: 'gateway,mtu,comments' });
    });

    it('editing a physical interface sets addressing only', async () => {
      const cookie = await setupSession();
      const res = await call('PUT', '/eno2', cookie, { cidr: '10.30.0.5/24', gateway: '10.30.0.1', method: 'static' });
      expect(res.statusCode).toBe(200);
      expect(fakePve.networkCalls[0]!.body).toStrictEqual({
        type: 'eth',
        cidr: '10.30.0.5/24',
        gateway: '10.30.0.1',
      });
      fakePve.networkCalls.length = 0;
      const bridgeOnly = await call('PUT', '/eno2', cookie, { bridge_ports: 'eno9' });
      expect(bridgeOnly.statusCode).toBe(400);
      expect(bridgeOnly.json().error).toBe('invalid-field-for-type');
      expect(fakePve.networkCalls).toHaveLength(0);
    });

    it('switching to manual deletes the address and gateway', async () => {
      const cookie = await setupSession();
      await call('PUT', '/vmbr0', cookie, { method: 'manual' });
      expect(fakePve.networkCalls[0]!.body).toStrictEqual({ type: 'bridge', delete: 'cidr,gateway' });
    });

    it('rejects a gateway without a cidr (body or existing)', async () => {
      const cookie = await setupSession();
      // eno2 has no address; a gateway alone is refused.
      const noCidr = await call('PUT', '/eno2', cookie, { gateway: '10.30.0.1' });
      expect(noCidr.statusCode).toBe(400);
      // vmbr0 has a cidr, but the body deletes it while setting a gateway.
      const clearing = await call('PUT', '/vmbr0', cookie, { cidr: null, gateway: '10.0.0.1' });
      expect(clearing.statusCode).toBe(400);
      expect(fakePve.networkCalls).toHaveLength(0);
      // vmbr0 already has a cidr, so a gateway alone is fine.
      const ok = await call('PUT', '/vmbr0', cookie, { gateway: '192.0.2.254' });
      expect(ok.statusCode).toBe(200);
    });

    it('rejects an unknown key, a bad value, a wrong type claim, DHCP and an invalid iface', async () => {
      const cookie = await setupSession();
      await expect400('/vmbr0', cookie, { bogus: 1 }, 'PUT');
      await expect400('/vmbr0', cookie, { mtu: 100 }, 'PUT');
      await expect400('/vmbr0', cookie, { type: 'bond' }, 'PUT');
      await expect400('/vmbr0', cookie, { method: 'dhcp' }, 'PUT');
      const badName = await call('PUT', '/bad%20name', cookie, { comments: 'x' });
      expect(badName.statusCode).toBe(400);
    });

    it('404s an interface that does not exist', async () => {
      const cookie = await setupSession();
      const res = await call('PUT', '/vmbr9', cookie, { comments: 'x' });
      expect(res.statusCode).toBe(404);
      expect(res.json().error).toBe('not-found');
      expect(fakePve.networkCalls).toHaveLength(0);
    });

    it('relays a PVE 4xx and 5xx on edit', async () => {
      const cookie = await setupSession();
      fakePve.setNetworkError('update', { status: 400, message: 'only one gateway allowed' });
      const rejected = await call('PUT', '/vmbr0', cookie, { comments: 'x' });
      expect(rejected.statusCode).toBe(400);
      expect(rejected.json()).toEqual({ error: 'pve-rejected', message: 'only one gateway allowed' });
      fakePve.setNetworkError('update', { status: 503, message: 'down' });
      const down = await call('PUT', '/vmbr0', cookie, { comments: 'x' });
      expect(down.statusCode).toBe(502);
    });
  });

  describe('delete', () => {
    it('deletes an interface', async () => {
      const cookie = await setupSession();
      fakePve.setNetworkInterfaces('pve1', [
        { iface: 'vmbr0', type: 'bridge', cidr: '192.0.2.11/24' },
        { iface: 'vmbr1', type: 'bridge', cidr: '10.10.0.2/24' },
      ]);
      const res = await call('DELETE', '/vmbr1', cookie);
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ ok: true });
      expect(fakePve.networkCalls).toStrictEqual([
        { method: 'DELETE', path: '/api2/json/nodes/pve1/network/vmbr1', body: {} },
      ]);
    });

    it('404s an interface that does not exist', async () => {
      const cookie = await setupSession();
      const res = await call('DELETE', '/vmbr9', cookie);
      expect(res.statusCode).toBe(404);
      expect(fakePve.networkCalls).toHaveLength(0);
    });

    it('refuses the interface carrying the address PVE is reached at (management-interface)', async () => {
      const cookie = await setupSession();
      // The fake PVE listens on 127.0.0.1, which is the address this server reaches PVE at.
      fakePve.setNetworkInterfaces('pve1', [
        { iface: 'vmbr0', type: 'bridge', cidr: '127.0.0.1/8' },
        { iface: 'vmbr1', type: 'bridge', cidr: '10.10.0.2/24' },
      ]);
      const res = await call('DELETE', '/vmbr0', cookie);
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toBe('management-interface');
      expect(fakePve.networkCalls).toHaveLength(0);
      const other = await call('DELETE', '/vmbr1', cookie);
      expect(other.statusCode).toBe(200);
    });

    it('relays a PVE 4xx and 5xx on delete', async () => {
      const cookie = await setupSession();
      fakePve.setNetworkInterfaces('pve1', [{ iface: 'vmbr1', type: 'bridge' }]);
      fakePve.setNetworkError('delete', { status: 400, message: 'in use' });
      const rejected = await call('DELETE', '/vmbr1', cookie);
      expect(rejected.statusCode).toBe(400);
      expect(rejected.json()).toEqual({ error: 'pve-rejected', message: 'in use' });
      fakePve.setNetworkError('delete', { status: 500, message: 'boom' });
      const down = await call('DELETE', '/vmbr1', cookie);
      expect(down.statusCode).toBe(502);
    });
  });

  describe('apply and revert', () => {
    it('apply returns 202 with the task UPID', async () => {
      const cookie = await setupSession();
      const res = await call('POST', '/apply', cookie);
      expect(res.statusCode).toBe(202);
      expect(res.json()).toEqual({ upid: 'UPID:fakepve:00000001:00000000:00000000:srvreload:networking:root@pam:' });
      expect(fakePve.networkCalls).toStrictEqual([{ method: 'PUT', path: '/api2/json/nodes/pve1/network', body: {} }]);
    });

    it('revert returns 200 ok', async () => {
      const cookie = await setupSession();
      const res = await call('POST', '/revert', cookie);
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ ok: true });
      expect(fakePve.networkCalls).toStrictEqual([{ method: 'DELETE', path: '/api2/json/nodes/pve1/network', body: {} }]);
    });

    it('rejects a body on apply and revert (400)', async () => {
      const cookie = await setupSession();
      await expect400('/apply', cookie, { force: true });
      await expect400('/revert', cookie, { force: true });
    });

    it('relays a PVE 4xx and 5xx on apply and revert', async () => {
      const cookie = await setupSession();
      fakePve.setNetworkError('apply', { status: 400, message: 'bad config' });
      const rejected = await call('POST', '/apply', cookie);
      expect(rejected.statusCode).toBe(400);
      expect(rejected.json()).toEqual({ error: 'pve-rejected', message: 'bad config' });
      fakePve.setNetworkError('revert', { status: 502, message: 'gateway' });
      const down = await call('POST', '/revert', cookie);
      expect(down.statusCode).toBe(502);
      expect(down.json()).toEqual({ error: 'pve-unreachable' });
    });

    it('400s an invalid node name', async () => {
      const cookie = await setupSession();
      const res = await app.inject({
        method: 'POST',
        url: '/api/actions/node/-bad-/network/apply',
        headers: { cookie },
      });
      expect(res.statusCode).toBe(400);
      expect(fakePve.networkCalls).toHaveLength(0);
    });
  });
});
