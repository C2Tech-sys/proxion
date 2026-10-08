import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance, InjectOptions } from 'fastify';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { startFakePve, type FakePve } from './helpers/fakePve.js';

const HW_TYPE = { 'VM.Config.HWType': true };
const DISK = { 'VM.Config.Disk': true };
const ALLOCATE = { 'Datastore.AllocateSpace': true };

describe('guest firmware routes (T72)', () => {
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

  function putFirmware(path: string, options: { cookie?: string; payload?: unknown } = {}) {
    const injectOptions: InjectOptions = { method: 'PUT', url: `/api/actions/guest${path}/firmware` };
    if (options.cookie !== undefined) injectOptions.headers = { cookie: options.cookie };
    if (options.payload !== undefined) injectOptions.payload = options.payload as NonNullable<InjectOptions['payload']>;
    return app.inject(injectOptions);
  }

  /** A session with every privilege this route can need already granted on guest 100. */
  async function setupAllowed(): Promise<string> {
    const cookie = await setupSession();
    fakePve.setVmPermissions(100, { ...HW_TYPE, ...DISK });
    fakePve.setStoragePermissions('local-lvm', ALLOCATE);
    return cookie;
  }

  describe('token mode and authentication', () => {
    it('403s in token mode without reaching PVE config', async () => {
      await setupTokenMode();
      const res = await putFirmware('/pve1/qemu/100', { payload: { bios: 'ovmf' } });
      expect(res.statusCode).toBe(403);
      expect(res.json()).toEqual({ error: 'writes-disabled-in-token-mode' });
      expect(fakePve.configCalls).toHaveLength(0);
      expect(fakePve.configGetCalls).toHaveLength(0);
    });

    it('401s without a session', async () => {
      await setupSession();
      const res = await putFirmware('/pve1/qemu/100', { payload: { bios: 'ovmf' } });
      expect(res.statusCode).toBe(401);
      expect(fakePve.configCalls).toHaveLength(0);
    });
  });

  describe('privileges', () => {
    it('bios/machine/vga/scsihw need VM.Config.HWType on the guest', async () => {
      const cookie = await setupSession();
      fakePve.setVmPermissions(100, { ...DISK, 'VM.Config.HWType': false });
      for (const payload of [
        { bios: 'ovmf' },
        { machine: { type: 'q35' } },
        { machine: null },
        { vga: { type: 'std' } },
        { vga: null },
        { scsihw: 'virtio-scsi-pci' },
      ]) {
        const res = await putFirmware('/pve1/qemu/100', { cookie, payload });
        expect(res.statusCode, JSON.stringify(payload)).toBe(403);
        expect(res.json()).toEqual({ error: 'forbidden', missing: 'VM.Config.HWType' });
      }
      expect(fakePve.configCalls).toHaveLength(0);
    });

    it('efidisk/tpmstate need VM.Config.Disk on the guest', async () => {
      const cookie = await setupSession();
      fakePve.setVmPermissions(100, { ...HW_TYPE, 'VM.Config.Disk': false });
      fakePve.setStoragePermissions('local-lvm', ALLOCATE);
      for (const payload of [
        { efidisk: { storage: 'local-lvm' } },
        { tpmstate: { storage: 'local-lvm', version: 'v2.0' } },
      ]) {
        const res = await putFirmware('/pve1/qemu/100', { cookie, payload });
        expect(res.statusCode).toBe(403);
        expect(res.json()).toEqual({ error: 'forbidden', missing: 'VM.Config.Disk' });
      }
      expect(fakePve.configCalls).toHaveLength(0);
      expect(fakePve.configGetCalls).toHaveLength(0);
    });

    it('efidisk/tpmstate need Datastore.AllocateSpace on the storage', async () => {
      const cookie = await setupSession();
      fakePve.setVmPermissions(100, { ...HW_TYPE, ...DISK });
      fakePve.setStoragePermissions('local-lvm', { 'Datastore.Audit': true });
      for (const payload of [
        { efidisk: { storage: 'local-lvm' } },
        { tpmstate: { storage: 'local-lvm', version: 'v1.2' } },
      ]) {
        const res = await putFirmware('/pve1/qemu/100', { cookie, payload });
        expect(res.statusCode).toBe(403);
        expect(res.json()).toEqual({ error: 'forbidden', missing: 'Datastore.AllocateSpace' });
      }
      expect(fakePve.configCalls).toHaveLength(0);
    });

    it('a HWType-only body does not need Disk or storage privileges', async () => {
      const cookie = await setupSession();
      fakePve.setVmPermissions(100, HW_TYPE);
      const res = await putFirmware('/pve1/qemu/100', { cookie, payload: { bios: 'seabios' } });
      expect(res.statusCode).toBe(200);
      expect(fakePve.configGetCalls).toHaveLength(0);
    });

    it('a Disk+storage-only body does not need HWType', async () => {
      const cookie = await setupSession();
      fakePve.setVmPermissions(100, DISK);
      fakePve.setStoragePermissions('local-lvm', ALLOCATE);
      const res = await putFirmware('/pve1/qemu/100', {
        cookie,
        payload: { tpmstate: { storage: 'local-lvm', version: 'v2.0' } },
      });
      expect(res.statusCode).toBe(200);
    });

    it('a combined bios+efidisk body needs HWType too, reported before Disk', async () => {
      const cookie = await setupSession();
      fakePve.setVmPermissions(100, {});
      fakePve.setStoragePermissions('local-lvm', ALLOCATE);
      const res = await putFirmware('/pve1/qemu/100', {
        cookie,
        payload: { bios: 'ovmf', efidisk: { storage: 'local-lvm' } },
      });
      expect(res.statusCode).toBe(403);
      expect(res.json()).toEqual({ error: 'forbidden', missing: 'VM.Config.HWType' });
      expect(fakePve.configCalls).toHaveLength(0);
    });
  });

  describe('validation (400)', () => {
    it('refuses an lxc guest with qemu-only', async () => {
      const cookie = await setupAllowed();
      fakePve.setVmPermissions(200, { ...HW_TYPE, ...DISK });
      const res = await putFirmware('/pve1/lxc/200', { cookie, payload: { bios: 'ovmf' } });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toBe('qemu-only');
      expect(fakePve.configCalls).toHaveLength(0);
    });

    it('refuses an empty body and unknown fields', async () => {
      const cookie = await setupAllowed();
      expect((await putFirmware('/pve1/qemu/100', { cookie, payload: {} })).statusCode).toBe(400);
      expect((await putFirmware('/pve1/qemu/100', { cookie, payload: { digest: 'abc' } })).statusCode).toBe(400);
      expect(
        (await putFirmware('/pve1/qemu/100', { cookie, payload: { bios: 'ovmf', skiplock: true } })).statusCode,
      ).toBe(400);
      expect(fakePve.configCalls).toHaveLength(0);
    });

    it('refuses out-of-list values and malformed nested fields', async () => {
      const cookie = await setupAllowed();
      const bad: unknown[] = [
        { bios: 'coreboot' },
        { scsihw: 'nvme' },
        { machine: { type: 'q35', version: '8.1,foo=1' } },
        { machine: { type: 'q35', version: 'latest' } },
        { machine: { type: 'i440fx', viommu: 'intel' } },
        { machine: { type: 'q35', viommu: 'amd' } },
        { machine: { type: 'arm' } },
        { vga: { type: 'qxl5' } },
        { vga: { type: 'virtio', memory: 3 } },
        { vga: { type: 'virtio', memory: 513 } },
        { vga: { type: 'virtio', memory: 32.5 } },
        { efidisk: { storage: 'local-lvm,import-from=x' } },
        { efidisk: { storage: 'local-lvm', efitype: '8m' } },
        { efidisk: {} },
        { tpmstate: { storage: 'local-lvm' } },
        { tpmstate: { storage: 'local-lvm', version: 'v3.0' } },
      ];
      for (const payload of bad) {
        const res = await putFirmware('/pve1/qemu/100', { cookie, payload });
        expect(res.statusCode, JSON.stringify(payload)).toBe(400);
      }
      expect(fakePve.configCalls).toHaveLength(0);
    });
  });

  describe('PVE parameter mapping', () => {
    it('maps bios', async () => {
      const cookie = await setupAllowed();
      const res = await putFirmware('/pve1/qemu/100', { cookie, payload: { bios: 'ovmf' } });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ ok: true, changed: ['bios'], pending: [] });
      expect(fakePve.configCalls).toHaveLength(1);
      expect(fakePve.configCalls[0]!.path).toContain('/nodes/pve1/qemu/100/config');
      expect(fakePve.configCalls[0]!.body).toEqual({ bios: 'ovmf' });
    });

    it('maps a pinned q35 machine with vIOMMU', async () => {
      const cookie = await setupAllowed();
      const res = await putFirmware('/pve1/qemu/100', {
        cookie,
        payload: { machine: { type: 'q35', version: '8.1', viommu: 'intel' } },
      });
      expect(res.statusCode).toBe(200);
      expect(fakePve.configCalls[0]!.body).toEqual({ machine: 'pc-q35-8.1,viommu=intel' });
    });

    it('maps an unpinned q35, a pinned i440fx and an unpinned i440fx', async () => {
      const cookie = await setupAllowed();
      await putFirmware('/pve1/qemu/100', { cookie, payload: { machine: { type: 'q35' } } });
      await putFirmware('/pve1/qemu/100', { cookie, payload: { machine: { type: 'i440fx', version: '9.0+pve1' } } });
      await putFirmware('/pve1/qemu/100', { cookie, payload: { machine: { type: 'i440fx' } } });
      expect(fakePve.configCalls.map((c) => c.body)).toEqual([
        { machine: 'q35' },
        { machine: 'pc-i440fx-9.0+pve1' },
        { machine: 'pc' },
      ]);
    });

    it('maps machine null to a delete of the key', async () => {
      const cookie = await setupAllowed();
      const res = await putFirmware('/pve1/qemu/100', { cookie, payload: { machine: null } });
      expect(res.statusCode).toBe(200);
      expect(res.json().changed).toEqual(['machine']);
      expect(fakePve.configCalls[0]!.body).toEqual({ delete: 'machine' });
    });

    it('maps vga with memory, without memory, and null', async () => {
      const cookie = await setupAllowed();
      await putFirmware('/pve1/qemu/100', { cookie, payload: { vga: { type: 'virtio', memory: 32 } } });
      await putFirmware('/pve1/qemu/100', { cookie, payload: { vga: { type: 'serial0' } } });
      await putFirmware('/pve1/qemu/100', { cookie, payload: { vga: null } });
      expect(fakePve.configCalls.map((c) => c.body)).toEqual([
        { vga: 'virtio,memory=32' },
        { vga: 'serial0' },
        { delete: 'vga' },
      ]);
    });

    it('joins several deletes into one comma list', async () => {
      const cookie = await setupAllowed();
      await putFirmware('/pve1/qemu/100', { cookie, payload: { machine: null, vga: null } });
      expect(fakePve.configCalls[0]!.body).toEqual({ delete: 'machine,vga' });
    });

    it('maps scsihw', async () => {
      const cookie = await setupAllowed();
      const res = await putFirmware('/pve1/qemu/100', { cookie, payload: { scsihw: 'virtio-scsi-single' } });
      expect(res.statusCode).toBe(200);
      expect(fakePve.configCalls[0]!.body).toEqual({ scsihw: 'virtio-scsi-single' });
    });

    it('maps an efidisk with defaults and with explicit options', async () => {
      const cookie = await setupAllowed();
      const first = await putFirmware('/pve1/qemu/100', {
        cookie,
        payload: { efidisk: { storage: 'local-lvm' } },
      });
      expect(first.statusCode).toBe(200);
      expect(first.json()).toEqual({ ok: true, changed: ['efidisk0'], pending: [] });
      const second = await putFirmware('/pve1/qemu/100', {
        cookie,
        payload: { efidisk: { storage: 'local-lvm', efitype: '2m', preEnrolledKeys: false } },
      });
      expect(second.statusCode).toBe(200);
      expect(fakePve.configCalls.map((c) => c.body)).toEqual([
        { efidisk0: 'local-lvm:1,efitype=4m,pre-enrolled-keys=1' },
        { efidisk0: 'local-lvm:1,efitype=2m,pre-enrolled-keys=0' },
      ]);
    });

    it('maps a tpmstate', async () => {
      const cookie = await setupAllowed();
      const res = await putFirmware('/pve1/qemu/100', {
        cookie,
        payload: { tpmstate: { storage: 'local-lvm', version: 'v2.0' } },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ ok: true, changed: ['tpmstate0'], pending: [] });
      expect(fakePve.configCalls[0]!.body).toEqual({ tpmstate0: 'local-lvm:1,version=v2.0' });
    });

    it('applies bios + efidisk in ONE config PUT', async () => {
      const cookie = await setupAllowed();
      const res = await putFirmware('/pve1/qemu/100', {
        cookie,
        payload: { bios: 'ovmf', efidisk: { storage: 'local-lvm' } },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().changed).toEqual(['bios', 'efidisk0']);
      expect(fakePve.configCalls).toHaveLength(1);
      expect(fakePve.configCalls[0]!.body).toEqual({
        bios: 'ovmf',
        efidisk0: 'local-lvm:1,efitype=4m,pre-enrolled-keys=1',
      });
    });

    it('forwards the digest', async () => {
      const cookie = await setupAllowed();
      const digest = 'a'.repeat(40);
      await putFirmware('/pve1/qemu/100', { cookie, payload: { bios: 'ovmf', digest } });
      expect(fakePve.configCalls[0]!.body).toEqual({ bios: 'ovmf', digest });
    });
  });

  describe('already-present', () => {
    it('refuses an efidisk when efidisk0 exists, without any PUT', async () => {
      const cookie = await setupAllowed();
      fakePve.setGuestConfig('qemu', 100, { efidisk0: 'local-lvm:vm-100-disk-1,efitype=4m,size=4M' });
      const res = await putFirmware('/pve1/qemu/100', { cookie, payload: { efidisk: { storage: 'local-lvm' } } });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toBe('already-present');
      expect(fakePve.configGetCalls).toHaveLength(1);
      expect(fakePve.configCalls).toHaveLength(0);
    });

    it('refuses a tpmstate when tpmstate0 exists, without any PUT', async () => {
      const cookie = await setupAllowed();
      fakePve.setGuestConfig('qemu', 100, { tpmstate0: 'local-lvm:vm-100-disk-2,size=4M,version=v2.0' });
      const res = await putFirmware('/pve1/qemu/100', {
        cookie,
        payload: { tpmstate: { storage: 'local-lvm', version: 'v2.0' } },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toBe('already-present');
      expect(fakePve.configCalls).toHaveLength(0);
    });

    it('refuses the whole combined request when either disk exists', async () => {
      const cookie = await setupAllowed();
      fakePve.setGuestConfig('qemu', 100, { efidisk0: 'local-lvm:vm-100-disk-1,efitype=4m,size=4M' });
      const res = await putFirmware('/pve1/qemu/100', {
        cookie,
        payload: { bios: 'ovmf', efidisk: { storage: 'local-lvm' } },
      });
      expect(res.statusCode).toBe(400);
      expect(fakePve.configCalls).toHaveLength(0);
    });
  });

  describe('pending and PVE errors', () => {
    it('lists the changed keys PVE holds back, including a pending delete', async () => {
      const cookie = await setupAllowed();
      fakePve.setPending('qemu', 100, [
        { key: 'bios', value: 'seabios', pending: 'ovmf' },
        { key: 'machine', value: 'q35', delete: 1 },
        { key: 'scsihw', value: 'lsi' },
        { key: 'net0', value: 'virtio', pending: 'e1000' },
      ]);
      const res = await putFirmware('/pve1/qemu/100', {
        cookie,
        payload: { bios: 'ovmf', machine: null, scsihw: 'pvscsi' },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ ok: true, changed: ['bios', 'machine', 'scsihw'], pending: ['bios', 'machine'] });
    });

    it('still succeeds with an empty pending list if the pending read fails', async () => {
      const cookie = await setupAllowed();
      fakePve.setPendingError('qemu', 100, 500);
      const res = await putFirmware('/pve1/qemu/100', { cookie, payload: { bios: 'ovmf' } });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ ok: true, changed: ['bios'], pending: [] });
    });

    it('maps a PVE 4xx to pve-rejected with the sanitized message', async () => {
      const cookie = await setupAllowed();
      fakePve.setConfigError('qemu', 100, 400, 'Parameter verification failed.', {
        machine: 'unknown machine type',
      });
      const res = await putFirmware('/pve1/qemu/100', {
        cookie,
        payload: { machine: { type: 'q35', version: '1.0' } },
      });
      expect(res.statusCode).toBe(400);
      const json = res.json();
      expect(json.error).toBe('pve-rejected');
      expect(json.message).toContain('Parameter verification failed.');
    });

    it('maps a PVE 5xx to 502 pve-unreachable', async () => {
      const cookie = await setupAllowed();
      fakePve.setConfigError('qemu', 100, 500, 'boom');
      const res = await putFirmware('/pve1/qemu/100', { cookie, payload: { bios: 'ovmf' } });
      expect(res.statusCode).toBe(502);
      expect(res.json()).toEqual({ error: 'pve-unreachable' });
    });
  });
});
