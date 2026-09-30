import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance, InjectOptions } from 'fastify';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { startFakePve, type FakePve } from './helpers/fakePve.js';

const ALL_HW_PRIVS = {
  'VM.Config.CPU': true,
  'VM.Config.Memory': true,
  'VM.Config.CDROM': true,
  'VM.Config.Disk': true,
};

describe('guest hardware routes (T48)', () => {
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

  function patchHardware(path: string, options: { cookie?: string; payload?: unknown } = {}) {
    const injectOptions: InjectOptions = { method: 'PATCH', url: `/api/actions/guest${path}/hardware` };
    if (options.cookie !== undefined) injectOptions.headers = { cookie: options.cookie };
    if (options.payload !== undefined) injectOptions.payload = options.payload as NonNullable<InjectOptions['payload']>;
    return app.inject(injectOptions);
  }

  function resize(path: string, options: { cookie?: string; payload?: unknown } = {}) {
    const injectOptions: InjectOptions = { method: 'PUT', url: `/api/actions/guest${path}/resize` };
    if (options.cookie !== undefined) injectOptions.headers = { cookie: options.cookie };
    if (options.payload !== undefined) injectOptions.payload = options.payload as NonNullable<InjectOptions['payload']>;
    return app.inject(injectOptions);
  }

  const VALID_ISO = 'local:iso/debian-12.5.0-amd64-netinst.iso';

  describe('token mode', () => {
    it('hardware 403s in token mode without reaching PVE config', async () => {
      await setupTokenMode();
      const res = await patchHardware('/pve1/qemu/100', { payload: { cores: 2 } });
      expect(res.statusCode).toBe(403);
      expect(res.json()).toEqual({ error: 'writes-disabled-in-token-mode' });
      expect(fakePve.configCalls).toHaveLength(0);
    });

    it('resize 403s in token mode without reaching PVE', async () => {
      await setupTokenMode();
      const res = await resize('/pve1/qemu/100', { payload: { disk: 'scsi0', size: '+1G' } });
      expect(res.statusCode).toBe(403);
      expect(res.json()).toEqual({ error: 'writes-disabled-in-token-mode' });
      expect(fakePve.resizeCalls).toHaveLength(0);
    });
  });

  describe('authentication', () => {
    it('401s without a session', async () => {
      await setupSession();
      const res = await patchHardware('/pve1/qemu/100', { payload: { cores: 2 } });
      expect(res.statusCode).toBe(401);
      const res2 = await resize('/pve1/qemu/100', { payload: { disk: 'scsi0', size: '+1G' } });
      expect(res2.statusCode).toBe(401);
    });
  });

  describe('hardware privileges', () => {
    it('cores/sockets/cpu need VM.Config.CPU', async () => {
      const cookie = await setupSession();
      fakePve.setVmPermissions(100, { ...ALL_HW_PRIVS, 'VM.Config.CPU': false });
      for (const payload of [{ cores: 2 }, { sockets: 2 }, { cpu: 'host' }]) {
        const res = await patchHardware('/pve1/qemu/100', { cookie, payload });
        expect(res.statusCode).toBe(403);
        expect(res.json()).toEqual({ error: 'forbidden', missing: 'VM.Config.CPU' });
      }
      expect(fakePve.configCalls).toHaveLength(0);
    });

    it('memory/balloon/swap need VM.Config.Memory', async () => {
      const cookie = await setupSession();
      fakePve.setVmPermissions(100, { ...ALL_HW_PRIVS, 'VM.Config.Memory': false });
      for (const payload of [{ memory: 2048 }, { balloon: 0 }]) {
        const res = await patchHardware('/pve1/qemu/100', { cookie, payload });
        expect(res.statusCode).toBe(403);
        expect(res.json()).toEqual({ error: 'forbidden', missing: 'VM.Config.Memory' });
      }
      fakePve.setVmPermissions(200, { ...ALL_HW_PRIVS, 'VM.Config.Memory': false });
      const lxc = await patchHardware('/pve1/lxc/200', { cookie, payload: { swap: 512 } });
      expect(lxc.statusCode).toBe(403);
      expect(lxc.json()).toEqual({ error: 'forbidden', missing: 'VM.Config.Memory' });
      expect(fakePve.configCalls).toHaveLength(0);
    });

    it('cdrom needs VM.Config.CDROM', async () => {
      const cookie = await setupSession();
      fakePve.setVmPermissions(100, { ...ALL_HW_PRIVS, 'VM.Config.CDROM': false });
      const res = await patchHardware('/pve1/qemu/100', {
        cookie,
        payload: { cdrom: { slot: 'ide2', iso: VALID_ISO } },
      });
      expect(res.statusCode).toBe(403);
      expect(res.json()).toEqual({ error: 'forbidden', missing: 'VM.Config.CDROM' });
      expect(fakePve.configCalls).toHaveLength(0);
    });

    it('a request mixing cores + memory needs both privileges', async () => {
      const cookie = await setupSession();
      fakePve.setVmPermissions(100, { 'VM.Config.CPU': true, 'VM.Config.Memory': false });
      const noMemory = await patchHardware('/pve1/qemu/100', { cookie, payload: { cores: 2, memory: 2048 } });
      expect(noMemory.statusCode).toBe(403);
      expect(noMemory.json()).toEqual({ error: 'forbidden', missing: 'VM.Config.Memory' });

      fakePve.setVmPermissions(100, { 'VM.Config.CPU': false, 'VM.Config.Memory': true });
      const noCpu = await patchHardware('/pve1/qemu/100', { cookie, payload: { cores: 2, memory: 2048 } });
      expect(noCpu.statusCode).toBe(403);
      expect(noCpu.json()).toEqual({ error: 'forbidden', missing: 'VM.Config.CPU' });
      expect(fakePve.configCalls).toHaveLength(0);

      fakePve.setVmPermissions(100, { 'VM.Config.CPU': true, 'VM.Config.Memory': true });
      const both = await patchHardware('/pve1/qemu/100', { cookie, payload: { cores: 2, memory: 2048 } });
      expect(both.statusCode).toBe(200);
    });

    it('names the first missing privilege (CPU before Memory before CDROM)', async () => {
      const cookie = await setupSession();
      fakePve.setVmPermissions(100, {});
      const res = await patchHardware('/pve1/qemu/100', {
        cookie,
        payload: { memory: 2048, cdrom: { slot: 'ide2', iso: null }, cores: 2 },
      });
      expect(res.statusCode).toBe(403);
      expect(res.json()).toEqual({ error: 'forbidden', missing: 'VM.Config.CPU' });
    });

    it('having only one group does not grant another (CPU only, memory requested)', async () => {
      const cookie = await setupSession();
      fakePve.setVmPermissions(100, { 'VM.Config.CPU': true });
      const res = await patchHardware('/pve1/qemu/100', { cookie, payload: { memory: 1024 } });
      expect(res.statusCode).toBe(403);
      expect(res.json()).toEqual({ error: 'forbidden', missing: 'VM.Config.Memory' });
    });
  });

  describe('hardware body validation (400)', () => {
    async function expect400(path: string, payload: unknown) {
      const cookie = await setupSession();
      fakePve.setVmPermissions(100, ALL_HW_PRIVS);
      fakePve.setVmPermissions(200, ALL_HW_PRIVS);
      const res = await patchHardware(path, { cookie, payload });
      expect(res.statusCode).toBe(400);
      expect(fakePve.configCalls).toHaveLength(0);
      return res;
    }

    it('rejects an empty body', async () => {
      await expect400('/pve1/qemu/100', {});
    });

    it('rejects an unknown field', async () => {
      await expect400('/pve1/qemu/100', { cores: 2, skiplock: true });
    });

    it('rejects out-of-range cores/sockets', async () => {
      await expect400('/pve1/qemu/100', { cores: 0 });
      await expect400('/pve1/qemu/100', { cores: 1025 });
      await expect400('/pve1/qemu/100', { cores: 1.5 });
      await expect400('/pve1/qemu/100', { sockets: 65 });
      await expect400('/pve1/qemu/100', { sockets: 0 });
    });

    it('accepts the lxc cores upper bound but rejects beyond it', async () => {
      await expect400('/pve1/lxc/200', { cores: 8193 });
    });

    it('rejects out-of-range memory, balloon and swap', async () => {
      await expect400('/pve1/qemu/100', { memory: 15 });
      await expect400('/pve1/qemu/100', { memory: 4194305 });
      await expect400('/pve1/qemu/100', { balloon: -1 });
      await expect400('/pve1/lxc/200', { swap: -1 });
      await expect400('/pve1/lxc/200', { swap: 4194305 });
      await expect400('/pve1/lxc/200', { memory: 8 });
    });

    it('rejects a bad cpu model', async () => {
      await expect400('/pve1/qemu/100', { cpu: '' });
      await expect400('/pve1/qemu/100', { cpu: '-host' });
      await expect400('/pve1/qemu/100', { cpu: 'host,flags=+aes' });
      await expect400('/pve1/qemu/100', { cpu: 'a'.repeat(65) });
    });

    it('rejects a bad cdrom slot', async () => {
      await expect400('/pve1/qemu/100', { cdrom: { slot: 'ide4', iso: null } });
      await expect400('/pve1/qemu/100', { cdrom: { slot: 'sata6', iso: null } });
      await expect400('/pve1/qemu/100', { cdrom: { slot: 'scsi31', iso: null } });
      await expect400('/pve1/qemu/100', { cdrom: { slot: 'virtio0', iso: null } });
      await expect400('/pve1/qemu/100', { cdrom: { slot: 'ide2 ', iso: null } });
    });

    it('rejects a bad cdrom volid (shape, traversal, option injection, length)', async () => {
      const slot = 'ide2';
      await expect400('/pve1/qemu/100', { cdrom: { slot, iso: 'local:vztmpl/a.iso' } });
      await expect400('/pve1/qemu/100', { cdrom: { slot, iso: 'local:iso/a.txt' } });
      await expect400('/pve1/qemu/100', { cdrom: { slot, iso: 'local:iso/../etc/passwd.iso' } });
      await expect400('/pve1/qemu/100', { cdrom: { slot, iso: 'local:iso/a..b.iso' } });
      await expect400('/pve1/qemu/100', { cdrom: { slot, iso: 'local:iso/sub/a.iso' } });
      await expect400('/pve1/qemu/100', { cdrom: { slot, iso: 'local:iso/a.iso,media=disk' } });
      await expect400('/pve1/qemu/100', { cdrom: { slot, iso: '/dev/sda' } });
      await expect400('/pve1/qemu/100', { cdrom: { slot, iso: 'none' } });
      await expect400('/pve1/qemu/100', { cdrom: { slot, iso: '' } });
      await expect400('/pve1/qemu/100', { cdrom: { slot, iso: `local:iso/${'a'.repeat(260)}.iso` } });
      await expect400('/pve1/qemu/100', { cdrom: { slot } });
      await expect400('/pve1/qemu/100', { cdrom: { slot, iso: null, extra: 1 } });
    });

    it('rejects qemu-only fields on lxc', async () => {
      for (const payload of [
        { sockets: 2 },
        { cpu: 'host' },
        { balloon: 0 },
        { cdrom: { slot: 'ide2', iso: null } },
      ]) {
        const res = await expect400('/pve1/lxc/200', payload);
        expect(res.json().error).toBe('invalid-field-for-type');
      }
    });

    it('rejects swap on qemu', async () => {
      const res = await expect400('/pve1/qemu/100', { swap: 512 });
      expect(res.json().error).toBe('invalid-field-for-type');
    });

    it('rejects balloon above memory in the same request', async () => {
      await expect400('/pve1/qemu/100', { memory: 1024, balloon: 2048 });
    });

    it('rejects balloon above the current memory when memory is not in the request', async () => {
      const cookie = await setupSession();
      fakePve.setVmPermissions(100, ALL_HW_PRIVS);
      fakePve.setGuestConfig('qemu', 100, { memory: 2048 });
      const res = await patchHardware('/pve1/qemu/100', { cookie, payload: { balloon: 4096 } });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toBe('balloon-exceeds-memory');
      expect(fakePve.configCalls).toHaveLength(0);
    });

    it('rejects a bad node/type/vmid', async () => {
      const cookie = await setupSession();
      const badType = await patchHardware('/pve1/vm/100', { cookie, payload: { cores: 2 } });
      expect(badType.statusCode).toBe(400);
      const badVmid = await patchHardware('/pve1/qemu/abc', { cookie, payload: { cores: 2 } });
      expect(badVmid.statusCode).toBe(400);
    });
  });

  describe('hardware PVE parameter mapping', () => {
    it('maps qemu cores/sockets/cpu/memory/balloon onto PVE config params', async () => {
      const cookie = await setupSession();
      fakePve.setVmPermissions(100, ALL_HW_PRIVS);
      const res = await patchHardware('/pve1/qemu/100', {
        cookie,
        payload: { cores: 4, sockets: 2, cpu: 'x86-64-v3', memory: 8192, balloon: 0 },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({
        ok: true,
        changed: ['cores', 'sockets', 'cpu', 'memory', 'balloon'],
        pending: [],
      });
      expect(fakePve.configCalls).toHaveLength(1);
      expect(fakePve.configCalls[0]!.path).toContain('/nodes/pve1/qemu/100/config');
      expect(fakePve.configCalls[0]!.body).toEqual({
        cores: '4',
        sockets: '2',
        cpu: 'x86-64-v3',
        memory: '8192',
        balloon: '0',
      });
    });

    it('maps a cdrom with an ISO to "<slot>: <volid>,media=cdrom"', async () => {
      const cookie = await setupSession();
      fakePve.setVmPermissions(100, ALL_HW_PRIVS);
      const res = await patchHardware('/pve1/qemu/100', {
        cookie,
        payload: { cdrom: { slot: 'ide2', iso: VALID_ISO } },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().changed).toEqual(['ide2']);
      expect(fakePve.configCalls[0]!.body).toEqual({ ide2: `${VALID_ISO},media=cdrom` });
    });

    it('maps a null iso to "none,media=cdrom"', async () => {
      const cookie = await setupSession();
      fakePve.setVmPermissions(100, ALL_HW_PRIVS);
      const res = await patchHardware('/pve1/qemu/100', {
        cookie,
        payload: { cdrom: { slot: 'sata1', iso: null } },
      });
      expect(res.statusCode).toBe(200);
      expect(fakePve.configCalls[0]!.body).toEqual({ sata1: 'none,media=cdrom' });
    });

    it('maps lxc cores/memory/swap onto PVE config params', async () => {
      const cookie = await setupSession();
      fakePve.setVmPermissions(200, ALL_HW_PRIVS);
      const res = await patchHardware('/pve1/lxc/200', { cookie, payload: { cores: 2, memory: 1024, swap: 256 } });
      expect(res.statusCode).toBe(200);
      expect(res.json().changed).toEqual(['cores', 'memory', 'swap']);
      expect(fakePve.configCalls[0]!.path).toContain('/nodes/pve1/lxc/200/config');
      expect(fakePve.configCalls[0]!.body).toEqual({ cores: '2', memory: '1024', swap: '256' });
    });

    it('accepts a balloon within the current memory when memory is not in the request', async () => {
      const cookie = await setupSession();
      fakePve.setVmPermissions(100, ALL_HW_PRIVS);
      fakePve.setGuestConfig('qemu', 100, { memory: '4096' });
      const res = await patchHardware('/pve1/qemu/100', { cookie, payload: { balloon: 1024 } });
      expect(res.statusCode).toBe(200);
      expect(fakePve.configCalls[0]!.body).toEqual({ balloon: '1024' });
    });

    it('accepts each guest type up to its own cores cap', async () => {
      const cookie = await setupSession();
      fakePve.setVmPermissions(100, ALL_HW_PRIVS);
      fakePve.setVmPermissions(200, ALL_HW_PRIVS);
      const qemu = await patchHardware('/pve1/qemu/100', { cookie, payload: { cores: 1024 } });
      expect(qemu.statusCode).toBe(200);
      const lxc = await patchHardware('/pve1/lxc/200', { cookie, payload: { cores: 8192 } });
      expect(lxc.statusCode).toBe(200);
    });

    it('never forwards fields outside the allow-list (only the named keys reach PVE)', async () => {
      const cookie = await setupSession();
      fakePve.setVmPermissions(100, ALL_HW_PRIVS);
      await patchHardware('/pve1/qemu/100', { cookie, payload: { cores: 2 } });
      expect(Object.keys(fakePve.configCalls[0]!.body)).toEqual(['cores']);
    });
  });

  describe('pending derivation', () => {
    it('reports the changed keys PVE holds back in its pending list', async () => {
      const cookie = await setupSession();
      fakePve.setVmPermissions(100, ALL_HW_PRIVS);
      fakePve.setPending('qemu', 100, [
        { key: 'cores', value: '2', pending: '4' },
        { key: 'memory', value: '2048' },
        { key: 'sockets', value: '1', delete: 1 },
        { key: 'name', value: 'web' },
      ]);
      const res = await patchHardware('/pve1/qemu/100', {
        cookie,
        payload: { cores: 4, memory: 4096, sockets: 1 },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ ok: true, changed: ['cores', 'sockets', 'memory'], pending: ['cores', 'sockets'] });
    });

    it('does not report unrelated pending keys', async () => {
      const cookie = await setupSession();
      fakePve.setVmPermissions(100, ALL_HW_PRIVS);
      fakePve.setPending('qemu', 100, [{ key: 'net0', value: 'virtio', pending: 'e1000' }]);
      const res = await patchHardware('/pve1/qemu/100', { cookie, payload: { cores: 4 } });
      expect(res.json().pending).toEqual([]);
    });

    it('reports a pending lxc key', async () => {
      const cookie = await setupSession();
      fakePve.setVmPermissions(200, ALL_HW_PRIVS);
      fakePve.setPending('lxc', 200, [{ key: 'memory', value: '512', pending: '1024' }]);
      const res = await patchHardware('/pve1/lxc/200', { cookie, payload: { memory: 1024 } });
      expect(res.json()).toEqual({ ok: true, changed: ['memory'], pending: ['memory'] });
    });

    it('still succeeds with an empty pending list if the pending read fails', async () => {
      const cookie = await setupSession();
      fakePve.setVmPermissions(100, ALL_HW_PRIVS);
      fakePve.setPendingError('qemu', 100, 500);
      const res = await patchHardware('/pve1/qemu/100', { cookie, payload: { cores: 4 } });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ ok: true, changed: ['cores'], pending: [] });
    });
  });

  describe('hardware PVE errors', () => {
    it('surfaces PVE rejection detail (incl. the per-field errors map)', async () => {
      const cookie = await setupSession();
      fakePve.setVmPermissions(100, ALL_HW_PRIVS);
      fakePve.setConfigError('qemu', 100, 400, 'Parameter verification failed.', {
        cpu: 'unknown cpu model "nope"',
      });
      const res = await patchHardware('/pve1/qemu/100', { cookie, payload: { cpu: 'nope' } });
      expect(res.statusCode).toBe(400);
      const body = res.json();
      expect(body.error).toBe('pve-rejected');
      expect(body.message).toContain('Parameter verification failed.');
      expect(body.message).toContain('cpu: unknown cpu model "nope"');
    });

    it('maps a PVE 5xx to 502 pve-unreachable', async () => {
      const cookie = await setupSession();
      fakePve.setVmPermissions(100, ALL_HW_PRIVS);
      fakePve.setConfigError('qemu', 100, 500, 'boom');
      const res = await patchHardware('/pve1/qemu/100', { cookie, payload: { cores: 2 } });
      expect(res.statusCode).toBe(502);
      expect(res.json()).toEqual({ error: 'pve-unreachable' });
    });
  });

  describe('resize', () => {
    it('grows a qemu disk and returns 202 with the upid', async () => {
      const cookie = await setupSession();
      fakePve.setVmPermissions(100, ALL_HW_PRIVS);
      const res = await resize('/pve1/qemu/100', { cookie, payload: { disk: 'scsi0', size: '+10G' } });
      expect(res.statusCode).toBe(202);
      expect(res.json().upid).toMatch(/^UPID:/);
      expect(fakePve.resizeCalls).toEqual([
        { type: 'qemu', vmid: 100, body: { disk: 'scsi0', size: '+10G' } },
      ]);
    });

    it('grows an lxc rootfs and mount point', async () => {
      const cookie = await setupSession();
      fakePve.setVmPermissions(200, ALL_HW_PRIVS);
      const root = await resize('/pve1/lxc/200', { cookie, payload: { disk: 'rootfs', size: '+2.5G' } });
      expect(root.statusCode).toBe(202);
      const mp = await resize('/pve1/lxc/200', { cookie, payload: { disk: 'mp0', size: '+512M' } });
      expect(mp.statusCode).toBe(202);
      expect(fakePve.resizeCalls.map((c) => [c.type, c.body])).toEqual([
        ['lxc', { disk: 'rootfs', size: '+2.5G' }],
        ['lxc', { disk: 'mp0', size: '+512M' }],
      ]);
    });

    it('returns 200 { ok: true } when PVE returns no upid', async () => {
      const cookie = await setupSession();
      fakePve.setVmPermissions(100, ALL_HW_PRIVS);
      fakePve.setResizeReturnsUpid(false);
      const res = await resize('/pve1/qemu/100', { cookie, payload: { disk: 'virtio1', size: '+1T' } });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ ok: true });
    });

    it('needs VM.Config.Disk', async () => {
      const cookie = await setupSession();
      fakePve.setVmPermissions(100, { ...ALL_HW_PRIVS, 'VM.Config.Disk': false });
      const res = await resize('/pve1/qemu/100', { cookie, payload: { disk: 'scsi0', size: '+1G' } });
      expect(res.statusCode).toBe(403);
      expect(res.json()).toEqual({ error: 'forbidden', missing: 'VM.Config.Disk' });
      expect(fakePve.resizeCalls).toHaveLength(0);
    });

    it('does not accept another config privilege in place of VM.Config.Disk', async () => {
      const cookie = await setupSession();
      fakePve.setVmPermissions(100, { 'VM.Config.CPU': true, 'VM.Config.Memory': true, 'VM.Config.CDROM': true });
      const res = await resize('/pve1/qemu/100', { cookie, payload: { disk: 'scsi0', size: '+1G' } });
      expect(res.statusCode).toBe(403);
    });

    it('is grow-only by construction: the size needs the leading +', async () => {
      const cookie = await setupSession();
      fakePve.setVmPermissions(100, ALL_HW_PRIVS);
      for (const size of ['10G', '-5G', '+0G', '+G', '+10', '+10K', '+1e3G', '+10 G', '+10g', '++1G', '']) {
        const res = await resize('/pve1/qemu/100', { cookie, payload: { disk: 'scsi0', size } });
        expect(res.statusCode, `size ${JSON.stringify(size)}`).toBe(400);
      }
      expect(fakePve.resizeCalls).toHaveLength(0);
    });

    it('rejects disks outside the allow-list', async () => {
      const cookie = await setupSession();
      fakePve.setVmPermissions(100, ALL_HW_PRIVS);
      fakePve.setVmPermissions(200, ALL_HW_PRIVS);
      for (const disk of ['efidisk0', 'tpmstate0', 'unused0', 'scsi31', 'ide4', 'sata6', 'virtio16', 'net0', 'mp256', '']) {
        const res = await resize('/pve1/qemu/100', { cookie, payload: { disk, size: '+1G' } });
        expect(res.statusCode, `disk ${JSON.stringify(disk)}`).toBe(400);
      }
      const lxcUnused = await resize('/pve1/lxc/200', { cookie, payload: { disk: 'unused0', size: '+1G' } });
      expect(lxcUnused.statusCode).toBe(400);
      expect(fakePve.resizeCalls).toHaveLength(0);
    });

    it('rejects a disk that does not belong to the guest type', async () => {
      const cookie = await setupSession();
      fakePve.setVmPermissions(100, ALL_HW_PRIVS);
      fakePve.setVmPermissions(200, ALL_HW_PRIVS);
      const qemuRoot = await resize('/pve1/qemu/100', { cookie, payload: { disk: 'rootfs', size: '+1G' } });
      expect(qemuRoot.statusCode).toBe(400);
      expect(qemuRoot.json().error).toBe('invalid-disk-for-type');
      const lxcScsi = await resize('/pve1/lxc/200', { cookie, payload: { disk: 'scsi0', size: '+1G' } });
      expect(lxcScsi.statusCode).toBe(400);
      expect(lxcScsi.json().error).toBe('invalid-disk-for-type');
      expect(fakePve.resizeCalls).toHaveLength(0);
    });

    it('rejects unknown fields and a missing body', async () => {
      const cookie = await setupSession();
      fakePve.setVmPermissions(100, ALL_HW_PRIVS);
      const extra = await resize('/pve1/qemu/100', {
        cookie,
        payload: { disk: 'scsi0', size: '+1G', skiplock: true },
      });
      expect(extra.statusCode).toBe(400);
      const empty = await resize('/pve1/qemu/100', { cookie, payload: {} });
      expect(empty.statusCode).toBe(400);
    });

    it('surfaces PVE rejection detail', async () => {
      const cookie = await setupSession();
      fakePve.setVmPermissions(100, ALL_HW_PRIVS);
      fakePve.setResizeError('qemu', 100, 400, 'Parameter verification failed.', {
        size: 'shrinking disks is not supported',
      });
      const res = await resize('/pve1/qemu/100', { cookie, payload: { disk: 'scsi0', size: '+1G' } });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toBe('pve-rejected');
      expect(res.json().message).toContain('size: shrinking disks is not supported');
    });

    it('maps a PVE 5xx to 502', async () => {
      const cookie = await setupSession();
      fakePve.setVmPermissions(100, ALL_HW_PRIVS);
      fakePve.setResizeError('qemu', 100, 500, 'boom');
      const res = await resize('/pve1/qemu/100', { cookie, payload: { disk: 'scsi0', size: '+1G' } });
      expect(res.statusCode).toBe(502);
      expect(res.json()).toEqual({ error: 'pve-unreachable' });
    });
  });
});
