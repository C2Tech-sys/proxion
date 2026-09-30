import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance, InjectOptions } from 'fastify';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { startFakePve, type FakePve } from './helpers/fakePve.js';

const GUEST_CONFIG = {
  scsi0: 'tank:vm-100-disk-0,size=32G',
  scsi1: 'tank:vm-100-disk-1,size=16G',
  ide2: 'local:iso/debian.iso,media=cdrom',
  net0: 'virtio=BC:24:11:64:00:01,bridge=vmbr0',
  boot: 'order=scsi0;net0',
};

describe('guest boot order route (T51)', () => {
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
    fakePve.setVmPermissions(100, { 'VM.Config.Options': true });
    fakePve.setVmPermissions(200, { 'VM.Config.Options': true });
    fakePve.setGuestConfig('qemu', 100, GUEST_CONFIG);
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

  function putBootOrder(path: string, options: { cookie?: string; payload?: unknown } = {}) {
    const injectOptions: InjectOptions = { method: 'PUT', url: `/api/actions/guest${path}/boot-order` };
    if (options.cookie !== undefined) injectOptions.headers = { cookie: options.cookie };
    if (options.payload !== undefined) injectOptions.payload = options.payload as NonNullable<InjectOptions['payload']>;
    return app.inject(injectOptions);
  }

  it('403s in token mode without reaching PVE config', async () => {
    await setupTokenMode();
    const res = await putBootOrder('/pve1/qemu/100', { payload: { order: ['scsi0'] } });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ error: 'writes-disabled-in-token-mode' });
    expect(fakePve.configCalls).toHaveLength(0);
  });

  it('401s without a session', async () => {
    await setupSession();
    const res = await putBootOrder('/pve1/qemu/100', { payload: { order: ['scsi0'] } });
    expect(res.statusCode).toBe(401);
  });

  it('400s not-applicable for a container', async () => {
    const cookie = await setupSession();
    const res = await putBootOrder('/pve1/lxc/200', { cookie, payload: { order: ['net0'] } });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('not-applicable');
    expect(fakePve.configCalls).toHaveLength(0);
  });

  it('403s without VM.Config.Options, naming the privilege', async () => {
    const cookie = await setupSession();
    fakePve.setVmPermissions(100, { 'VM.Config.Options': false, 'VM.Config.CPU': true });
    const res = await putBootOrder('/pve1/qemu/100', { cookie, payload: { order: ['scsi0'] } });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ error: 'forbidden', missing: 'VM.Config.Options' });
    expect(fakePve.configCalls).toHaveLength(0);
  });

  describe('body validation (400)', () => {
    async function expect400(payload: unknown) {
      const cookie = await setupSession();
      const res = await putBootOrder('/pve1/qemu/100', { cookie, payload });
      expect(res.statusCode, JSON.stringify(payload)).toBe(400);
      expect(fakePve.configCalls).toHaveLength(0);
      return res;
    }

    it('rejects a missing order, a non-array and an unknown key', async () => {
      await expect400({});
      await expect400({ order: 'scsi0' });
      await expect400({ order: ['scsi0'], extra: 1 });
    });

    it('rejects a malformed or out-of-range entry', async () => {
      await expect400({ order: ['disk0'] });
      await expect400({ order: ['ide4'] });
      await expect400({ order: ['sata6'] });
      await expect400({ order: ['scsi31'] });
      await expect400({ order: ['virtio16'] });
      await expect400({ order: ['net32'] });
      await expect400({ order: ['scsi0;net0'] });
      await expect400({ order: ['scsi0,media=cdrom'] });
      await expect400({ order: [' scsi0'] });
      await expect400({ order: [1] });
    });

    it('rejects a duplicate entry', async () => {
      await expect400({ order: ['scsi0', 'net0', 'scsi0'] });
    });

    it('rejects more than 16 entries', async () => {
      const many = Array.from({ length: 17 }, (_, i) => `scsi${i}`);
      await expect400({ order: many });
    });

    it('rejects a device the guest does not have (unknown-device), without any PUT', async () => {
      const cookie = await setupSession();
      const res = await putBootOrder('/pve1/qemu/100', { cookie, payload: { order: ['scsi0', 'virtio3'] } });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toBe('unknown-device');
      expect(res.json().message).toContain('virtio3');
      expect(fakePve.configCalls).toHaveLength(0);
    });

    it('rejects a bad node/type/vmid', async () => {
      const cookie = await setupSession();
      const badType = await putBootOrder('/pve1/vm/100', { cookie, payload: { order: [] } });
      expect(badType.statusCode).toBe(400);
      const badVmid = await putBootOrder('/pve1/qemu/abc', { cookie, payload: { order: [] } });
      expect(badVmid.statusCode).toBe(400);
    });
  });

  describe('PVE parameter mapping', () => {
    it('composes boot as order=dev;dev;dev in the requested order', async () => {
      const cookie = await setupSession();
      const res = await putBootOrder('/pve1/qemu/100', { cookie, payload: { order: ['ide2', 'scsi0', 'net0'] } });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ ok: true, pending: [] });
      expect(fakePve.configCalls).toHaveLength(1);
      expect(fakePve.configCalls[0]!.path).toContain('/nodes/pve1/qemu/100/config');
      expect(fakePve.configCalls[0]!.body).toEqual({ boot: 'order=ide2;scsi0;net0' });
    });

    it('accepts a single device', async () => {
      const cookie = await setupSession();
      const res = await putBootOrder('/pve1/qemu/100', { cookie, payload: { order: ['net0'] } });
      expect(res.statusCode).toBe(200);
      expect(fakePve.configCalls[0]!.body).toEqual({ boot: 'order=net0' });
    });

    it('an empty order clears the boot key (delete=boot) rather than sending "order="', async () => {
      const cookie = await setupSession();
      const res = await putBootOrder('/pve1/qemu/100', { cookie, payload: { order: [] } });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ ok: true, pending: [] });
      expect(fakePve.configCalls).toHaveLength(1);
      expect(fakePve.configCalls[0]!.body).toEqual({ delete: 'boot' });
    });
  });

  describe('pending derivation', () => {
    it('reports boot when PVE holds the change back', async () => {
      const cookie = await setupSession();
      fakePve.setPending('qemu', 100, [
        { key: 'boot', value: 'order=scsi0;net0', pending: 'order=net0' },
        { key: 'name', value: 'web' },
      ]);
      const res = await putBootOrder('/pve1/qemu/100', { cookie, payload: { order: ['net0'] } });
      expect(res.json()).toEqual({ ok: true, pending: ['boot'] });
    });

    it('reports boot when its removal is queued', async () => {
      const cookie = await setupSession();
      fakePve.setPending('qemu', 100, [{ key: 'boot', value: 'order=scsi0;net0', delete: 1 }]);
      const res = await putBootOrder('/pve1/qemu/100', { cookie, payload: { order: [] } });
      expect(res.json()).toEqual({ ok: true, pending: ['boot'] });
    });

    it('does not report unrelated pending keys', async () => {
      const cookie = await setupSession();
      fakePve.setPending('qemu', 100, [{ key: 'cores', value: '2', pending: '4' }]);
      const res = await putBootOrder('/pve1/qemu/100', { cookie, payload: { order: ['scsi0'] } });
      expect(res.json()).toEqual({ ok: true, pending: [] });
    });

    it('still succeeds with an empty pending list if the pending read fails', async () => {
      const cookie = await setupSession();
      fakePve.setPendingError('qemu', 100, 500);
      const res = await putBootOrder('/pve1/qemu/100', { cookie, payload: { order: ['scsi0'] } });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ ok: true, pending: [] });
    });
  });

  describe('PVE errors', () => {
    it('surfaces PVE rejection detail (incl. the per-field errors map)', async () => {
      const cookie = await setupSession();
      fakePve.setConfigError('qemu', 100, 400, 'Parameter verification failed.', {
        boot: 'invalid boot order',
      });
      const res = await putBootOrder('/pve1/qemu/100', { cookie, payload: { order: ['scsi0'] } });
      expect(res.statusCode).toBe(400);
      const body = res.json();
      expect(body.error).toBe('pve-rejected');
      expect(body.message).toContain('Parameter verification failed.');
      expect(body.message).toContain('boot: invalid boot order');
    });

    it('maps a PVE 5xx to 502 pve-unreachable', async () => {
      const cookie = await setupSession();
      fakePve.setConfigError('qemu', 100, 500, 'boom');
      const res = await putBootOrder('/pve1/qemu/100', { cookie, payload: { order: ['scsi0'] } });
      expect(res.statusCode).toBe(502);
      expect(res.json()).toEqual({ error: 'pve-unreachable' });
    });
  });
});
