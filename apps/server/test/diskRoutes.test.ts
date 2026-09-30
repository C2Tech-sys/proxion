import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance, InjectOptions } from 'fastify';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { startFakePve, type FakePve } from './helpers/fakePve.js';

const GUEST_PRIVS = { 'VM.Config.Disk': true };

describe('guest disk routes (T52)', () => {
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
    method: 'POST' | 'DELETE',
    path: string,
    options: { cookie?: string; payload?: unknown } = {},
  ) {
    const injectOptions: InjectOptions = { method, url: `/api/actions/guest${path}` };
    if (options.cookie !== undefined) injectOptions.headers = { cookie: options.cookie };
    if (options.payload !== undefined) injectOptions.payload = options.payload as NonNullable<InjectOptions['payload']>;
    return app.inject(injectOptions);
  }

  const addDisk = (path: string, options: { cookie?: string; payload?: unknown } = {}) =>
    call('POST', `${path}/disks`, options);
  const detach = (path: string, slot: string, cookie?: string) =>
    call('POST', `${path}/disks/${slot}/detach`, cookie !== undefined ? { cookie } : {});
  const removeUnused = (path: string, slot: string, cookie?: string) =>
    call('DELETE', `${path}/disks/${slot}`, cookie !== undefined ? { cookie } : {});

  /** A session whose user holds the disk privileges on vm 100 (qemu) / 200 (lxc) and can allocate
   * on `local-lvm` and `local`. */
  async function setupAllowed(): Promise<string> {
    const cookie = await setupSession();
    fakePve.setVmPermissions(100, GUEST_PRIVS);
    fakePve.setVmPermissions(200, GUEST_PRIVS);
    fakePve.setStoragePermissions('local-lvm', { 'Datastore.AllocateSpace': true });
    fakePve.setStoragePermissions('local', { 'Datastore.AllocateSpace': true });
    return cookie;
  }

  const QEMU_ADD = { bus: 'scsi', storage: 'local-lvm', sizeGiB: 32 };

  describe('token mode', () => {
    it('add, detach and remove all 403 without reaching PVE config', async () => {
      await setupTokenMode();
      const add = await addDisk('/pve1/qemu/100', { payload: QEMU_ADD });
      expect(add.statusCode).toBe(403);
      expect(add.json()).toEqual({ error: 'writes-disabled-in-token-mode' });
      const det = await detach('/pve1/qemu/100', 'scsi1');
      expect(det.statusCode).toBe(403);
      expect(det.json()).toEqual({ error: 'writes-disabled-in-token-mode' });
      const rem = await removeUnused('/pve1/qemu/100', 'unused0');
      expect(rem.statusCode).toBe(403);
      expect(rem.json()).toEqual({ error: 'writes-disabled-in-token-mode' });
      expect(fakePve.configCalls).toHaveLength(0);
    });
  });

  describe('authentication', () => {
    it('401s without a session', async () => {
      await setupSession();
      expect((await addDisk('/pve1/qemu/100', { payload: QEMU_ADD })).statusCode).toBe(401);
      expect((await detach('/pve1/qemu/100', 'scsi1')).statusCode).toBe(401);
      expect((await removeUnused('/pve1/qemu/100', 'unused0')).statusCode).toBe(401);
    });
  });

  describe('privileges', () => {
    it('add needs VM.Config.Disk on the guest', async () => {
      const cookie = await setupSession();
      fakePve.setVmPermissions(100, { 'VM.Config.Disk': false });
      fakePve.setStoragePermissions('local-lvm', { 'Datastore.AllocateSpace': true });
      const res = await addDisk('/pve1/qemu/100', { cookie, payload: QEMU_ADD });
      expect(res.statusCode).toBe(403);
      expect(res.json()).toEqual({ error: 'forbidden', missing: 'VM.Config.Disk' });
      expect(fakePve.configCalls).toHaveLength(0);
    });

    it('add needs Datastore.AllocateSpace on the storage', async () => {
      const cookie = await setupSession();
      fakePve.setVmPermissions(100, GUEST_PRIVS);
      // No storage permissions at all, then the wrong privilege.
      const none = await addDisk('/pve1/qemu/100', { cookie, payload: QEMU_ADD });
      expect(none.statusCode).toBe(403);
      expect(none.json()).toEqual({ error: 'forbidden', missing: 'Datastore.AllocateSpace' });
      fakePve.setStoragePermissions('local-lvm', { 'Datastore.Audit': true });
      const wrong = await addDisk('/pve1/qemu/100', { cookie, payload: QEMU_ADD });
      expect(wrong.statusCode).toBe(403);
      expect(fakePve.configCalls).toHaveLength(0);

      fakePve.setStoragePermissions('local-lvm', { 'Datastore.AllocateSpace': true });
      const ok = await addDisk('/pve1/qemu/100', { cookie, payload: QEMU_ADD });
      expect(ok.statusCode).toBe(200);
    });

    it('the storage privilege is checked on the requested storage, not another one', async () => {
      const cookie = await setupSession();
      fakePve.setVmPermissions(100, GUEST_PRIVS);
      fakePve.setStoragePermissions('other', { 'Datastore.AllocateSpace': true });
      const res = await addDisk('/pve1/qemu/100', { cookie, payload: QEMU_ADD });
      expect(res.statusCode).toBe(403);
      expect(res.json()).toEqual({ error: 'forbidden', missing: 'Datastore.AllocateSpace' });
    });

    it('detach needs VM.Config.Disk', async () => {
      const cookie = await setupSession();
      fakePve.setVmPermissions(100, { 'VM.Config.Disk': false });
      fakePve.setGuestConfig('qemu', 100, { scsi1: 'local-lvm:vm-100-disk-1,size=16G' });
      const res = await detach('/pve1/qemu/100', 'scsi1', cookie);
      expect(res.statusCode).toBe(403);
      expect(res.json()).toEqual({ error: 'forbidden', missing: 'VM.Config.Disk' });
      expect(fakePve.configCalls).toHaveLength(0);
    });

    it('remove-unused needs VM.Config.Disk', async () => {
      const cookie = await setupSession();
      fakePve.setVmPermissions(100, { 'VM.Config.Disk': false });
      fakePve.setGuestConfig('qemu', 100, { unused0: 'local-lvm:vm-100-disk-1' });
      const res = await removeUnused('/pve1/qemu/100', 'unused0', cookie);
      expect(res.statusCode).toBe(403);
      expect(res.json()).toEqual({ error: 'forbidden', missing: 'VM.Config.Disk' });
      expect(fakePve.configCalls).toHaveLength(0);
    });
  });

  describe('add: validation', () => {
    it('rejects bad qemu bodies without reaching PVE', async () => {
      const cookie = await setupAllowed();
      const bad: Array<[string, unknown]> = [
        ['unknown bus', { ...QEMU_ADD, bus: 'nvme' }],
        ['missing bus', { storage: 'local-lvm', sizeGiB: 32 }],
        ['size 0', { ...QEMU_ADD, sizeGiB: 0 }],
        ['size above range', { ...QEMU_ADD, sizeGiB: 65537 }],
        ['fractional size', { ...QEMU_ADD, sizeGiB: 1.5 }],
        ['string size', { ...QEMU_ADD, sizeGiB: '32' }],
        ['unknown format', { ...QEMU_ADD, format: 'vdi' }],
        ['unknown cache', { ...QEMU_ADD, cache: 'fast' }],
        ['storage with a comma', { ...QEMU_ADD, storage: 'local-lvm,media=cdrom' }],
        ['storage with a colon', { ...QEMU_ADD, storage: 'a:b' }],
        ['missing storage', { bus: 'scsi', sizeGiB: 32 }],
        ['unknown field', { ...QEMU_ADD, rootfs: 'x' }],
        ['non-boolean flag', { ...QEMU_ADD, discard: 'yes' }],
      ];
      for (const [label, payload] of bad) {
        const res = await addDisk('/pve1/qemu/100', { cookie, payload });
        expect(res.statusCode, label).toBe(400);
      }
      expect(fakePve.configCalls).toHaveLength(0);
    });

    it('rejects bad lxc bodies and enforces the mount point path', async () => {
      const cookie = await setupAllowed();
      const base = { storage: 'local', sizeGiB: 8 };
      const bad: Array<[string, unknown]> = [
        ['missing mount point', base],
        ['relative path', { ...base, mountPoint: 'data' }],
        ['traversal', { ...base, mountPoint: '/data/../etc' }],
        ['traversal at the end', { ...base, mountPoint: '/..' }],
        ['comma in path', { ...base, mountPoint: '/data,ro=0' }],
        ['space in path', { ...base, mountPoint: '/my data' }],
        ['path too long', { ...base, mountPoint: `/${'a'.repeat(201)}` }],
        ['unknown field', { ...base, mountPoint: '/data', mp: '/x' }],
      ];
      for (const [label, payload] of bad) {
        const res = await addDisk('/pve2/lxc/200', { cookie, payload });
        expect(res.statusCode, label).toBe(400);
      }
      expect(fakePve.configCalls).toHaveLength(0);
    });

    it('refuses fields that belong to the other guest type', async () => {
      const cookie = await setupAllowed();
      const lxcFieldOnQemu = await addDisk('/pve1/qemu/100', { cookie, payload: { ...QEMU_ADD, mountPoint: '/data' } });
      expect(lxcFieldOnQemu.statusCode).toBe(400);
      expect(lxcFieldOnQemu.json()).toMatchObject({ error: 'invalid-field-for-type' });
      const readOnlyOnQemu = await addDisk('/pve1/qemu/100', { cookie, payload: { ...QEMU_ADD, readOnly: true } });
      expect(readOnlyOnQemu.statusCode).toBe(400);

      const qemuFieldOnLxc = await addDisk('/pve2/lxc/200', {
        cookie,
        payload: { storage: 'local', sizeGiB: 8, mountPoint: '/data', bus: 'scsi' },
      });
      expect(qemuFieldOnLxc.statusCode).toBe(400);
      expect(qemuFieldOnLxc.json()).toMatchObject({ error: 'invalid-field-for-type' });
      for (const extra of [{ cache: 'none' }, { discard: true }, { ssd: true }, { iothread: true }, { format: 'raw' }]) {
        const res = await addDisk('/pve2/lxc/200', {
          cookie,
          payload: { storage: 'local', sizeGiB: 8, mountPoint: '/data', ...extra },
        });
        expect(res.statusCode).toBe(400);
      }
      expect(fakePve.configCalls).toHaveLength(0);
    });

    it('refuses options the bus cannot take (ssd on virtio, iothread on ide/sata)', async () => {
      const cookie = await setupAllowed();
      const ssd = await addDisk('/pve1/qemu/100', { cookie, payload: { ...QEMU_ADD, bus: 'virtio', ssd: true } });
      expect(ssd.statusCode).toBe(400);
      expect(ssd.json()).toMatchObject({ error: 'invalid-option-for-bus' });
      for (const bus of ['ide', 'sata']) {
        const res = await addDisk('/pve1/qemu/100', { cookie, payload: { ...QEMU_ADD, bus, iothread: true } });
        expect(res.statusCode).toBe(400);
      }
      expect(fakePve.configCalls).toHaveLength(0);
    });

    it('400s on an invalid node/type/vmid', async () => {
      const cookie = await setupAllowed();
      expect((await addDisk('/pve1/bsd/100', { cookie, payload: QEMU_ADD })).statusCode).toBe(400);
      expect((await addDisk('/pve1/qemu/abc', { cookie, payload: QEMU_ADD })).statusCode).toBe(400);
    });
  });

  describe('add: slot selection', () => {
    it('picks the lowest free slot, filling gaps', async () => {
      const cookie = await setupAllowed();
      fakePve.setGuestConfig('qemu', 100, {
        scsi0: 'local-lvm:vm-100-disk-0,size=32G',
        scsi1: 'local-lvm:vm-100-disk-1,size=8G',
        scsi3: 'local-lvm:vm-100-disk-3,size=8G',
        ide2: 'local:iso/x.iso,media=cdrom',
      });
      const res = await addDisk('/pve1/qemu/100', { cookie, payload: QEMU_ADD });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ ok: true, slot: 'scsi2' });
      expect(Object.keys(fakePve.configCalls[0]!.body)).toContain('scsi2');
    });

    it('a CD-ROM occupies its ide slot', async () => {
      const cookie = await setupAllowed();
      fakePve.setGuestConfig('qemu', 100, {
        ide0: 'local-lvm:vm-100-disk-0,size=8G',
        ide2: 'local:iso/x.iso,media=cdrom',
      });
      const res = await addDisk('/pve1/qemu/100', { cookie, payload: { ...QEMU_ADD, bus: 'ide' } });
      expect(res.json()).toMatchObject({ slot: 'ide1' });
    });

    it('starts at 0 on an empty bus and ignores other buses', async () => {
      const cookie = await setupAllowed();
      fakePve.setGuestConfig('qemu', 100, { scsi0: 'local-lvm:vm-100-disk-0,size=8G' });
      const res = await addDisk('/pve1/qemu/100', { cookie, payload: { ...QEMU_ADD, bus: 'virtio' } });
      expect(res.json()).toMatchObject({ slot: 'virtio0' });
    });

    it.each([
      ['ide', 4],
      ['sata', 6],
      ['virtio', 16],
      ['scsi', 31],
    ])('refuses a full %s bus (%i slots) with bus-full', async (bus, count) => {
      const cookie = await setupAllowed();
      const config: Record<string, string> = {};
      for (let n = 0; n < count; n++) config[`${bus}${n}`] = `local-lvm:vm-100-disk-${n},size=1G`;
      fakePve.setGuestConfig('qemu', 100, config);
      const res = await addDisk('/pve1/qemu/100', { cookie, payload: { ...QEMU_ADD, bus } });
      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({ error: 'bus-full' });
      expect(fakePve.configCalls).toHaveLength(0);
    });

    it('the last free slot of a bus is still usable', async () => {
      const cookie = await setupAllowed();
      const config: Record<string, string> = {};
      for (let n = 0; n < 31; n++) if (n !== 30) config[`scsi${n}`] = `local-lvm:vm-100-disk-${n},size=1G`;
      fakePve.setGuestConfig('qemu', 100, config);
      const res = await addDisk('/pve1/qemu/100', { cookie, payload: QEMU_ADD });
      expect(res.json()).toMatchObject({ slot: 'scsi30' });
    });

    it('lxc picks the next free mp slot', async () => {
      const cookie = await setupAllowed();
      fakePve.setGuestConfig('lxc', 200, {
        rootfs: 'local:200/vm-200-disk-0.raw,size=8G',
        mp0: 'local:200/vm-200-disk-1.raw,mp=/a,size=1G',
      });
      const res = await addDisk('/pve2/lxc/200', {
        cookie,
        payload: { storage: 'local', sizeGiB: 8, mountPoint: '/data' },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ slot: 'mp1' });
    });

    it('lxc refuses when all 256 mount points are taken', async () => {
      const cookie = await setupAllowed();
      const config: Record<string, string> = {};
      for (let n = 0; n < 256; n++) config[`mp${n}`] = `local:200/vm-200-disk-${n}.raw,mp=/m${n},size=1G`;
      fakePve.setGuestConfig('lxc', 200, config);
      const res = await addDisk('/pve2/lxc/200', {
        cookie,
        payload: { storage: 'local', sizeGiB: 8, mountPoint: '/data' },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({ error: 'bus-full' });
    });
  });

  describe('add: PVE value composition', () => {
    it('qemu: format omitted unless given, discard/ssd/iothread only when true, backup always', async () => {
      const cookie = await setupAllowed();
      fakePve.setGuestConfig('qemu', 100, {
        scsi0: 'local-lvm:vm-100-disk-0,size=32G',
        scsi1: 'local-lvm:vm-100-disk-1,size=8G',
      });
      const res = await addDisk('/pve1/qemu/100', {
        cookie,
        payload: { bus: 'scsi', storage: 'local-lvm', sizeGiB: 32, discard: true, ssd: true, iothread: true },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ ok: true, slot: 'scsi2', pending: [] });
      expect(fakePve.configCalls).toHaveLength(1);
      expect(fakePve.configCalls[0]!.path).toContain('/nodes/pve1/qemu/100/config');
      expect(fakePve.configCalls[0]!.body).toEqual({
        scsi2: 'local-lvm:32,discard=on,ssd=1,iothread=1,backup=1',
      });
    });

    it('qemu: every option in order, format and cache included, backup off', async () => {
      const cookie = await setupAllowed();
      fakePve.setGuestConfig('qemu', 100, {});
      const res = await addDisk('/pve1/qemu/100', {
        cookie,
        payload: {
          bus: 'virtio',
          storage: 'local',
          sizeGiB: 100,
          format: 'qcow2',
          discard: true,
          iothread: true,
          cache: 'writeback',
          backup: false,
        },
      });
      expect(res.statusCode).toBe(200);
      expect(fakePve.configCalls[0]!.body).toEqual({
        virtio0: 'local:100,format=qcow2,discard=on,iothread=1,cache=writeback,backup=0',
      });
    });

    it('qemu: a minimal body still carries backup=1', async () => {
      const cookie = await setupAllowed();
      const res = await addDisk('/pve1/qemu/100', { cookie, payload: { bus: 'sata', storage: 'local-lvm', sizeGiB: 1 } });
      expect(res.statusCode).toBe(200);
      expect(fakePve.configCalls[0]!.body).toEqual({ sata0: 'local-lvm:1,backup=1' });
    });

    it('lxc: mount point with backup, and optional acl/ro', async () => {
      const cookie = await setupAllowed();
      fakePve.setGuestConfig('lxc', 200, {
        rootfs: 'local:200/vm-200-disk-0.raw,size=8G',
        mp0: 'local:200/vm-200-disk-1.raw,mp=/a,size=1G',
      });
      const plain = await addDisk('/pve2/lxc/200', {
        cookie,
        payload: { storage: 'local', sizeGiB: 8, mountPoint: '/data' },
      });
      expect(plain.statusCode).toBe(200);
      expect(plain.json()).toEqual({ ok: true, slot: 'mp1', pending: [] });
      expect(fakePve.configCalls[0]!.path).toContain('/nodes/pve2/lxc/200/config');
      expect(fakePve.configCalls[0]!.body).toEqual({ mp1: 'local:8,mp=/data,backup=1' });

      const full = await addDisk('/pve2/lxc/200', {
        cookie,
        payload: { storage: 'local', sizeGiB: 4, mountPoint: '/srv/x', backup: false, readOnly: true, acl: true },
      });
      expect(full.statusCode).toBe(200);
      expect(fakePve.configCalls[1]!.body).toEqual({ mp1: 'local:4,mp=/srv/x,backup=0,acl=1,ro=1' });
    });

    it('reports a pending add PVE is holding back', async () => {
      const cookie = await setupAllowed();
      fakePve.setGuestConfig('qemu', 100, {});
      fakePve.setPending('qemu', 100, [{ key: 'scsi0', pending: 'local-lvm:vm-100-disk-0,size=1G' }]);
      const res = await addDisk('/pve1/qemu/100', { cookie, payload: QEMU_ADD });
      expect(res.json()).toEqual({ ok: true, slot: 'scsi0', pending: ['scsi0'] });
    });

    it('a failing pending read does not fail the applied add', async () => {
      const cookie = await setupAllowed();
      fakePve.setGuestConfig('qemu', 100, {});
      fakePve.setPendingError('qemu', 100, 500);
      const res = await addDisk('/pve1/qemu/100', { cookie, payload: QEMU_ADD });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ ok: true, slot: 'scsi0', pending: [] });
    });
  });

  describe('detach', () => {
    it('maps to delete=<slot> and returns the unused slot PVE parked the volume in', async () => {
      const cookie = await setupAllowed();
      // The fake's config is static, so it already shows the post-detach state next to the disk.
      fakePve.setGuestConfig('qemu', 100, {
        scsi0: 'local-lvm:vm-100-disk-0,size=32G',
        scsi1: 'local-lvm:vm-100-disk-1,size=16G',
        unused0: 'local-lvm:vm-100-disk-1',
      });
      const res = await detach('/pve1/qemu/100', 'scsi1', cookie);
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ ok: true, unusedSlot: 'unused0', pending: [] });
      expect(fakePve.configCalls).toHaveLength(1);
      expect(fakePve.configCalls[0]!.path).toContain('/nodes/pve1/qemu/100/config');
      expect(fakePve.configCalls[0]!.body).toEqual({ delete: 'scsi1' });
    });

    it('matches the detached volume, not just any unused slot', async () => {
      const cookie = await setupAllowed();
      fakePve.setGuestConfig('qemu', 100, {
        scsi1: 'local-lvm:vm-100-disk-1,size=16G',
        unused0: 'local-lvm:vm-100-disk-9',
        unused1: 'local-lvm:vm-100-disk-1',
      });
      const res = await detach('/pve1/qemu/100', 'scsi1', cookie);
      expect(res.json()).toMatchObject({ unusedSlot: 'unused1' });
    });

    it('omits unusedSlot when none can be found', async () => {
      const cookie = await setupAllowed();
      fakePve.setGuestConfig('qemu', 100, { scsi1: 'local-lvm:vm-100-disk-1,size=16G' });
      const res = await detach('/pve1/qemu/100', 'scsi1', cookie);
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ ok: true, pending: [] });
    });

    it('detaches a lxc mount point', async () => {
      const cookie = await setupAllowed();
      fakePve.setGuestConfig('lxc', 200, {
        rootfs: 'local:200/vm-200-disk-0.raw,size=8G',
        mp0: 'tank:subvol-200-disk-1,mp=/data,size=16G',
        unused0: 'tank:subvol-200-disk-1',
      });
      const res = await detach('/pve2/lxc/200', 'mp0', cookie);
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ ok: true, unusedSlot: 'unused0' });
      expect(fakePve.configCalls[0]!.path).toContain('/nodes/pve2/lxc/200/config');
      expect(fakePve.configCalls[0]!.body).toEqual({ delete: 'mp0' });
    });

    it('reports a detach PVE holds back (hot-unplug not possible)', async () => {
      const cookie = await setupAllowed();
      fakePve.setGuestConfig('qemu', 100, { virtio1: 'local-lvm:vm-100-disk-1,size=16G' });
      fakePve.setPending('qemu', 100, [{ key: 'virtio1', value: 'local-lvm:vm-100-disk-1,size=16G', delete: 1 }]);
      const res = await detach('/pve1/qemu/100', 'virtio1', cookie);
      expect(res.json()).toMatchObject({ ok: true, pending: ['virtio1'] });
    });

    it('404s when the slot is absent', async () => {
      const cookie = await setupAllowed();
      fakePve.setGuestConfig('qemu', 100, { scsi0: 'local-lvm:vm-100-disk-0,size=32G' });
      const res = await detach('/pve1/qemu/100', 'scsi5', cookie);
      expect(res.statusCode).toBe(404);
      expect(fakePve.configCalls).toHaveLength(0);
    });

    it('refuses slots that are not detachable disks', async () => {
      const cookie = await setupAllowed();
      fakePve.setGuestConfig('qemu', 100, {
        ide2: 'local:iso/x.iso,media=cdrom',
        efidisk0: 'local-lvm:vm-100-disk-2,size=4M',
        unused0: 'local-lvm:vm-100-disk-1',
        scsi0: 'local-lvm:vm-100-disk-0,size=32G',
      });
      for (const slot of ['rootfs', 'efidisk0', 'tpmstate0', 'unused0', 'mp0', 'scsi31', 'virtio16', 'net0', 'scsi00']) {
        const res = await detach('/pve1/qemu/100', slot, cookie);
        expect(res.statusCode, slot).toBe(400);
      }
      // A CD-ROM is present but is not a disk.
      const cdrom = await detach('/pve1/qemu/100', 'ide2', cookie);
      expect(cdrom.statusCode).toBe(400);
      expect(cdrom.json()).toMatchObject({ error: 'not-a-disk' });
      // lxc: only mount points, never rootfs or a qemu bus.
      for (const slot of ['rootfs', 'scsi0', 'unused0']) {
        const res = await detach('/pve2/lxc/200', slot, cookie);
        expect(res.statusCode, slot).toBe(400);
      }
      expect(fakePve.configCalls).toHaveLength(0);
    });

    it('relays PVE rejections with their detail', async () => {
      const cookie = await setupAllowed();
      fakePve.setGuestConfig('qemu', 100, { scsi1: 'local-lvm:vm-100-disk-1,size=16G' });
      fakePve.setConfigError('qemu', 100, 400, 'Parameter verification failed.', { delete: 'disk is locked' });
      const res = await detach('/pve1/qemu/100', 'scsi1', cookie);
      expect(res.statusCode).toBe(400);
      expect(res.json()).toEqual({
        error: 'pve-rejected',
        message: 'Parameter verification failed. delete: disk is locked',
      });
    });
  });

  describe('remove unused', () => {
    it('maps to delete=unused0', async () => {
      const cookie = await setupAllowed();
      fakePve.setGuestConfig('qemu', 100, { unused0: 'local-lvm:vm-100-disk-1' });
      const res = await removeUnused('/pve1/qemu/100', 'unused0', cookie);
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ ok: true });
      expect(fakePve.configCalls).toHaveLength(1);
      expect(fakePve.configCalls[0]!.path).toContain('/nodes/pve1/qemu/100/config');
      expect(fakePve.configCalls[0]!.body).toEqual({ delete: 'unused0' });
    });

    it('works for a lxc guest too', async () => {
      const cookie = await setupAllowed();
      fakePve.setGuestConfig('lxc', 200, { unused3: 'local:200/vm-200-disk-2.raw' });
      const res = await removeUnused('/pve2/lxc/200', 'unused3', cookie);
      expect(res.statusCode).toBe(200);
      expect(fakePve.configCalls[0]!.path).toContain('/nodes/pve2/lxc/200/config');
      expect(fakePve.configCalls[0]!.body).toEqual({ delete: 'unused3' });
    });

    it('refuses anything that is not an unused slot (it would destroy live data)', async () => {
      const cookie = await setupAllowed();
      fakePve.setGuestConfig('qemu', 100, {
        scsi0: 'local-lvm:vm-100-disk-0,size=32G',
        unused0: 'local-lvm:vm-100-disk-1',
      });
      for (const slot of ['scsi0', 'virtio1', 'ide2', 'efidisk0', 'rootfs', 'mp0', 'net0', 'unused', 'unused256', 'unused0x']) {
        const res = await removeUnused('/pve1/qemu/100', slot, cookie);
        expect(res.statusCode, slot).toBe(400);
      }
      expect(fakePve.configCalls).toHaveLength(0);
    });

    it('404s when the unused slot is absent', async () => {
      const cookie = await setupAllowed();
      fakePve.setGuestConfig('qemu', 100, { scsi0: 'local-lvm:vm-100-disk-0,size=32G' });
      const res = await removeUnused('/pve1/qemu/100', 'unused0', cookie);
      expect(res.statusCode).toBe(404);
      expect(fakePve.configCalls).toHaveLength(0);
    });

    it('relays PVE rejections (e.g. a storage privilege PVE itself enforces)', async () => {
      const cookie = await setupAllowed();
      fakePve.setGuestConfig('qemu', 100, { unused0: 'local-lvm:vm-100-disk-1' });
      fakePve.setConfigError('qemu', 100, 403, 'Permission check failed (/storage/local-lvm, Datastore.Allocate)');
      const res = await removeUnused('/pve1/qemu/100', 'unused0', cookie);
      expect(res.statusCode).toBe(403);
      expect(res.json()).toEqual({
        error: 'pve-rejected',
        message: 'Permission check failed (/storage/local-lvm, Datastore.Allocate)',
      });
    });
  });

  describe('PVE errors on add', () => {
    it('relays a PVE rejection with its per-field detail', async () => {
      const cookie = await setupAllowed();
      fakePve.setGuestConfig('qemu', 100, {});
      fakePve.setConfigError('qemu', 100, 400, 'Parameter verification failed.', {
        scsi0: 'unable to create image: no space left',
      });
      const res = await addDisk('/pve1/qemu/100', { cookie, payload: QEMU_ADD });
      expect(res.statusCode).toBe(400);
      expect(res.json()).toEqual({
        error: 'pve-rejected',
        message: 'Parameter verification failed. scsi0: unable to create image: no space left',
      });
    });

    it('maps a PVE 5xx to pve-unreachable (502)', async () => {
      const cookie = await setupAllowed();
      fakePve.setGuestConfig('qemu', 100, {});
      fakePve.setConfigError('qemu', 100, 500, 'boom');
      const res = await addDisk('/pve1/qemu/100', { cookie, payload: QEMU_ADD });
      expect(res.statusCode).toBe(502);
      expect(res.json()).toEqual({ error: 'pve-unreachable' });
    });
  });
});
