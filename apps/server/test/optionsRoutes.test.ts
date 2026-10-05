import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance, InjectOptions } from 'fastify';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { startFakePve, type FakePve } from './helpers/fakePve.js';

const ALL_PRIVS = {
  'VM.Config.Options': true,
  'VM.Config.HWType': true,
  'VM.Config.Network': true,
};

describe('guest options route (T53)', () => {
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
    const cookie = raw.split(';')[0]!;
    fakePve.setVmPermissions(100, ALL_PRIVS);
    fakePve.setVmPermissions(200, ALL_PRIVS);
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

  function patchOptions(path: string, options: { cookie?: string; payload?: unknown } = {}) {
    const injectOptions: InjectOptions = { method: 'PATCH', url: `/api/actions/guest${path}/options` };
    if (options.cookie !== undefined) injectOptions.headers = { cookie: options.cookie };
    if (options.payload !== undefined) injectOptions.payload = options.payload as NonNullable<InjectOptions['payload']>;
    return app.inject(injectOptions);
  }

  describe('token mode and authentication', () => {
    it('403s in token mode without reaching PVE config', async () => {
      await setupTokenMode();
      const res = await patchOptions('/pve1/qemu/100', { payload: { onboot: true } });
      expect(res.statusCode).toBe(403);
      expect(res.json()).toEqual({ error: 'writes-disabled-in-token-mode' });
      expect(fakePve.configCalls).toHaveLength(0);
    });

    it('401s without a session', async () => {
      await setupSession();
      const res = await patchOptions('/pve1/qemu/100', { payload: { onboot: true } });
      expect(res.statusCode).toBe(401);
      expect(fakePve.configCalls).toHaveLength(0);
    });
  });

  describe('body validation (400)', () => {
    async function expect400(path: string, payload: unknown) {
      const cookie = await setupSession();
      const res = await patchOptions(path, { cookie, payload });
      expect(res.statusCode, JSON.stringify(payload)).toBe(400);
      expect(fakePve.configCalls).toHaveLength(0);
      return res;
    }

    it('rejects an empty body and an unknown key', async () => {
      await expect400('/pve1/qemu/100', {});
      await expect400('/pve1/qemu/100', { onboot: true, skiplock: true });
      await expect400('/pve1/qemu/100', { agent: { enabled: true, extra: 1 } });
    });

    it('rejects a bad name/hostname (charset, edge hyphens, empty label, length)', async () => {
      for (const name of ['', '-web', 'web-', 'we b', 'web_1', 'a..b', '.web', 'web.', 'a'.repeat(64), `${'a'.repeat(32)}.${'b'.repeat(32)}`]) {
        await expect400('/pve1/qemu/100', { name });
      }
      await expect400('/pve1/lxc/200', { hostname: 'bad_host' });
      await expect400('/pve1/lxc/200', { hostname: 'a'.repeat(64) });
    });

    it('rejects a bad startup', async () => {
      await expect400('/pve1/qemu/100', { startup: {} });
      await expect400('/pve1/qemu/100', { startup: { order: -1 } });
      await expect400('/pve1/qemu/100', { startup: { up: 1.5 } });
      await expect400('/pve1/qemu/100', { startup: { down: '30' } });
      await expect400('/pve1/qemu/100', { startup: { order: 1, loose: 1 } });
    });

    it('rejects a bad ostype', async () => {
      await expect400('/pve1/qemu/100', { ostype: 'linux' });
      await expect400('/pve1/qemu/100', { ostype: 'win10,extra=1' });
    });

    it('rejects bad tags (charset, option separators, count, length)', async () => {
      await expect400('/pve1/qemu/100', { tags: ['web prod'] });
      await expect400('/pve1/qemu/100', { tags: ['-web'] });
      await expect400('/pve1/qemu/100', { tags: ['a;b'] });
      await expect400('/pve1/qemu/100', { tags: ['a,b'] });
      await expect400('/pve1/qemu/100', { tags: [''] });
      await expect400('/pve1/qemu/100', { tags: ['a'.repeat(65)] });
      await expect400('/pve1/qemu/100', { tags: Array.from({ length: 33 }, (_, i) => `t${i}`) });
      await expect400('/pve1/lxc/200', { tags: 'web' });
    });

    it('rejects a bad agent / hotplug / non-boolean flags', async () => {
      await expect400('/pve1/qemu/100', { agent: { fstrimClonedDisks: true } });
      await expect400('/pve1/qemu/100', { agent: { enabled: 'yes' } });
      await expect400('/pve1/qemu/100', { hotplug: ['network', 'floppy'] });
      await expect400('/pve1/qemu/100', { hotplug: 'network,disk' });
      await expect400('/pve1/qemu/100', { onboot: 1 });
      await expect400('/pve1/qemu/100', { tablet: 'true' });
      await expect400('/pve1/qemu/100', { localtime: 0 });
    });

    it('rejects bad nameservers (not an IP, zone id, too many) and a bad searchdomain', async () => {
      await expect400('/pve1/lxc/200', { nameserver: ['dns.example.com'] });
      await expect400('/pve1/lxc/200', { nameserver: ['1.1.1.1 8.8.8.8'] });
      await expect400('/pve1/lxc/200', { nameserver: ['999.1.1.1'] });
      await expect400('/pve1/lxc/200', { nameserver: ['fe80::1%eth0'] });
      await expect400('/pve1/lxc/200', { nameserver: ['1.1.1.1', '8.8.8.8', '9.9.9.9', '8.8.4.4'] });
      await expect400('/pve1/lxc/200', { searchdomain: 'bad domain' });
      await expect400('/pve1/lxc/200', { searchdomain: '' });
    });

    it('rejects qemu-only keys on an lxc guest and lxc-only keys on a qemu guest', async () => {
      for (const payload of [{ name: 'web' }, { ostype: 'l26' }, { agent: { enabled: true } }, { tablet: true }]) {
        const res = await expect400('/pve1/lxc/200', payload);
        expect(res.json().error).toBe('invalid-field-for-type');
      }
      for (const payload of [{ hostname: 'web' }, { nameserver: ['1.1.1.1'] }, { searchdomain: 'lan' }]) {
        const res = await expect400('/pve1/qemu/100', payload);
        expect(res.json().error).toBe('invalid-field-for-type');
      }
    });

    it('rejects a bad node/type/vmid', async () => {
      const cookie = await setupSession();
      const badType = await patchOptions('/pve1/vm/100', { cookie, payload: { onboot: true } });
      expect(badType.statusCode).toBe(400);
      const badVmid = await patchOptions('/pve1/qemu/abc', { cookie, payload: { onboot: true } });
      expect(badVmid.statusCode).toBe(400);
    });
  });

  describe('privileges', () => {
    it('qemu Options-group keys need VM.Config.Options', async () => {
      const cookie = await setupSession();
      fakePve.setVmPermissions(100, { ...ALL_PRIVS, 'VM.Config.Options': false });
      for (const payload of [
        { name: 'web' },
        { onboot: true },
        { startup: { order: 1 } },
        { ostype: 'l26' },
        { protection: true },
        { tags: ['a'] },
        { agent: { enabled: true } },
        { localtime: true },
      ]) {
        const res = await patchOptions('/pve1/qemu/100', { cookie, payload });
        expect(res.statusCode, JSON.stringify(payload)).toBe(403);
        expect(res.json()).toEqual({ error: 'forbidden', missing: 'VM.Config.Options' });
      }
      expect(fakePve.configCalls).toHaveLength(0);
    });

    it('qemu tablet/acpi/kvm/hotplug need VM.Config.HWType', async () => {
      const cookie = await setupSession();
      fakePve.setVmPermissions(100, { ...ALL_PRIVS, 'VM.Config.HWType': false });
      for (const payload of [{ tablet: false }, { acpi: false }, { kvm: false }, { hotplug: ['disk'] }]) {
        const res = await patchOptions('/pve1/qemu/100', { cookie, payload });
        expect(res.statusCode, JSON.stringify(payload)).toBe(403);
        expect(res.json()).toEqual({ error: 'forbidden', missing: 'VM.Config.HWType' });
      }
      // Options keys still pass with only HWType missing.
      const ok = await patchOptions('/pve1/qemu/100', { cookie, payload: { onboot: true } });
      expect(ok.statusCode).toBe(200);
    });

    it('lxc hostname/nameserver/searchdomain need VM.Config.Network', async () => {
      const cookie = await setupSession();
      fakePve.setVmPermissions(200, { ...ALL_PRIVS, 'VM.Config.Network': false });
      for (const payload of [{ hostname: 'web' }, { nameserver: ['1.1.1.1'] }, { searchdomain: 'lan' }]) {
        const res = await patchOptions('/pve1/lxc/200', { cookie, payload });
        expect(res.statusCode, JSON.stringify(payload)).toBe(403);
        expect(res.json()).toEqual({ error: 'forbidden', missing: 'VM.Config.Network' });
      }
      expect(fakePve.configCalls).toHaveLength(0);
    });

    it('lxc onboot/startup/protection/tags need VM.Config.Options', async () => {
      const cookie = await setupSession();
      fakePve.setVmPermissions(200, { ...ALL_PRIVS, 'VM.Config.Options': false });
      for (const payload of [{ onboot: true }, { startup: null }, { protection: true }, { tags: ['a'] }]) {
        const res = await patchOptions('/pve1/lxc/200', { cookie, payload });
        expect(res.statusCode, JSON.stringify(payload)).toBe(403);
        expect(res.json()).toEqual({ error: 'forbidden', missing: 'VM.Config.Options' });
      }
      expect(fakePve.configCalls).toHaveLength(0);
    });

    it('checks every key present and reports the first missing one (body order irrelevant)', async () => {
      const cookie = await setupSession();
      fakePve.setVmPermissions(100, { 'VM.Config.Options': true, 'VM.Config.HWType': false });
      const mixed = await patchOptions('/pve1/qemu/100', { cookie, payload: { hotplug: ['disk'], onboot: true } });
      expect(mixed.statusCode).toBe(403);
      expect(mixed.json()).toEqual({ error: 'forbidden', missing: 'VM.Config.HWType' });

      fakePve.setVmPermissions(100, {});
      const none = await patchOptions('/pve1/qemu/100', { cookie, payload: { hotplug: ['disk'], name: 'web' } });
      expect(none.statusCode).toBe(403);
      expect(none.json()).toEqual({ error: 'forbidden', missing: 'VM.Config.Options' });
      expect(fakePve.configCalls).toHaveLength(0);
    });
  });

  describe('PVE parameter composition', () => {
    it('name/hostname go out as name/hostname', async () => {
      const cookie = await setupSession();
      const qemu = await patchOptions('/pve1/qemu/100', { cookie, payload: { name: 'web-01.lan' } });
      expect(qemu.statusCode).toBe(200);
      expect(qemu.json()).toEqual({ ok: true, changed: ['name'], pending: [] });
      expect(fakePve.configCalls[0]!.path).toContain('/nodes/pve1/qemu/100/config');
      expect(fakePve.configCalls[0]!.body).toStrictEqual({ name: 'web-01.lan' });

      const lxc = await patchOptions('/pve1/lxc/200', { cookie, payload: { hostname: 'ct-1' } });
      expect(lxc.statusCode).toBe(200);
      expect(fakePve.configCalls[1]!.path).toContain('/nodes/pve1/lxc/200/config');
      expect(fakePve.configCalls[1]!.body).toStrictEqual({ hostname: 'ct-1' });
    });

    it('booleans go out as 1/0', async () => {
      const cookie = await setupSession();
      const res = await patchOptions('/pve1/qemu/100', {
        cookie,
        payload: { onboot: true, protection: false, tablet: false, acpi: true, kvm: true, localtime: false },
      });
      expect(res.statusCode).toBe(200);
      expect(fakePve.configCalls[0]!.body).toStrictEqual({
        onboot: '1',
        protection: '0',
        localtime: '0',
        tablet: '0',
        acpi: '1',
        kvm: '1',
      });
    });

    it('startup composes order/up/down, omitting missing parts', async () => {
      const cookie = await setupSession();
      await patchOptions('/pve1/qemu/100', { cookie, payload: { startup: { order: 3, up: 30, down: 60 } } });
      await patchOptions('/pve1/qemu/100', { cookie, payload: { startup: { order: 3 } } });
      await patchOptions('/pve1/qemu/100', { cookie, payload: { startup: { down: 0, up: 5 } } });
      expect(fakePve.configCalls.map((c) => c.body)).toStrictEqual([
        { startup: 'order=3,up=30,down=60' },
        { startup: 'order=3' },
        { startup: 'up=5,down=0' },
      ]);
    });

    it('startup null clears with delete', async () => {
      const cookie = await setupSession();
      const res = await patchOptions('/pve1/qemu/100', { cookie, payload: { startup: null } });
      expect(res.statusCode).toBe(200);
      expect(res.json().changed).toEqual(['startup']);
      expect(fakePve.configCalls[0]!.body).toStrictEqual({ delete: 'startup' });
    });

    it('ostype and tags', async () => {
      const cookie = await setupSession();
      const res = await patchOptions('/pve1/qemu/100', { cookie, payload: { ostype: 'win11', tags: ['web', 'Prod'] } });
      expect(res.statusCode).toBe(200);
      expect(fakePve.configCalls[0]!.body).toStrictEqual({ ostype: 'win11', tags: 'web;Prod' });
    });

    it('empty tags clear with delete', async () => {
      const cookie = await setupSession();
      const res = await patchOptions('/pve1/qemu/100', { cookie, payload: { tags: [] } });
      expect(res.statusCode).toBe(200);
      expect(fakePve.configCalls[0]!.body).toStrictEqual({ delete: 'tags' });
    });

    it('agent composes enabled and fstrim_cloned_disks', async () => {
      const cookie = await setupSession();
      await patchOptions('/pve1/qemu/100', { cookie, payload: { agent: { enabled: true, fstrimClonedDisks: true } } });
      await patchOptions('/pve1/qemu/100', { cookie, payload: { agent: { enabled: false } } });
      await patchOptions('/pve1/qemu/100', { cookie, payload: { agent: { enabled: true, fstrimClonedDisks: false } } });
      expect(fakePve.configCalls.map((c) => c.body)).toStrictEqual([
        { agent: 'enabled=1,fstrim_cloned_disks=1' },
        { agent: 'enabled=0' },
        { agent: 'enabled=1' },
      ]);
    });

    it('agent keeps the unmodeled sub-options already on the guest', async () => {
      const cookie = await setupSession();
      fakePve.setGuestConfig('qemu', 100, { agent: 'enabled=1,fstrim_cloned_disks=1,type=isa,freeze-fs-on-backup=0' });
      const res = await patchOptions('/pve1/qemu/100', { cookie, payload: { agent: { enabled: false } } });
      expect(res.statusCode).toBe(200);
      expect(fakePve.configCalls[0]!.body).toStrictEqual({ agent: 'enabled=0,type=isa,freeze-fs-on-backup=0' });

      fakePve.setGuestConfig('qemu', 100, { agent: '1,type=virtio' });
      await patchOptions('/pve1/qemu/100', { cookie, payload: { agent: { enabled: true } } });
      expect(fakePve.configCalls[1]!.body).toStrictEqual({ agent: 'enabled=1,type=virtio' });
    });

    it('localtime null clears with delete', async () => {
      const cookie = await setupSession();
      const res = await patchOptions('/pve1/qemu/100', { cookie, payload: { localtime: null } });
      expect(res.statusCode).toBe(200);
      expect(fakePve.configCalls[0]!.body).toStrictEqual({ delete: 'localtime' });
    });

    it('hotplug composes a comma list; an empty list is 0', async () => {
      const cookie = await setupSession();
      await patchOptions('/pve1/qemu/100', { cookie, payload: { hotplug: ['network', 'disk', 'usb'] } });
      await patchOptions('/pve1/qemu/100', { cookie, payload: { hotplug: [] } });
      expect(fakePve.configCalls.map((c) => c.body)).toStrictEqual([{ hotplug: 'network,disk,usb' }, { hotplug: '0' }]);
    });

    it('lxc nameserver is space-separated; an empty list clears', async () => {
      const cookie = await setupSession();
      const res = await patchOptions('/pve1/lxc/200', { cookie, payload: { nameserver: ['1.1.1.1', '8.8.8.8'] } });
      expect(res.statusCode).toBe(200);
      await patchOptions('/pve1/lxc/200', { cookie, payload: { nameserver: ['2606:4700:4700::1111'] } });
      await patchOptions('/pve1/lxc/200', { cookie, payload: { nameserver: [] } });
      expect(fakePve.configCalls.map((c) => c.body)).toStrictEqual([
        { nameserver: '1.1.1.1 8.8.8.8' },
        { nameserver: '2606:4700:4700::1111' },
        { delete: 'nameserver' },
      ]);
    });

    it('lxc searchdomain sets a value; null clears', async () => {
      const cookie = await setupSession();
      await patchOptions('/pve1/lxc/200', { cookie, payload: { searchdomain: 'corp.example.com' } });
      await patchOptions('/pve1/lxc/200', { cookie, payload: { searchdomain: null } });
      expect(fakePve.configCalls.map((c) => c.body)).toStrictEqual([
        { searchdomain: 'corp.example.com' },
        { delete: 'searchdomain' },
      ]);
    });

    it('several keys go out as one PUT with one comma-joined delete list', async () => {
      const cookie = await setupSession();
      const res = await patchOptions('/pve1/qemu/100', {
        cookie,
        payload: { onboot: true, startup: null, tags: [], localtime: null, hotplug: ['cpu'], name: 'multi' },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().changed).toEqual(['name', 'onboot', 'startup', 'tags', 'localtime', 'hotplug']);
      expect(fakePve.configCalls).toHaveLength(1);
      expect(fakePve.configCalls[0]!.body).toStrictEqual({
        name: 'multi',
        onboot: '1',
        hotplug: 'cpu',
        delete: 'startup,tags,localtime',
      });
    });

    it('lxc onboot/startup/protection/tags map like qemu', async () => {
      const cookie = await setupSession();
      const res = await patchOptions('/pve1/lxc/200', {
        cookie,
        payload: { onboot: false, startup: { order: 1, up: 10 }, protection: true, tags: ['db'] },
      });
      expect(res.statusCode).toBe(200);
      expect(fakePve.configCalls[0]!.body).toStrictEqual({
        onboot: '0',
        startup: 'order=1,up=10',
        protection: '1',
        tags: 'db',
      });
    });
  });

  describe('PVE failures', () => {
    it('relays a PVE 4xx as pve-rejected with the sanitized message', async () => {
      const cookie = await setupSession();
      fakePve.setConfigError('qemu', 100, 403, 'Tag not allowed by user-tag-access', { tags: 'tag "web" is not allowed' });
      const res = await patchOptions('/pve1/qemu/100', { cookie, payload: { tags: ['web'] } });
      expect(res.statusCode).toBe(403);
      expect(res.json()).toEqual({
        error: 'pve-rejected',
        message: 'Tag not allowed by user-tag-access tags: tag "web" is not allowed',
      });
    });

    it('maps a PVE 5xx to 502 pve-unreachable', async () => {
      const cookie = await setupSession();
      fakePve.setConfigError('lxc', 200, 500, 'boom');
      const res = await patchOptions('/pve1/lxc/200', { cookie, payload: { onboot: true } });
      expect(res.statusCode).toBe(502);
      expect(res.json()).toEqual({ error: 'pve-unreachable' });
    });
  });

  describe('pending detection', () => {
    it('reports the changed keys PVE holds back, including pending deletes', async () => {
      const cookie = await setupSession();
      fakePve.setPending('qemu', 100, [
        { key: 'hotplug', value: '1', pending: '0' },
        { key: 'tags', value: 'a', delete: 1 },
        { key: 'name', value: 'web' },
        { key: 'cores', value: '2', pending: '4' },
      ]);
      const res = await patchOptions('/pve1/qemu/100', {
        cookie,
        payload: { name: 'web', tags: [], hotplug: [] },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ ok: true, changed: ['name', 'tags', 'hotplug'], pending: ['tags', 'hotplug'] });
    });

    it('a pending-read failure does not fail the applied update', async () => {
      const cookie = await setupSession();
      fakePve.setPendingError('qemu', 100, 500);
      const res = await patchOptions('/pve1/qemu/100', { cookie, payload: { onboot: true } });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ ok: true, changed: ['onboot'], pending: [] });
    });
  });
});
