import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance, InjectOptions } from 'fastify';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { startFakePve, type FakePve } from './helpers/fakePve.js';

const VMID = 105;
const ALLOC = { 'VM.Allocate': true };
const SPACE = { 'Datastore.AllocateSpace': true };
const AUDIT = { 'Datastore.Audit': true };

/** A minimal valid body: seabios, no media, one virtio disk, one NIC. Tests override per case. */
function minimalBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    vmid: VMID,
    name: 'test-vm',
    os: { media: 'none' },
    disk: { bus: 'virtio', storage: 'local-lvm', sizeGiB: 32 },
    cpu: { sockets: 1, cores: 2, type: 'x86-64-v2-AES' },
    memory: { memoryMiB: 2048 },
    net: { model: 'virtio', bridge: 'vmbr0' },
    ...overrides,
  };
}

/** (a) the full Windows 11 shape: ISO + scsi0 on local-lvm + virtio NIC + q35/ovmf with EFI + TPM. */
function fullBody(): Record<string, unknown> {
  return {
    vmid: VMID,
    name: 'win11-test',
    pool: 'dev',
    tags: ['prod', 'web'],
    start: true,
    os: { media: 'iso', storage: 'local', volid: 'local:iso/win11.iso' },
    ostype: 'win11',
    agent: true,
    system: {
      machine: 'q35',
      bios: 'ovmf',
      efiStorage: 'local-lvm',
      tpm: true,
      tpmStorage: 'local-lvm',
      scsihw: 'virtio-scsi-single',
      vga: 'std',
    },
    disk: {
      bus: 'scsi',
      storage: 'local-lvm',
      sizeGiB: 64,
      format: 'raw',
      discard: true,
      ssd: true,
      iothread: true,
      cache: 'none',
    },
    cpu: { sockets: 1, cores: 4, type: 'host', numa: true },
    memory: { memoryMiB: 8192, balloonMiB: 2048 },
    net: { model: 'virtio', bridge: 'vmbr0', tag: 20, firewall: true, macaddr: 'BC:24:11:64:00:01', mtu: 1500 },
  };
}

describe('create VM route (T61)', () => {
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

  /** A session with every privilege the minimal/full bodies need. */
  async function setupAllowed(): Promise<string> {
    const cookie = await setupSession();
    fakePve.setVmPermissions(VMID, ALLOC);
    fakePve.setStoragePermissions('local-lvm', SPACE);
    fakePve.setStoragePermissions('local', SPACE);
    return cookie;
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

  function create(payload: unknown, options: { cookie?: string; node?: string } = {}) {
    const injectOptions: InjectOptions = {
      method: 'POST',
      url: `/api/actions/guest/${options.node ?? 'pve1'}/qemu/create`,
      payload: payload as NonNullable<InjectOptions['payload']>,
    };
    if (options.cookie !== undefined) injectOptions.headers = { cookie: options.cookie };
    return app.inject(injectOptions);
  }

  describe('token mode and authentication', () => {
    it('403s in token mode without touching PVE', async () => {
      await setupTokenMode();
      const res = await create(minimalBody());
      expect(res.statusCode).toBe(403);
      expect(res.json()).toEqual({ error: 'writes-disabled-in-token-mode' });
      expect(fakePve.createCalls).toHaveLength(0);
    });

    it('401s without a session', async () => {
      await setupSession();
      const res = await create(minimalBody());
      expect(res.statusCode).toBe(401);
      expect(fakePve.createCalls).toHaveLength(0);
    });
  });

  describe('privileges (checked before the POST)', () => {
    it('403s naming VM.Allocate when the vmid path does not grant it', async () => {
      const cookie = await setupSession();
      fakePve.setStoragePermissions('local-lvm', SPACE);
      const res = await create(minimalBody(), { cookie });
      expect(res.statusCode).toBe(403);
      expect(res.json()).toEqual({ error: 'forbidden', missing: 'VM.Allocate' });
      expect(fakePve.createCalls).toHaveLength(0);
    });

    it('403s naming Datastore.AllocateSpace and the storage for the disk storage', async () => {
      const cookie = await setupSession();
      fakePve.setVmPermissions(VMID, ALLOC);
      const res = await create(minimalBody(), { cookie });
      expect(res.statusCode).toBe(403);
      expect(res.json()).toEqual({ error: 'forbidden', missing: 'Datastore.AllocateSpace', storage: 'local-lvm' });
      expect(fakePve.createCalls).toHaveLength(0);
    });

    it('403s for the EFI disk storage when only the data disk storage is granted', async () => {
      const cookie = await setupSession();
      fakePve.setVmPermissions(VMID, ALLOC);
      fakePve.setStoragePermissions('local-lvm', SPACE);
      const body = minimalBody({ system: { bios: 'ovmf', efiStorage: 'efi-store' } });
      const res = await create(body, { cookie });
      expect(res.statusCode).toBe(403);
      expect(res.json()).toEqual({ error: 'forbidden', missing: 'Datastore.AllocateSpace', storage: 'efi-store' });
      expect(fakePve.createCalls).toHaveLength(0);
    });

    it('403s for the TPM state storage when only the data disk storage is granted', async () => {
      const cookie = await setupSession();
      fakePve.setVmPermissions(VMID, ALLOC);
      fakePve.setStoragePermissions('local-lvm', SPACE);
      const body = minimalBody({ system: { tpm: true, tpmStorage: 'tpm-store' } });
      const res = await create(body, { cookie });
      expect(res.statusCode).toBe(403);
      expect(res.json()).toEqual({ error: 'forbidden', missing: 'Datastore.AllocateSpace', storage: 'tpm-store' });
      expect(fakePve.createCalls).toHaveLength(0);
    });

    it('403s for the ISO storage when it grants neither Audit nor AllocateSpace', async () => {
      const cookie = await setupSession();
      fakePve.setVmPermissions(VMID, ALLOC);
      fakePve.setStoragePermissions('local-lvm', SPACE);
      const body = minimalBody({ os: { media: 'iso', storage: 'isos', volid: 'isos:iso/debian.iso' } });
      const res = await create(body, { cookie });
      expect(res.statusCode).toBe(403);
      expect(res.json()).toEqual({ error: 'forbidden', missing: 'Datastore.Audit', storage: 'isos' });
      expect(fakePve.createCalls).toHaveLength(0);
    });

    it('accepts an ISO storage that grants only Datastore.Audit', async () => {
      const cookie = await setupAllowed();
      fakePve.setStoragePermissions('isos', AUDIT);
      const body = minimalBody({ os: { media: 'iso', storage: 'isos', volid: 'isos:iso/debian.iso' } });
      const res = await create(body, { cookie });
      expect(res.statusCode).toBe(202);
      expect(fakePve.createCalls).toHaveLength(1);
    });

    it('accepts an ISO storage that grants only Datastore.AllocateSpace', async () => {
      const cookie = await setupAllowed();
      fakePve.setStoragePermissions('isos', SPACE);
      const body = minimalBody({ os: { media: 'iso', storage: 'isos', volid: 'isos:iso/debian.iso' } });
      const res = await create(body, { cookie });
      expect(res.statusCode).toBe(202);
    });

    it('does not ask for any storage privilege when there is no disk, EFI, TPM or ISO', async () => {
      const cookie = await setupSession();
      fakePve.setVmPermissions(VMID, ALLOC);
      const res = await create(minimalBody({ disk: null, net: null }), { cookie });
      expect(res.statusCode).toBe(202);
    });
  });

  describe('vmid already in use', () => {
    it('409s vmid-taken when the cluster already lists the vmid, without the POST', async () => {
      const cookie = await setupAllowed();
      fakePve.setExistingGuest(VMID, 'stopped');
      const res = await create(minimalBody(), { cookie });
      expect(res.statusCode).toBe(409);
      expect(res.json()).toMatchObject({ error: 'vmid-taken' });
      expect(fakePve.createCalls).toHaveLength(0);
    });

    it('treats an lxc with the same id as taken too', async () => {
      const cookie = await setupAllowed();
      fakePve.setClusterResources([{ type: 'lxc', vmid: VMID, node: 'pve1', status: 'running' }]);
      const res = await create(minimalBody(), { cookie });
      expect(res.statusCode).toBe(409);
    });

    it('reports a privilege failure before revealing that the vmid exists', async () => {
      const cookie = await setupSession();
      fakePve.setExistingGuest(VMID, 'running');
      const res = await create(minimalBody(), { cookie });
      expect(res.statusCode).toBe(403);
      expect(res.json()).toEqual({ error: 'forbidden', missing: 'VM.Allocate' });
    });

    it('does not mistake a different vmid for a clash', async () => {
      const cookie = await setupAllowed();
      fakePve.setExistingGuest(VMID + 1, 'running');
      const res = await create(minimalBody(), { cookie });
      expect(res.statusCode).toBe(202);
    });
  });

  describe('composition', () => {
    it('(a) ISO + scsi0 on local-lvm + virtio NIC + q35/ovmf with EFI + TPM: exact PVE body and 202', async () => {
      const cookie = await setupAllowed();
      const res = await create(fullBody(), { cookie });
      expect(res.statusCode).toBe(202);
      expect(res.json()).toEqual({ upid: expect.stringMatching(/^UPID:/) as string, vmid: VMID });
      expect(fakePve.createCalls).toHaveLength(1);
      expect(fakePve.createCalls[0]!.type).toBe('qemu');
      expect(fakePve.createCalls[0]!.body).toStrictEqual({
        vmid: '105',
        name: 'win11-test',
        ostype: 'win11',
        machine: 'q35',
        bios: 'ovmf',
        scsihw: 'virtio-scsi-single',
        agent: 'enabled=1',
        cores: '4',
        sockets: '1',
        cpu: 'host',
        numa: '1',
        memory: '8192',
        balloon: '2048',
        ide2: 'local:iso/win11.iso,media=cdrom',
        scsi0: 'local-lvm:64,format=raw,discard=on,ssd=1,iothread=1,cache=none',
        efidisk0: 'local-lvm:1,efitype=4m,pre-enrolled-keys=1',
        tpmstate0: 'local-lvm:1,version=v2.0',
        net0: 'virtio=BC:24:11:64:00:01,bridge=vmbr0,tag=20,firewall=1,mtu=1500',
        boot: 'order=scsi0;ide2;net0',
        vga: 'std',
        pool: 'dev',
        tags: 'prod;web',
        start: '1',
      });
    });

    it('(b) no media + virtio0 + seabios: exact PVE body', async () => {
      const cookie = await setupAllowed();
      const res = await create(minimalBody(), { cookie });
      expect(res.statusCode).toBe(202);
      expect(fakePve.createCalls[0]!.body).toStrictEqual({
        vmid: '105',
        name: 'test-vm',
        ostype: 'other',
        bios: 'seabios',
        scsihw: 'virtio-scsi-single',
        cores: '2',
        sockets: '1',
        cpu: 'x86-64-v2-AES',
        memory: '2048',
        virtio0: 'local-lvm:32',
        net0: 'virtio,bridge=vmbr0,firewall=1',
        boot: 'order=virtio0;net0',
        start: '0',
      });
    });

    it('(c) no disk and no NIC without media: no boot key at all', async () => {
      const cookie = await setupSession();
      fakePve.setVmPermissions(VMID, ALLOC);
      const res = await create(minimalBody({ disk: null, net: null }), { cookie });
      expect(res.statusCode).toBe(202);
      const sent = fakePve.createCalls[0]!.body;
      expect(sent).not.toHaveProperty('boot');
      expect(sent).not.toHaveProperty('net0');
      expect(Object.keys(sent).filter((k) => /^(scsi|virtio|sata|ide)\d+$/.test(k))).toEqual([]);
    });

    it('(c) no disk and no NIC with an ISO: boot order is only ide2', async () => {
      const cookie = await setupAllowed();
      const body = minimalBody({
        disk: null,
        net: null,
        os: { media: 'iso', storage: 'local', volid: 'local:iso/rescue.iso' },
      });
      const res = await create(body, { cookie });
      expect(res.statusCode).toBe(202);
      expect(fakePve.createCalls[0]!.body.boot).toBe('order=ide2');
      expect(fakePve.createCalls[0]!.body.ide2).toBe('local:iso/rescue.iso,media=cdrom');
    });

    it('a NIC alone boots from net0', async () => {
      const cookie = await setupSession();
      fakePve.setVmPermissions(VMID, ALLOC);
      const res = await create(minimalBody({ disk: null }), { cookie });
      expect(res.statusCode).toBe(202);
      expect(fakePve.createCalls[0]!.body.boot).toBe('order=net0');
    });

    it('a pc machine sends no machine key; q35 sends machine=q35', async () => {
      const cookie = await setupAllowed();
      await create(minimalBody({ system: { machine: 'pc' } }), { cookie });
      expect(fakePve.createCalls[0]!.body).not.toHaveProperty('machine');
      await create(minimalBody({ vmid: VMID, system: { machine: 'q35' } }), { cookie });
      expect(fakePve.createCalls[1]!.body.machine).toBe('q35');
    });

    it('agent false and an empty tag list send neither agent nor tags', async () => {
      const cookie = await setupAllowed();
      await create(minimalBody({ agent: false, tags: [] }), { cookie });
      const sent = fakePve.createCalls[0]!.body;
      expect(sent).not.toHaveProperty('agent');
      expect(sent).not.toHaveProperty('tags');
    });

    it('omitting system applies the defaults (pc, seabios, virtio-scsi-single)', async () => {
      const cookie = await setupAllowed();
      await create(minimalBody(), { cookie });
      const sent = fakePve.createCalls[0]!.body;
      expect(sent.bios).toBe('seabios');
      expect(sent.scsihw).toBe('virtio-scsi-single');
      expect(sent).not.toHaveProperty('machine');
      expect(sent).not.toHaveProperty('efidisk0');
      expect(sent).not.toHaveProperty('tpmstate0');
    });

    it('omitting the cpu type defaults it to x86-64-v2-AES', async () => {
      const cookie = await setupAllowed();
      await create(minimalBody({ cpu: { sockets: 2, cores: 1 } }), { cookie });
      expect(fakePve.createCalls[0]!.body.cpu).toBe('x86-64-v2-AES');
      expect(fakePve.createCalls[0]!.body.sockets).toBe('2');
    });

    it('balloonMiB 0 is forwarded (it disables ballooning)', async () => {
      const cookie = await setupAllowed();
      await create(minimalBody({ memory: { memoryMiB: 4096, balloonMiB: 0 } }), { cookie });
      expect(fakePve.createCalls[0]!.body.balloon).toBe('0');
    });

    it('firewall false drops firewall= and a bare model carries no MAC', async () => {
      const cookie = await setupAllowed();
      await create(minimalBody({ net: { model: 'e1000', bridge: 'vmbr1', firewall: false } }), { cookie });
      expect(fakePve.createCalls[0]!.body.net0).toBe('e1000,bridge=vmbr1');
    });

    it('composes the disk options per bus (sata with discard and ssd, ide plain)', async () => {
      const cookie = await setupAllowed();
      await create(
        minimalBody({ disk: { bus: 'sata', storage: 'local-lvm', sizeGiB: 10, discard: true, ssd: true } }),
        { cookie },
      );
      expect(fakePve.createCalls[0]!.body.sata0).toBe('local-lvm:10,discard=on,ssd=1');
      expect(fakePve.createCalls[0]!.body.boot).toBe('order=sata0;net0');
      await create(minimalBody({ disk: { bus: 'ide', storage: 'local-lvm', sizeGiB: 8, format: 'qcow2' } }), { cookie });
      expect(fakePve.createCalls[1]!.body.ide0).toBe('local-lvm:8,format=qcow2');
    });

    it('an ide disk and an ISO use distinct slots (ide0 and ide2)', async () => {
      const cookie = await setupAllowed();
      await create(
        minimalBody({
          disk: { bus: 'ide', storage: 'local-lvm', sizeGiB: 8 },
          os: { media: 'iso', storage: 'local', volid: 'local:iso/a.iso' },
        }),
        { cookie },
      );
      const sent = fakePve.createCalls[0]!.body;
      expect(sent.ide0).toBe('local-lvm:8');
      expect(sent.ide2).toBe('local:iso/a.iso,media=cdrom');
      expect(sent.boot).toBe('order=ide0;ide2;net0');
    });

    it('accepts every listed NIC model and vga value', async () => {
      const cookie = await setupAllowed();
      for (const model of ['virtio', 'e1000', 'e1000e', 'vmxnet3', 'rtl8139']) {
        const res = await create(minimalBody({ net: { model, bridge: 'vmbr0' } }), { cookie });
        expect(res.statusCode).toBe(202);
      }
      for (const vga of ['std', 'virtio', 'qxl', 'serial0', 'none']) {
        const res = await create(minimalBody({ system: { vga } }), { cookie });
        expect(res.statusCode).toBe(202);
      }
    });
  });

  describe('body validation (400, nothing sent to PVE)', () => {
    async function expect400(payload: unknown, node?: string) {
      const cookie = await setupAllowed();
      fakePve.setStoragePermissions('local', { ...SPACE, ...AUDIT });
      const res = await create(payload, node === undefined ? { cookie } : { cookie, node });
      expect(res.statusCode).toBe(400);
      expect(fakePve.createCalls).toHaveLength(0);
      return res;
    }

    it('rejects ssd on a virtio disk', async () => {
      await expect400(minimalBody({ disk: { bus: 'virtio', storage: 'local-lvm', sizeGiB: 8, ssd: true } }));
    });

    it('rejects iothread on a sata or ide disk (allowed on scsi and virtio)', async () => {
      await expect400(minimalBody({ disk: { bus: 'sata', storage: 'local-lvm', sizeGiB: 8, iothread: true } }));
    });

    it('rejects a balloon larger than the memory', async () => {
      const res = await expect400(minimalBody({ memory: { memoryMiB: 1024, balloonMiB: 2048 } }));
      expect(res.json().message).toBe('balloonMiB must not exceed memoryMiB');
    });

    it('rejects ovmf without efiStorage', async () => {
      const res = await expect400(minimalBody({ system: { bios: 'ovmf' } }));
      expect(res.json().message).toBe('efiStorage is required with OVMF');
    });

    it('rejects efiStorage with seabios', async () => {
      await expect400(minimalBody({ system: { bios: 'seabios', efiStorage: 'local-lvm' } }));
    });

    it('rejects a TPM without tpmStorage, and tpmStorage without a TPM', async () => {
      await expect400(minimalBody({ system: { tpm: true } }));
      await expect400(minimalBody({ system: { tpmStorage: 'local-lvm' } }));
    });

    it('rejects a volid that is not on the stated storage', async () => {
      const res = await expect400(minimalBody({ os: { media: 'iso', storage: 'local', volid: 'other:iso/a.iso' } }));
      expect(res.json().message).toBe('volid must start with local:iso/');
    });

    it('rejects a volid outside the iso folder or with a property-string injection', async () => {
      await expect400(minimalBody({ os: { media: 'iso', storage: 'local', volid: 'local:vztmpl/a.tar.zst' } }));
      await expect400(minimalBody({ os: { media: 'iso', storage: 'local', volid: 'local:iso/a.iso,media=disk' } }));
      await expect400(minimalBody({ os: { media: 'iso', storage: 'local', volid: 'local:iso/../../etc/passwd' } }));
      await expect400(minimalBody({ os: { media: 'iso', storage: 'local', volid: 'local:iso/' } }));
    });

    it('rejects an invalid name', async () => {
      await expect400(minimalBody({ name: 'bad_name' }));
      await expect400(minimalBody({ name: '-lead' }));
      await expect400(minimalBody({ name: 'a'.repeat(64) }));
      await expect400(minimalBody({ name: '' }));
    });

    it('rejects a vmid outside 100..999999999 or non-integer', async () => {
      await expect400(minimalBody({ vmid: 99 }));
      await expect400(minimalBody({ vmid: 1000000000 }));
      await expect400(minimalBody({ vmid: 100.5 }));
    });

    it('rejects unknown keys at every level (strict)', async () => {
      await expect400(minimalBody({ skiplock: true }));
      await expect400(minimalBody({ cpu: { sockets: 1, cores: 1, cpulimit: 1 } }));
      await expect400(minimalBody({ net: { model: 'virtio', bridge: 'vmbr0', rate: 5 } }));
    });

    it('rejects out-of-range cpu, memory and disk sizes', async () => {
      await expect400(minimalBody({ cpu: { sockets: 5, cores: 1 } }));
      await expect400(minimalBody({ cpu: { sockets: 1, cores: 129 } }));
      await expect400(minimalBody({ cpu: { sockets: 0, cores: 1 } }));
      await expect400(minimalBody({ memory: { memoryMiB: 15 } }));
      await expect400(minimalBody({ memory: { memoryMiB: 4194305 } }));
      await expect400(minimalBody({ disk: { bus: 'scsi', storage: 'local-lvm', sizeGiB: 0 } }));
      await expect400(minimalBody({ disk: { bus: 'scsi', storage: 'local-lvm', sizeGiB: 65537 } }));
    });

    it('rejects injection through the cpu type, bridge, storage, pool, tags and MAC', async () => {
      await expect400(minimalBody({ cpu: { sockets: 1, cores: 1, type: 'host,flags=+aes' } }));
      await expect400(minimalBody({ net: { model: 'virtio', bridge: 'vmbr0,firewall=0' } }));
      await expect400(minimalBody({ disk: { bus: 'scsi', storage: 'local-lvm,import-from=x', sizeGiB: 8 } }));
      await expect400(minimalBody({ pool: 'dev,x' }));
      await expect400(minimalBody({ tags: ['ok', 'bad tag;x'] }));
      await expect400(minimalBody({ net: { model: 'virtio', bridge: 'vmbr0', macaddr: '01:00:5E:00:00:01' } }));
    });

    it('rejects a bad NIC model, VLAN tag, MTU and disk bus', async () => {
      await expect400(minimalBody({ net: { model: 'ne2k', bridge: 'vmbr0' } }));
      await expect400(minimalBody({ net: { model: 'virtio', bridge: 'vmbr0', tag: 0 } }));
      await expect400(minimalBody({ net: { model: 'virtio', bridge: 'vmbr0', tag: 4095 } }));
      await expect400(minimalBody({ net: { model: 'virtio', bridge: 'vmbr0', mtu: 65521 } }));
      await expect400(minimalBody({ disk: { bus: 'nvme', storage: 'local-lvm', sizeGiB: 8 } }));
    });

    it('rejects a missing os, disk or net key (null is the explicit "none")', async () => {
      const noOs = minimalBody();
      delete noOs.os;
      await expect400(noOs);
      const noDisk = minimalBody();
      delete noDisk.disk;
      await expect400(noDisk);
      const noNet = minimalBody();
      delete noNet.net;
      await expect400(noNet);
    });

    it('rejects an unknown ostype, machine, scsihw or vga', async () => {
      await expect400(minimalBody({ ostype: 'win95' }));
      await expect400(minimalBody({ system: { machine: 'virt' } }));
      await expect400(minimalBody({ system: { scsihw: 'megasas' } }));
      await expect400(minimalBody({ system: { vga: 'vmware' } }));
    });

    it('rejects a node path segment that is not a node name', async () => {
      await expect400(minimalBody(), 'bad_node');
    });
  });

  describe('PVE failures', () => {
    it('relays a PVE 4xx as pve-rejected with the per-field errors', async () => {
      const cookie = await setupAllowed();
      fakePve.setCreateError('qemu', VMID, 400, 'Parameter verification failed.', { name: 'invalid format' });
      const res = await create(minimalBody(), { cookie });
      expect(res.statusCode).toBe(400);
      expect(res.json()).toEqual({
        error: 'pve-rejected',
        message: 'Parameter verification failed. name: invalid format',
      });
    });

    it('relays a PVE 403 (a missing VM.Config.* privilege) with its own status', async () => {
      const cookie = await setupAllowed();
      fakePve.setCreateError('qemu', VMID, 403, 'Permission check failed (/vms/105, VM.Config.Disk)');
      const res = await create(minimalBody(), { cookie });
      expect(res.statusCode).toBe(403);
      expect(res.json()).toMatchObject({ error: 'pve-rejected' });
    });

    it('maps a PVE 5xx to 502 pve-unreachable without leaking the message', async () => {
      const cookie = await setupAllowed();
      fakePve.setCreateError('qemu', VMID, 500, 'secret internal detail');
      const res = await create(minimalBody(), { cookie });
      expect(res.statusCode).toBe(502);
      expect(res.json()).toEqual({ error: 'pve-unreachable' });
    });
  });
});
