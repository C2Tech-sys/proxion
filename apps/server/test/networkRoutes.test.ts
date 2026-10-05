import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance, InjectOptions } from 'fastify';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { startFakePve, type FakePve } from './helpers/fakePve.js';

const NIC_PRIV = { 'VM.Config.Network': true };
const MAC = 'BC:24:11:64:00:01';

describe('guest network device routes (T50)', () => {
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
    method: 'PUT' | 'DELETE' | 'GET',
    path: string,
    options: { cookie?: string; payload?: unknown } = {},
  ) {
    const injectOptions: InjectOptions = { method, url: `/api/actions/guest${path}` };
    if (options.cookie !== undefined) injectOptions.headers = { cookie: options.cookie };
    if (options.payload !== undefined) injectOptions.payload = options.payload as NonNullable<InjectOptions['payload']>;
    return app.inject(injectOptions);
  }

  describe('token mode', () => {
    it('PUT, DELETE and GET next-slot all 403 without reaching PVE config', async () => {
      await setupTokenMode();
      const put = await call('PUT', '/pve1/qemu/100/network/net0', { payload: { model: 'virtio', bridge: 'vmbr0' } });
      expect(put.statusCode).toBe(403);
      expect(put.json()).toEqual({ error: 'writes-disabled-in-token-mode' });
      const del = await call('DELETE', '/pve1/qemu/100/network/net0');
      expect(del.statusCode).toBe(403);
      expect(del.json()).toEqual({ error: 'writes-disabled-in-token-mode' });
      const next = await call('GET', '/pve1/qemu/100/network/next-slot');
      expect(next.statusCode).toBe(403);
      expect(next.json()).toEqual({ error: 'writes-disabled-in-token-mode' });
      expect(fakePve.configCalls).toHaveLength(0);
    });
  });

  describe('authentication and privilege', () => {
    it('401s without a session', async () => {
      await setupSession();
      const res = await call('PUT', '/pve1/qemu/100/network/net0', { payload: { model: 'virtio', bridge: 'vmbr0' } });
      expect(res.statusCode).toBe(401);
    });

    it('403s naming VM.Config.Network for PUT and DELETE, without any PVE write', async () => {
      const cookie = await setupSession();
      fakePve.setVmPermissions(100, { 'VM.Config.CPU': true, 'VM.Config.Network': false });
      fakePve.setGuestConfig('qemu', 100, { net0: `virtio=${MAC},bridge=vmbr0` });
      const put = await call('PUT', '/pve1/qemu/100/network/net0', {
        cookie,
        payload: { model: 'virtio', bridge: 'vmbr0' },
      });
      expect(put.statusCode).toBe(403);
      expect(put.json()).toEqual({ error: 'forbidden', missing: 'VM.Config.Network' });
      const del = await call('DELETE', '/pve1/qemu/100/network/net0', { cookie });
      expect(del.statusCode).toBe(403);
      expect(del.json()).toEqual({ error: 'forbidden', missing: 'VM.Config.Network' });
      expect(fakePve.configCalls).toHaveLength(0);
    });
  });

  describe('body validation (400)', () => {
    async function expect400(path: string, payload: unknown, method: 'PUT' = 'PUT') {
      const cookie = await setupSession();
      fakePve.setVmPermissions(100, NIC_PRIV);
      fakePve.setVmPermissions(200, NIC_PRIV);
      const res = await call(method, path, { cookie, payload });
      expect(res.statusCode).toBe(400);
      expect(fakePve.configCalls).toHaveLength(0);
      return res;
    }
    const QEMU = '/pve1/qemu/100/network/net0';
    const LXC = '/pve1/lxc/200/network/net0';

    it('rejects a bad slot', async () => {
      const good = { model: 'virtio', bridge: 'vmbr0' };
      await expect400('/pve1/qemu/100/network/net32', good);
      await expect400('/pve1/qemu/100/network/net-1', good);
      await expect400('/pve1/qemu/100/network/eth0', good);
      await expect400('/pve1/qemu/100/network/next-slot', good);
    });

    it('rejects a bad model (and a missing one on qemu)', async () => {
      await expect400(QEMU, { model: 'ne2k', bridge: 'vmbr0' });
      await expect400(QEMU, { model: 'virtio,bridge=vmbr9', bridge: 'vmbr0' });
      await expect400(QEMU, { bridge: 'vmbr0' });
    });

    it('rejects a multicast, malformed or non-colon MAC', async () => {
      await expect400(QEMU, { model: 'virtio', bridge: 'vmbr0', mac: '01:00:5E:00:00:01' });
      await expect400(QEMU, { model: 'virtio', bridge: 'vmbr0', mac: 'BC:24:11:64:00' });
      await expect400(QEMU, { model: 'virtio', bridge: 'vmbr0', mac: 'BC-24-11-64-00-01' });
      await expect400(LXC, { bridge: 'vmbr0', mac: '03:00:00:00:00:01' });
    });

    it('rejects a bad bridge (injection, leading digit, too long)', async () => {
      await expect400(QEMU, { model: 'virtio', bridge: 'vmbr0,firewall=1' });
      await expect400(QEMU, { model: 'virtio', bridge: '0vmbr' });
      await expect400(QEMU, { model: 'virtio', bridge: 'a'.repeat(16) });
      await expect400(QEMU, { model: 'virtio' });
    });

    it('rejects a VLAN of 0 or 4095 (and a non-integer)', async () => {
      await expect400(QEMU, { model: 'virtio', bridge: 'vmbr0', vlan: 0 });
      await expect400(QEMU, { model: 'virtio', bridge: 'vmbr0', vlan: 4095 });
      await expect400(QEMU, { model: 'virtio', bridge: 'vmbr0', vlan: 1.5 });
    });

    it('rejects out-of-range rate and mtu', async () => {
      await expect400(QEMU, { model: 'virtio', bridge: 'vmbr0', rateMbps: 0 });
      await expect400(QEMU, { model: 'virtio', bridge: 'vmbr0', rateMbps: 100001 });
      await expect400(QEMU, { model: 'virtio', bridge: 'vmbr0', mtu: 0 });
      await expect400(QEMU, { model: 'virtio', bridge: 'vmbr0', mtu: 65521 });
      await expect400(LXC, { bridge: 'vmbr0', mtu: 63 });
      await expect400(LXC, { bridge: 'vmbr0', mtu: 65536 });
    });

    it('rejects a bad CIDR / gateway / lxc name', async () => {
      await expect400(LXC, { bridge: 'vmbr0', ip: '10.0.0.5' });
      await expect400(LXC, { bridge: 'vmbr0', ip: '10.0.0.5/33' });
      await expect400(LXC, { bridge: 'vmbr0', ip: '300.0.0.5/24' });
      await expect400(LXC, { bridge: 'vmbr0', ip: '10.0.0.5/24,gw=1.1.1.1' });
      await expect400(LXC, { bridge: 'vmbr0', ip: '10.0.0.5/24', gw: '10.0.0.999' });
      await expect400(LXC, { bridge: 'vmbr0', ip6: 'fd00::5' });
      await expect400(LXC, { bridge: 'vmbr0', ip6: 'fd00::5/129' });
      await expect400(LXC, { bridge: 'vmbr0', ip6: 'fd00::5/64', gw6: 'not-an-ip' });
      await expect400(LXC, { bridge: 'vmbr0', name: 'wlan0' });
      // A gateway only makes sense with a static address.
      await expect400(LXC, { bridge: 'vmbr0', ip: 'dhcp', gw: '10.0.0.1' });
      await expect400(LXC, { bridge: 'vmbr0', gw: '10.0.0.1' });
    });

    it('rejects lxc-only fields on qemu and qemu-only fields on lxc', async () => {
      for (const extra of [{ name: 'eth0' }, { ip: 'dhcp' }, { gw: '10.0.0.1' }, { ip6: 'auto' }, { gw6: 'fd00::1' }]) {
        const res = await expect400(QEMU, { model: 'virtio', bridge: 'vmbr0', ...extra });
        expect(res.json().error).toBe('invalid-field-for-type');
      }
      for (const extra of [{ model: 'virtio' }, { linkDown: true }]) {
        const res = await expect400(LXC, { bridge: 'vmbr0', ...extra });
        expect(res.json().error).toBe('invalid-field-for-type');
      }
    });

    it('rejects an unknown field', async () => {
      await expect400(QEMU, { model: 'virtio', bridge: 'vmbr0', queues: 4 });
      await expect400(LXC, { bridge: 'vmbr0', type: 'veth' });
    });

    it('rejects a bad node/type/vmid', async () => {
      const cookie = await setupSession();
      const badType = await call('PUT', '/pve1/vm/100/network/net0', { cookie, payload: { model: 'virtio', bridge: 'vmbr0' } });
      expect(badType.statusCode).toBe(400);
      const badVmid = await call('DELETE', '/pve1/qemu/abc/network/net0', { cookie });
      expect(badVmid.statusCode).toBe(400);
    });
  });

  describe('PVE value composition', () => {
    async function put(type: 'qemu' | 'lxc', vmid: number, slot: string, payload: unknown, cookie: string) {
      fakePve.setVmPermissions(vmid, NIC_PRIV);
      return call('PUT', `/pve1/${type}/${vmid}/network/${slot}`, { cookie, payload });
    }

    it('qemu without a MAC: the bare model, bridge only', async () => {
      const cookie = await setupSession();
      const res = await put('qemu', 100, 'net2', { model: 'virtio', bridge: 'vmbr0' }, cookie);
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ ok: true, slot: 'net2', pending: [] });
      expect(fakePve.configCalls).toHaveLength(1);
      expect(fakePve.configCalls[0]!.path).toContain('/nodes/pve1/qemu/100/config');
      expect(fakePve.configCalls[0]!.body).toEqual({ net2: 'virtio,bridge=vmbr0' });
    });

    it('qemu with MAC, vlan, firewall, rate and link_down, in PVE order', async () => {
      const cookie = await setupSession();
      const res = await put(
        'qemu',
        100,
        'net3',
        {
          // Key order in the body must not matter.
          linkDown: true,
          rateMbps: 12.5,
          firewall: true,
          vlan: 20,
          mac: MAC,
          bridge: 'vmbr1',
          model: 'e1000e',
          mtu: 1500,
        },
        cookie,
      );
      expect(res.statusCode).toBe(200);
      expect(fakePve.configCalls[0]!.body).toEqual({
        net3: `e1000e=${MAC},bridge=vmbr1,tag=20,firewall=1,rate=12.5,link_down=1,mtu=1500`,
      });
    });

    it('accepts PVE\'s own mtu ranges: qemu 1 (= bridge MTU) and 65520, lxc 64 and 65535', async () => {
      const cookie = await setupSession();
      await put('qemu', 100, 'net0', { model: 'virtio', bridge: 'vmbr0', mtu: 1 }, cookie);
      expect(fakePve.configCalls[0]!.body).toEqual({ net0: 'virtio,bridge=vmbr0,mtu=1' });
      await put('qemu', 100, 'net0', { model: 'virtio', bridge: 'vmbr0', mtu: 65520 }, cookie);
      expect(fakePve.configCalls[1]!.body).toEqual({ net0: 'virtio,bridge=vmbr0,mtu=65520' });
      const lxc64 = await put('lxc', 200, 'net0', { bridge: 'vmbr0', mtu: 64 }, cookie);
      expect(lxc64.statusCode).toBe(200);
      expect(fakePve.configCalls[2]!.body).toEqual({ net0: 'name=eth0,bridge=vmbr0,mtu=64' });
      const lxcMax = await put('lxc', 200, 'net0', { bridge: 'vmbr0', mtu: 65535 }, cookie);
      expect(lxcMax.statusCode).toBe(200);
      // qemu tops out at 65520.
      const qemuOver = await put('qemu', 100, 'net0', { model: 'virtio', bridge: 'vmbr0', mtu: 65521 }, cookie);
      expect(qemuOver.statusCode).toBe(400);
      expect(fakePve.configCalls).toHaveLength(4);
    });

    it('an explicit firewall:false is sent as firewall=0', async () => {
      const cookie = await setupSession();
      await put('qemu', 100, 'net1', { model: 'vmxnet3', bridge: 'vmbr0', firewall: false }, cookie);
      expect(fakePve.configCalls[0]!.body).toEqual({ net1: 'vmxnet3,bridge=vmbr0,firewall=0' });
    });

    it('lxc with DHCP and the default ifname for the slot', async () => {
      const cookie = await setupSession();
      const res = await put('lxc', 200, 'net1', { bridge: 'vmbr0', ip: 'dhcp', firewall: true }, cookie);
      expect(res.statusCode).toBe(200);
      expect(fakePve.configCalls[0]!.path).toContain('/nodes/pve1/lxc/200/config');
      expect(fakePve.configCalls[0]!.body).toEqual({ net1: 'name=eth1,bridge=vmbr0,ip=dhcp,firewall=1' });
    });

    it('lxc with a static CIDR + gateway, explicit name and MAC', async () => {
      const cookie = await setupSession();
      await put(
        'lxc',
        200,
        'net0',
        { name: 'eth0', bridge: 'vmbr0', mac: MAC, ip: '10.0.0.5/24', gw: '10.0.0.1', vlan: 30, rateMbps: 5, mtu: 1400 },
        cookie,
      );
      expect(fakePve.configCalls[0]!.body).toEqual({
        net0: `name=eth0,bridge=vmbr0,hwaddr=${MAC},ip=10.0.0.5/24,gw=10.0.0.1,tag=30,rate=5,mtu=1400`,
      });
    });

    it('lxc with ip6 auto, and with a static ip6 + gateway', async () => {
      const cookie = await setupSession();
      await put('lxc', 200, 'net0', { bridge: 'vmbr0', ip: 'manual', ip6: 'auto' }, cookie);
      expect(fakePve.configCalls[0]!.body).toEqual({ net0: 'name=eth0,bridge=vmbr0,ip=manual,ip6=auto' });
      await put('lxc', 200, 'net0', { bridge: 'vmbr0', ip6: 'fd00::5/64', gw6: 'fd00::1' }, cookie);
      expect(fakePve.configCalls[1]!.body).toEqual({ net0: 'name=eth0,bridge=vmbr0,ip6=fd00::5/64,gw6=fd00::1' });
    });
  });

  describe('editing an existing slot', () => {
    it('keeps the existing qemu MAC when mac is omitted, and drops every other omitted field', async () => {
      const cookie = await setupSession();
      fakePve.setVmPermissions(100, NIC_PRIV);
      fakePve.setGuestConfig('qemu', 100, {
        net0: `virtio=${MAC},bridge=vmbr0,firewall=1,tag=20,rate=10,link_down=1`,
      });
      const res = await call('PUT', '/pve1/qemu/100/network/net0', {
        cookie,
        payload: { model: 'e1000', bridge: 'vmbr1' },
      });
      expect(res.statusCode).toBe(200);
      // Same address, new model/bridge; tag/firewall/rate/link_down are gone.
      expect(fakePve.configCalls[0]!.body).toEqual({ net0: `e1000=${MAC},bridge=vmbr1` });
    });

    it('keeps the existing lxc hwaddr when omitted', async () => {
      const cookie = await setupSession();
      fakePve.setVmPermissions(200, NIC_PRIV);
      fakePve.setGuestConfig('lxc', 200, {
        net0: `name=eth0,bridge=vmbr0,firewall=1,hwaddr=${MAC},ip=dhcp,type=veth`,
      });
      await call('PUT', '/pve1/lxc/200/network/net0', {
        cookie,
        payload: { name: 'eth0', bridge: 'vmbr0', ip: '10.0.0.5/24', gw: '10.0.0.1' },
      });
      // `type=veth` is not modeled by the body, so it is carried over unchanged.
      expect(fakePve.configCalls[0]!.body).toEqual({
        net0: `name=eth0,bridge=vmbr0,hwaddr=${MAC},ip=10.0.0.5/24,gw=10.0.0.1,type=veth`,
      });
    });

    it('an edit keeps qemu options the body does not model (queues, trunks), in order, after the composed fields', async () => {
      const cookie = await setupSession();
      fakePve.setVmPermissions(100, NIC_PRIV);
      fakePve.setGuestConfig('qemu', 100, { net0: `virtio=${MAC},bridge=vmbr0,queues=4,trunks=10;20` });
      const res = await call('PUT', '/pve1/qemu/100/network/net0', {
        cookie,
        payload: { model: 'virtio', bridge: 'vmbr1' },
      });
      expect(res.statusCode).toBe(200);
      expect(fakePve.configCalls[0]!.body).toEqual({
        net0: `virtio=${MAC},bridge=vmbr1,queues=4,trunks=10;20`,
      });
    });

    it('a legacy `<model>,macaddr=<MAC>` value keeps the MAC once and never carries macaddr= over as an extra', async () => {
      const cookie = await setupSession();
      fakePve.setVmPermissions(100, NIC_PRIV);
      fakePve.setGuestConfig('qemu', 100, { net0: `virtio,macaddr=${MAC},bridge=vmbr0` });
      const res = await call('PUT', '/pve1/qemu/100/network/net0', {
        cookie,
        payload: { model: 'virtio', bridge: 'vmbr1' },
      });
      expect(res.statusCode).toBe(200);
      expect(fakePve.configCalls[0]!.body).toEqual({ net0: `virtio=${MAC},bridge=vmbr1` });
    });

    it('an edit never carries a modeled key over when the body omits it (tag and firewall still drop)', async () => {
      const cookie = await setupSession();
      fakePve.setVmPermissions(100, NIC_PRIV);
      fakePve.setGuestConfig('qemu', 100, {
        net0: `virtio=${MAC},bridge=vmbr0,tag=20,firewall=1,queues=8,mtu=1500,link_down=1`,
      });
      await call('PUT', '/pve1/qemu/100/network/net0', {
        cookie,
        payload: { model: 'virtio', bridge: 'vmbr0', mtu: 1400 },
      });
      expect(fakePve.configCalls[0]!.body).toEqual({ net0: `virtio=${MAC},bridge=vmbr0,mtu=1400,queues=8` });
    });

    it('an lxc edit keeps link_down and trunks, which the lxc body does not model', async () => {
      const cookie = await setupSession();
      fakePve.setVmPermissions(200, NIC_PRIV);
      fakePve.setGuestConfig('lxc', 200, {
        net0: `name=eth0,bridge=vmbr0,hwaddr=${MAC},ip=dhcp,link_down=1,trunks=5;6`,
      });
      await call('PUT', '/pve1/lxc/200/network/net0', {
        cookie,
        payload: { name: 'eth0', bridge: 'vmbr0', ip: 'dhcp' },
      });
      expect(fakePve.configCalls[0]!.body).toEqual({
        net0: `name=eth0,bridge=vmbr0,hwaddr=${MAC},ip=dhcp,link_down=1,trunks=5;6`,
      });
    });

    it('an ADD (slot absent) never carries anything from another slot', async () => {
      const cookie = await setupSession();
      fakePve.setVmPermissions(100, NIC_PRIV);
      fakePve.setGuestConfig('qemu', 100, { net0: `virtio=${MAC},bridge=vmbr0,queues=4,trunks=10;20` });
      await call('PUT', '/pve1/qemu/100/network/net1', { cookie, payload: { model: 'virtio', bridge: 'vmbr0' } });
      expect(fakePve.configCalls[0]!.body).toEqual({ net1: 'virtio,bridge=vmbr0' });
    });

    it('an explicit mac replaces the existing one', async () => {
      const cookie = await setupSession();
      fakePve.setVmPermissions(100, NIC_PRIV);
      fakePve.setGuestConfig('qemu', 100, { net0: `virtio=${MAC},bridge=vmbr0` });
      await call('PUT', '/pve1/qemu/100/network/net0', {
        cookie,
        payload: { model: 'virtio', bridge: 'vmbr0', mac: '02:00:00:00:00:99' },
      });
      expect(fakePve.configCalls[0]!.body).toEqual({ net0: 'virtio=02:00:00:00:00:99,bridge=vmbr0' });
    });

    it('a new slot does not inherit another slot\'s MAC', async () => {
      const cookie = await setupSession();
      fakePve.setVmPermissions(100, NIC_PRIV);
      fakePve.setGuestConfig('qemu', 100, { net0: `virtio=${MAC},bridge=vmbr0` });
      await call('PUT', '/pve1/qemu/100/network/net1', { cookie, payload: { model: 'virtio', bridge: 'vmbr0' } });
      expect(fakePve.configCalls[0]!.body).toEqual({ net1: 'virtio,bridge=vmbr0' });
    });
  });

  describe('pending and errors', () => {
    it('reports the slot as pending when PVE holds it back', async () => {
      const cookie = await setupSession();
      fakePve.setVmPermissions(200, NIC_PRIV);
      fakePve.setPending('lxc', 200, [
        { key: 'net0', value: 'name=eth0,bridge=vmbr0', pending: 'name=eth0,bridge=vmbr1' },
        { key: 'memory', value: '512', pending: '1024' },
      ]);
      const res = await call('PUT', '/pve1/lxc/200/network/net0', { cookie, payload: { bridge: 'vmbr1' } });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ ok: true, slot: 'net0', pending: ['net0'] });
    });

    it('a pending-list failure never fails the applied change', async () => {
      const cookie = await setupSession();
      fakePve.setVmPermissions(100, NIC_PRIV);
      fakePve.setPendingError('qemu', 100, 500);
      const res = await call('PUT', '/pve1/qemu/100/network/net0', {
        cookie,
        payload: { model: 'virtio', bridge: 'vmbr0' },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ ok: true, slot: 'net0', pending: [] });
    });

    it('surfaces PVE\'s error detail (PUT) and maps a 5xx to pve-unreachable', async () => {
      const cookie = await setupSession();
      fakePve.setVmPermissions(100, NIC_PRIV);
      fakePve.setConfigError('qemu', 100, 403, 'Permission check failed (/sdn/zones/localnetwork/vmbr9, SDN.Use)');
      const denied = await call('PUT', '/pve1/qemu/100/network/net0', {
        cookie,
        payload: { model: 'virtio', bridge: 'vmbr9' },
      });
      expect(denied.statusCode).toBe(403);
      expect(denied.json()).toEqual({
        error: 'pve-rejected',
        message: 'Permission check failed (/sdn/zones/localnetwork/vmbr9, SDN.Use)',
      });

      fakePve.setConfigError('qemu', 100, 400, 'Parameter verification failed.', { net0: 'invalid format' });
      const invalid = await call('PUT', '/pve1/qemu/100/network/net0', {
        cookie,
        payload: { model: 'virtio', bridge: 'vmbr0' },
      });
      expect(invalid.statusCode).toBe(400);
      expect(invalid.json().message).toBe('Parameter verification failed. net0: invalid format');

      fakePve.setConfigError('qemu', 100, 500, 'boom');
      const down = await call('PUT', '/pve1/qemu/100/network/net0', {
        cookie,
        payload: { model: 'virtio', bridge: 'vmbr0' },
      });
      expect(down.statusCode).toBe(502);
      expect(down.json()).toEqual({ error: 'pve-unreachable' });
    });
  });

  describe('DELETE', () => {
    it('maps to delete=netN and reports pending', async () => {
      const cookie = await setupSession();
      fakePve.setVmPermissions(100, NIC_PRIV);
      fakePve.setGuestConfig('qemu', 100, {
        net0: `virtio=${MAC},bridge=vmbr0`,
        net1: 'virtio=BC:24:11:64:00:02,bridge=vmbr0',
      });
      fakePve.setPending('qemu', 100, [{ key: 'net1', value: 'virtio=BC:24:11:64:00:02,bridge=vmbr0', delete: 1 }]);
      const res = await call('DELETE', '/pve1/qemu/100/network/net1', { cookie });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ ok: true, pending: ['net1'] });
      expect(fakePve.configCalls).toHaveLength(1);
      expect(fakePve.configCalls[0]!.path).toContain('/nodes/pve1/qemu/100/config');
      expect(fakePve.configCalls[0]!.body).toEqual({ delete: 'net1' });
    });

    it('works on lxc too', async () => {
      const cookie = await setupSession();
      fakePve.setVmPermissions(200, NIC_PRIV);
      fakePve.setGuestConfig('lxc', 200, { net0: 'name=eth0,bridge=vmbr0,ip=dhcp' });
      const res = await call('DELETE', '/pve1/lxc/200/network/net0', { cookie });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ ok: true, pending: [] });
      expect(fakePve.configCalls[0]!.path).toContain('/nodes/pve1/lxc/200/config');
      expect(fakePve.configCalls[0]!.body).toEqual({ delete: 'net0' });
    });

    it('404s not-found for an absent slot without any PVE write', async () => {
      const cookie = await setupSession();
      fakePve.setVmPermissions(100, NIC_PRIV);
      fakePve.setGuestConfig('qemu', 100, { net0: `virtio=${MAC},bridge=vmbr0` });
      const res = await call('DELETE', '/pve1/qemu/100/network/net5', { cookie });
      expect(res.statusCode).toBe(404);
      expect(res.json().error).toBe('not-found');
      expect(fakePve.configCalls).toHaveLength(0);
    });

    it('surfaces PVE\'s error detail', async () => {
      const cookie = await setupSession();
      fakePve.setVmPermissions(100, NIC_PRIV);
      fakePve.setGuestConfig('qemu', 100, { net0: `virtio=${MAC},bridge=vmbr0` });
      fakePve.setConfigError('qemu', 100, 400, 'cannot delete net0 - guest is locked');
      const res = await call('DELETE', '/pve1/qemu/100/network/net0', { cookie });
      expect(res.statusCode).toBe(400);
      expect(res.json()).toEqual({ error: 'pve-rejected', message: 'cannot delete net0 - guest is locked' });
    });
  });

  describe('GET next-slot', () => {
    it('picks the first gap', async () => {
      const cookie = await setupSession();
      fakePve.setGuestConfig('qemu', 100, {
        net0: `virtio=${MAC},bridge=vmbr0`,
        net1: 'virtio=BC:24:11:64:00:02,bridge=vmbr0',
        net3: 'virtio=BC:24:11:64:00:04,bridge=vmbr0',
      });
      const res = await call('GET', '/pve1/qemu/100/network/next-slot', { cookie });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ slot: 'net2' });
    });

    it('is net0 on a guest without NICs, and needs no VM.Config.Network', async () => {
      const cookie = await setupSession();
      fakePve.setVmPermissions(200, {});
      fakePve.setGuestConfig('lxc', 200, { hostname: 'ct' });
      const res = await call('GET', '/pve1/lxc/200/network/next-slot', { cookie });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ slot: 'net0' });
    });

    it('409s when all 32 slots are used', async () => {
      const cookie = await setupSession();
      const config: Record<string, string> = {};
      for (let n = 0; n < 32; n++) config[`net${n}`] = 'virtio,bridge=vmbr0';
      fakePve.setGuestConfig('qemu', 100, config);
      const res = await call('GET', '/pve1/qemu/100/network/next-slot', { cookie });
      expect(res.statusCode).toBe(409);
      expect(res.json().error).toBe('no-free-slot');
    });

    it('401s without a session', async () => {
      await setupSession();
      const res = await call('GET', '/pve1/qemu/100/network/next-slot');
      expect(res.statusCode).toBe(401);
    });
  });
});
