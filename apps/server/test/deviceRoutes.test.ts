import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance, InjectOptions } from 'fastify';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { startFakePve, type FakePve } from './helpers/fakePve.js';

const HW_PRIV = { 'VM.Config.HWType': true };

describe('guest USB/PCI/serial device routes (T55)', () => {
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

  const USB = { kind: 'usb', source: 'spice' };

  describe('token mode', () => {
    it('PUT, DELETE and GET next-slot all 403 without reaching PVE config', async () => {
      await setupTokenMode();
      const put = await call('PUT', '/pve1/qemu/100/devices/usb0', { payload: USB });
      expect(put.statusCode).toBe(403);
      expect(put.json()).toEqual({ error: 'writes-disabled-in-token-mode' });
      const del = await call('DELETE', '/pve1/qemu/100/devices/usb0');
      expect(del.statusCode).toBe(403);
      expect(del.json()).toEqual({ error: 'writes-disabled-in-token-mode' });
      const next = await call('GET', '/pve1/qemu/100/devices/next-slot?kind=usb');
      expect(next.statusCode).toBe(403);
      expect(next.json()).toEqual({ error: 'writes-disabled-in-token-mode' });
      expect(fakePve.configCalls).toHaveLength(0);
    });
  });

  describe('authentication and privilege', () => {
    it('401s without a session', async () => {
      await setupSession();
      const res = await call('PUT', '/pve1/qemu/100/devices/usb0', { payload: USB });
      expect(res.statusCode).toBe(401);
    });

    it('401s DELETE and GET next-slot without a session', async () => {
      await setupSession();
      const del = await call('DELETE', '/pve1/qemu/100/devices/usb0');
      expect(del.statusCode).toBe(401);
      const next = await call('GET', '/pve1/qemu/100/devices/next-slot?kind=pci');
      expect(next.statusCode).toBe(401);
    });

    it('next-slot needs a session but no device privilege', async () => {
      const cookie = await setupSession();
      fakePve.setVmPermissions(100, { 'VM.Config.HWType': false });
      const res = await call('GET', '/pve1/qemu/100/devices/next-slot?kind=usb', { cookie });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ slot: 'usb0' });
    });

    it('403s naming VM.Config.HWType for PUT and DELETE, without any PVE write', async () => {
      const cookie = await setupSession();
      fakePve.setVmPermissions(100, { 'VM.Config.CPU': true, 'VM.Config.HWType': false });
      fakePve.setGuestConfig('qemu', 100, { usb0: 'host=spice' });
      const put = await call('PUT', '/pve1/qemu/100/devices/usb0', { cookie, payload: USB });
      expect(put.statusCode).toBe(403);
      expect(put.json()).toEqual({ error: 'forbidden', missing: 'VM.Config.HWType' });
      const del = await call('DELETE', '/pve1/qemu/100/devices/usb0', { cookie });
      expect(del.statusCode).toBe(403);
      expect(del.json()).toEqual({ error: 'forbidden', missing: 'VM.Config.HWType' });
      expect(fakePve.configCalls).toHaveLength(0);
    });

    it('checks the privilege before reading the guest config (no config GET for PUT or DELETE)', async () => {
      const cookie = await setupSession();
      fakePve.setGuestConfig('qemu', 100, { usb0: 'host=spice' });

      // Control: with the privilege, both routes read the current config exactly once.
      fakePve.setVmPermissions(100, HW_PRIV);
      expect((await call('PUT', '/pve1/qemu/100/devices/usb0', { cookie, payload: USB })).statusCode).toBe(200);
      expect(fakePve.configGetCalls).toStrictEqual([{ type: 'qemu', vmid: 100 }]);
      expect((await call('DELETE', '/pve1/qemu/100/devices/usb0', { cookie })).statusCode).toBe(200);
      expect(fakePve.configGetCalls).toHaveLength(2);

      // Without it, both are refused before any config GET (and any PUT) reaches PVE.
      const getsBefore = fakePve.configGetCalls.length;
      const putsBefore = fakePve.configCalls.length;
      fakePve.setVmPermissions(100, { 'VM.Config.HWType': false });
      expect((await call('PUT', '/pve1/qemu/100/devices/usb0', { cookie, payload: USB })).statusCode).toBe(403);
      expect((await call('DELETE', '/pve1/qemu/100/devices/usb0', { cookie })).statusCode).toBe(403);
      expect(fakePve.configGetCalls).toHaveLength(getsBefore);
      expect(fakePve.configCalls).toHaveLength(putsBefore);
    });
  });

  describe('validation (400)', () => {
    async function expect400(path: string, payload: unknown) {
      const cookie = await setupSession();
      fakePve.setVmPermissions(100, HW_PRIV);
      fakePve.setVmPermissions(200, HW_PRIV);
      const res = await call('PUT', path, { cookie, payload });
      expect(res.statusCode).toBe(400);
      expect(fakePve.configCalls).toHaveLength(0);
      return res;
    }

    it('rejects an lxc guest as not-applicable (PUT, DELETE and next-slot)', async () => {
      const res = await expect400('/pve1/lxc/200/devices/usb0', USB);
      expect(res.json().error).toBe('not-applicable');
      const del = await call('DELETE', '/pve1/lxc/200/devices/usb0', { cookie: 'x' });
      expect(del.statusCode).toBe(400);
      expect(del.json().error).toBe('not-applicable');
      const next = await call('GET', '/pve1/lxc/200/devices/next-slot?kind=usb', { cookie: 'x' });
      expect(next.statusCode).toBe(400);
      expect(next.json().error).toBe('not-applicable');
    });

    it('rejects slots outside the anchored pattern', async () => {
      await expect400('/pve1/qemu/100/devices/usb14', USB);
      await expect400('/pve1/qemu/100/devices/hostpci16', { kind: 'pci', source: 'raw', id: '01:00.0' });
      await expect400('/pve1/qemu/100/devices/serial4', { kind: 'serial', target: 'socket' });
      await expect400('/pve1/qemu/100/devices/USB0', USB);
      await expect400('/pve1/qemu/100/devices/usb01', USB);
      await expect400('/pve1/qemu/100/devices/usb0x', USB);
      await expect400('/pve1/qemu/100/devices/net0', USB);
    });

    it('rejects a body kind that does not match the slot', async () => {
      const cookie = await setupSession();
      fakePve.setVmPermissions(100, HW_PRIV);
      const serialOnUsb = await call('PUT', '/pve1/qemu/100/devices/usb0', {
        cookie,
        payload: { kind: 'serial', target: 'socket' },
      });
      expect(serialOnUsb.statusCode).toBe(400);
      expect(serialOnUsb.json().error).toBe('slot-kind-mismatch');
      const pciOnSerial = await call('PUT', '/pve1/qemu/100/devices/serial0', {
        cookie,
        payload: { kind: 'pci', source: 'raw', id: '01:00.0' },
      });
      expect(pciOnSerial.statusCode).toBe(400);
      expect(pciOnSerial.json().error).toBe('slot-kind-mismatch');
      expect(fakePve.configCalls).toHaveLength(0);
    });

    it('rejects a bad USB vendor id, port and mapping name', async () => {
      await expect400('/pve1/qemu/100/devices/usb0', { kind: 'usb', source: 'vendor', id: '1d6b-0003' });
      await expect400('/pve1/qemu/100/devices/usb0', { kind: 'usb', source: 'vendor', id: '1d6b:00' });
      await expect400('/pve1/qemu/100/devices/usb0', { kind: 'usb', source: 'vendor', id: '1d6b:0003,usb3=1' });
      await expect400('/pve1/qemu/100/devices/usb0', { kind: 'usb', source: 'port', port: '1' });
      await expect400('/pve1/qemu/100/devices/usb0', { kind: 'usb', source: 'port', port: '1-2.' });
      await expect400('/pve1/qemu/100/devices/usb0', { kind: 'usb', source: 'mapping', mapping: '1bad' });
      await expect400('/pve1/qemu/100/devices/usb0', { kind: 'usb', source: 'mapping', mapping: 'a,b=1' });
    });

    it('rejects a bad PCI id, mdev and unknown source', async () => {
      await expect400('/pve1/qemu/100/devices/hostpci0', { kind: 'pci', source: 'raw', id: '0000:01:00.9' });
      await expect400('/pve1/qemu/100/devices/hostpci0', { kind: 'pci', source: 'raw', id: '1:0' });
      await expect400('/pve1/qemu/100/devices/hostpci0', { kind: 'pci', source: 'raw', id: '01:00.0,pcie=1' });
      await expect400('/pve1/qemu/100/devices/hostpci0', { kind: 'pci', source: 'raw', id: '01:00', mdev: 'a b' });
      await expect400('/pve1/qemu/100/devices/hostpci0', { kind: 'pci', source: 'vendor', id: '01:00' });
    });

    it('rejects a serial device path, extra keys and an empty body', async () => {
      await expect400('/pve1/qemu/100/devices/serial0', { kind: 'serial', target: '/dev/ttyS0' });
      await expect400('/pve1/qemu/100/devices/serial0', { kind: 'serial', target: 'socket', extra: 1 });
      await expect400('/pve1/qemu/100/devices/usb0', { ...USB, skiplock: true });
      await expect400('/pve1/qemu/100/devices/usb0', {});
    });

    it('rejects a bad vmid and a bad next-slot kind', async () => {
      const cookie = await setupSession();
      fakePve.setVmPermissions(100, HW_PRIV);
      const badVmid = await call('PUT', '/pve1/qemu/abc/devices/usb0', { cookie, payload: USB });
      expect(badVmid.statusCode).toBe(400);
      const badKind = await call('GET', '/pve1/qemu/100/devices/next-slot?kind=net', { cookie });
      expect(badKind.statusCode).toBe(400);
      const noKind = await call('GET', '/pve1/qemu/100/devices/next-slot', { cookie });
      expect(noKind.statusCode).toBe(400);
    });
  });

  describe('PVE value composition', () => {
    async function put(slot: string, payload: unknown, cookie: string) {
      fakePve.setVmPermissions(100, HW_PRIV);
      return call('PUT', `/pve1/qemu/100/devices/${slot}`, { cookie, payload });
    }

    it('usb spice', async () => {
      const cookie = await setupSession();
      const res = await put('usb0', { kind: 'usb', source: 'spice' }, cookie);
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ ok: true, changed: ['usb0'], pending: [] });
      expect(fakePve.configCalls).toHaveLength(1);
      expect(fakePve.configCalls[0]!.path).toContain('/nodes/pve1/qemu/100/config');
      expect(fakePve.configCalls[0]!.body).toEqual({ usb0: 'host=spice' });
    });

    it('usb vendor id, with and without usb3', async () => {
      const cookie = await setupSession();
      await put('usb1', { kind: 'usb', source: 'vendor', id: '1d6b:0003' }, cookie);
      await put('usb1', { kind: 'usb', source: 'vendor', id: '1d6b:0003', usb3: true }, cookie);
      await put('usb1', { kind: 'usb', source: 'vendor', id: '1d6b:0003', usb3: false }, cookie);
      expect(fakePve.configCalls.map((c) => c.body)).toEqual([
        { usb1: 'host=1d6b:0003' },
        { usb1: 'host=1d6b:0003,usb3=1' },
        { usb1: 'host=1d6b:0003' },
      ]);
    });

    it('usb port, including a nested hub path', async () => {
      const cookie = await setupSession();
      await put('usb2', { kind: 'usb', source: 'port', port: '1-2.3' }, cookie);
      await put('usb13', { kind: 'usb', source: 'port', port: '2-1' }, cookie);
      expect(fakePve.configCalls.map((c) => c.body)).toEqual([{ usb2: 'host=1-2.3' }, { usb13: 'host=2-1' }]);
    });

    it('usb mapping', async () => {
      const cookie = await setupSession();
      await put('usb0', { kind: 'usb', source: 'mapping', mapping: 'mykeyboard' }, cookie);
      await put('usb0', { kind: 'usb', source: 'mapping', mapping: 'mykeyboard', usb3: true }, cookie);
      expect(fakePve.configCalls.map((c) => c.body)).toEqual([
        { usb0: 'mapping=mykeyboard' },
        { usb0: 'mapping=mykeyboard,usb3=1' },
      ]);
    });

    it('pci raw with pcie, rombar off and x-vga, in order', async () => {
      const cookie = await setupSession();
      const res = await put(
        'hostpci0',
        { kind: 'pci', source: 'raw', id: '0000:01:00.0', pcie: true, rombar: false, xVga: true },
        cookie,
      );
      expect(res.statusCode).toBe(200);
      expect(fakePve.configCalls[0]!.body).toEqual({ hostpci0: '0000:01:00.0,pcie=1,rombar=0,x-vga=1' });
    });

    it('pci raw with allFunctions drops the function suffix', async () => {
      const cookie = await setupSession();
      await put('hostpci1', { kind: 'pci', source: 'raw', id: '01:00.0', allFunctions: true }, cookie);
      await put('hostpci1', { kind: 'pci', source: 'raw', id: '0000:01:00', allFunctions: true }, cookie);
      await put('hostpci1', { kind: 'pci', source: 'raw', id: '01:00' }, cookie);
      expect(fakePve.configCalls.map((c) => c.body)).toEqual([
        { hostpci1: '01:00' },
        { hostpci1: '0000:01:00' },
        { hostpci1: '01:00' },
      ]);
    });

    it('pci raw: rombar true and false flags are omitted unless they change PVE behavior', async () => {
      const cookie = await setupSession();
      await put('hostpci2', { kind: 'pci', source: 'raw', id: '01:00.0', rombar: true, pcie: false, xVga: false }, cookie);
      expect(fakePve.configCalls[0]!.body).toEqual({ hostpci2: '01:00.0' });
    });

    it('pci raw with an mdev type', async () => {
      const cookie = await setupSession();
      await put('hostpci3', { kind: 'pci', source: 'raw', id: '0000:00:02.0', mdev: 'i915-GVTg_V5_4' }, cookie);
      expect(fakePve.configCalls[0]!.body).toEqual({ hostpci3: '0000:00:02.0,mdev=i915-GVTg_V5_4' });
    });

    it('pci mapping with pcie', async () => {
      const cookie = await setupSession();
      await put('hostpci15', { kind: 'pci', source: 'mapping', mapping: 'gpu0', pcie: true }, cookie);
      expect(fakePve.configCalls[0]!.body).toEqual({ hostpci15: 'mapping=gpu0,pcie=1' });
    });

    it('serial socket', async () => {
      const cookie = await setupSession();
      const res = await put('serial0', { kind: 'serial', target: 'socket' }, cookie);
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ ok: true, changed: ['serial0'], pending: [] });
      expect(fakePve.configCalls[0]!.body).toEqual({ serial0: 'socket' });
    });
  });

  describe('editing an existing slot', () => {
    it('keeps PCI options the body does not model (romfile, vendor-id), after the composed fields', async () => {
      const cookie = await setupSession();
      fakePve.setVmPermissions(100, HW_PRIV);
      fakePve.setGuestConfig('qemu', 100, {
        hostpci0: '0000:01:00.0,pcie=1,romfile=gpu.rom,vendor-id=0x10de,x-vga=1',
      });
      const res = await call('PUT', '/pve1/qemu/100/devices/hostpci0', {
        cookie,
        payload: { kind: 'pci', source: 'raw', id: '0000:02:00.0', pcie: true },
      });
      expect(res.statusCode).toBe(200);
      // x-vga is modeled, so it drops with the body; romfile and vendor-id are carried over.
      expect(fakePve.configCalls[0]!.body).toEqual({
        hostpci0: '0000:02:00.0,pcie=1,romfile=gpu.rom,vendor-id=0x10de',
      });
    });

    it('a legacy host= PCI value is replaced, not duplicated', async () => {
      const cookie = await setupSession();
      fakePve.setVmPermissions(100, HW_PRIV);
      fakePve.setGuestConfig('qemu', 100, { hostpci0: 'host=0000:01:00.0,pcie=1' });
      await call('PUT', '/pve1/qemu/100/devices/hostpci0', {
        cookie,
        payload: { kind: 'pci', source: 'mapping', mapping: 'gpu0' },
      });
      expect(fakePve.configCalls[0]!.body).toEqual({ hostpci0: 'mapping=gpu0' });
    });

    it('a USB edit replaces the old source and keeps unmodeled options', async () => {
      const cookie = await setupSession();
      fakePve.setVmPermissions(100, HW_PRIV);
      fakePve.setGuestConfig('qemu', 100, { usb0: 'host=1d6b:0003,usb3=1,foo=bar' });
      await call('PUT', '/pve1/qemu/100/devices/usb0', {
        cookie,
        payload: { kind: 'usb', source: 'mapping', mapping: 'mykeyboard' },
      });
      expect(fakePve.configCalls[0]!.body).toEqual({ usb0: 'mapping=mykeyboard,foo=bar' });
    });

    it('an ADD (slot absent) never carries anything from another slot', async () => {
      const cookie = await setupSession();
      fakePve.setVmPermissions(100, HW_PRIV);
      fakePve.setGuestConfig('qemu', 100, { hostpci0: '0000:01:00.0,romfile=gpu.rom' });
      await call('PUT', '/pve1/qemu/100/devices/hostpci1', {
        cookie,
        payload: { kind: 'pci', source: 'raw', id: '02:00.0' },
      });
      expect(fakePve.configCalls[0]!.body).toEqual({ hostpci1: '02:00.0' });
    });
  });

  describe('delete', () => {
    it('sends { delete: slot } and responds ok with the pending list', async () => {
      const cookie = await setupSession();
      fakePve.setVmPermissions(100, HW_PRIV);
      fakePve.setGuestConfig('qemu', 100, { usb0: 'host=spice', usb1: 'host=1d6b:0003' });
      const res = await call('DELETE', '/pve1/qemu/100/devices/usb1', { cookie });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ ok: true, pending: [] });
      expect(fakePve.configCalls).toHaveLength(1);
      expect(fakePve.configCalls[0]!.body).toEqual({ delete: 'usb1' });
    });

    it('404s when the slot is absent, without any PVE write', async () => {
      const cookie = await setupSession();
      fakePve.setVmPermissions(100, HW_PRIV);
      fakePve.setGuestConfig('qemu', 100, { usb0: 'host=spice' });
      const res = await call('DELETE', '/pve1/qemu/100/devices/hostpci0', { cookie });
      expect(res.statusCode).toBe(404);
      expect(res.json().error).toBe('not-found');
      expect(fakePve.configCalls).toHaveLength(0);
    });

    it('reports the slot as pending when the removal is held back', async () => {
      const cookie = await setupSession();
      fakePve.setVmPermissions(100, HW_PRIV);
      fakePve.setGuestConfig('qemu', 100, { hostpci0: '0000:01:00.0' });
      fakePve.setPending('qemu', 100, [{ key: 'hostpci0', value: '0000:01:00.0', delete: 1 }]);
      const res = await call('DELETE', '/pve1/qemu/100/devices/hostpci0', { cookie });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ ok: true, pending: ['hostpci0'] });
    });
  });

  describe('next-slot', () => {
    async function next(kind: string, cookie: string) {
      return call('GET', `/pve1/qemu/100/devices/next-slot?kind=${kind}`, { cookie });
    }

    it('returns the lowest free slot per kind', async () => {
      const cookie = await setupSession();
      fakePve.setGuestConfig('qemu', 100, { usb0: 'host=spice', usb2: 'host=1-2', hostpci1: '01:00.0' });
      expect((await next('usb', cookie)).json()).toEqual({ slot: 'usb1' });
      expect((await next('pci', cookie)).json()).toEqual({ slot: 'hostpci0' });
      expect((await next('serial', cookie)).json()).toEqual({ slot: 'serial0' });
    });

    it('409s no-free-slot when every slot of a kind is in use', async () => {
      const cookie = await setupSession();
      const config: Record<string, string> = {};
      for (let n = 0; n < 14; n++) config[`usb${n}`] = 'host=spice';
      for (let n = 0; n < 16; n++) config[`hostpci${n}`] = `0${n % 8}:00.0`;
      for (let n = 0; n < 4; n++) config[`serial${n}`] = 'socket';
      fakePve.setGuestConfig('qemu', 100, config);
      for (const kind of ['usb', 'pci', 'serial']) {
        const res = await next(kind, cookie);
        expect(res.statusCode).toBe(409);
        expect(res.json().error).toBe('no-free-slot');
      }
    });

    it('the last free slot is found at the top of the range', async () => {
      const cookie = await setupSession();
      const config: Record<string, string> = {};
      for (let n = 0; n < 15; n++) config[`hostpci${n}`] = '01:00.0';
      fakePve.setGuestConfig('qemu', 100, config);
      expect((await next('pci', cookie)).json()).toEqual({ slot: 'hostpci15' });
    });
  });

  describe('PVE errors and pending', () => {
    it('relays a 4xx (root-only raw device) as pve-rejected with the message', async () => {
      const cookie = await setupSession();
      fakePve.setVmPermissions(100, HW_PRIV);
      fakePve.setConfigError('qemu', 100, 403, 'Permission check failed (only root can set usb0 to a raw device)');
      const res = await call('PUT', '/pve1/qemu/100/devices/usb0', {
        cookie,
        payload: { kind: 'usb', source: 'vendor', id: '1d6b:0003' },
      });
      expect(res.statusCode).toBe(403);
      expect(res.json().error).toBe('pve-rejected');
      expect(res.json().message).toContain('only root');
    });

    it('relays a 500 from the config PUT as 502 pve-unreachable', async () => {
      const cookie = await setupSession();
      fakePve.setVmPermissions(100, HW_PRIV);
      fakePve.setConfigError('qemu', 100, 500, 'boom');
      const res = await call('PUT', '/pve1/qemu/100/devices/serial0', {
        cookie,
        payload: { kind: 'serial', target: 'socket' },
      });
      expect(res.statusCode).toBe(502);
      expect(res.json()).toEqual({ error: 'pve-unreachable' });
    });

    it('reports the slot as pending when PVE holds it back', async () => {
      const cookie = await setupSession();
      fakePve.setVmPermissions(100, HW_PRIV);
      fakePve.setPending('qemu', 100, [
        { key: 'hostpci0', pending: '0000:01:00.0,pcie=1' },
        { key: 'memory', value: '512', pending: '1024' },
      ]);
      const res = await call('PUT', '/pve1/qemu/100/devices/hostpci0', {
        cookie,
        payload: { kind: 'pci', source: 'raw', id: '0000:01:00.0', pcie: true },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ ok: true, changed: ['hostpci0'], pending: ['hostpci0'] });
    });

    it('a pending-list failure never fails the applied change', async () => {
      const cookie = await setupSession();
      fakePve.setVmPermissions(100, HW_PRIV);
      fakePve.setPendingError('qemu', 100, 500);
      const res = await call('PUT', '/pve1/qemu/100/devices/usb0', { cookie, payload: USB });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ ok: true, changed: ['usb0'], pending: [] });
    });
  });
});
