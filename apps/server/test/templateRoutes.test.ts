import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance, InjectOptions } from 'fastify';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { startFakePve, type FakePve } from './helpers/fakePve.js';

describe('guest convert-to-template routes', () => {
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

  function convert(path: string, options: { cookie?: string; payload?: Record<string, unknown> } = {}) {
    const injectOptions: InjectOptions = { method: 'POST', url: `/api/actions/guest${path}/template` };
    if (options.cookie !== undefined) injectOptions.headers = { cookie: options.cookie };
    if (options.payload !== undefined) injectOptions.payload = options.payload;
    return app.inject(injectOptions);
  }

  /** One stopped qemu guest (vmid 100) and one stopped lxc guest (vmid 200) on `pve1`. */
  function baseResources(
    opts: { qemuStatus?: string; lxcStatus?: string; qemuTemplate?: boolean; lxcTemplate?: boolean } = {},
  ): unknown[] {
    return [
      { id: 'node/pve1', type: 'node', node: 'pve1', status: 'online' },
      {
        id: 'qemu/100',
        type: 'qemu',
        vmid: 100,
        node: 'pve1',
        status: opts.qemuStatus ?? 'stopped',
        template: opts.qemuTemplate ? 1 : 0,
      },
      {
        id: 'lxc/200',
        type: 'lxc',
        vmid: 200,
        node: 'pve1',
        status: opts.lxcStatus ?? 'stopped',
        template: opts.lxcTemplate ? 1 : 0,
      },
    ];
  }

  it('403s in token mode before any PVE call', async () => {
    await setupTokenMode();
    const res = await convert('/pve1/qemu/100');
    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ error: 'writes-disabled-in-token-mode' });
    expect(fakePve.templateCalls).toHaveLength(0);
  });

  it('401s without a session', async () => {
    await setupSession();
    const res = await convert('/pve1/qemu/100');
    expect(res.statusCode).toBe(401);
    expect(fakePve.templateCalls).toHaveLength(0);
  });

  it('rejects an invalid type (400)', async () => {
    const cookie = await setupSession();
    const res = await convert('/pve1/bogus/100', { cookie });
    expect(res.statusCode).toBe(400);
  });

  it('rejects an unknown body field (400)', async () => {
    const cookie = await setupSession();
    fakePve.setClusterResources(baseResources());
    fakePve.setVmPermissions(100, { 'VM.Allocate': true });
    const res = await convert('/pve1/qemu/100', { cookie, payload: { disk: 'scsi0' } });
    expect(res.statusCode).toBe(400);
    expect(fakePve.templateCalls).toHaveLength(0);
  });

  it('404s not-found when the guest is not in the cluster', async () => {
    const cookie = await setupSession();
    fakePve.setClusterResources(baseResources());
    fakePve.setVmPermissions(999, { 'VM.Allocate': true });
    const res = await convert('/pve1/qemu/999', { cookie });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: 'not-found' });
    expect(fakePve.templateCalls).toHaveLength(0);
  });

  it('404s not-found when the vmid exists under the other guest type', async () => {
    const cookie = await setupSession();
    fakePve.setClusterResources(baseResources());
    fakePve.setVmPermissions(100, { 'VM.Allocate': true });
    const res = await convert('/pve1/lxc/100', { cookie });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: 'not-found' });
  });

  it('400s already-template for a guest that is already a template', async () => {
    const cookie = await setupSession();
    fakePve.setClusterResources(baseResources({ qemuTemplate: true }));
    fakePve.setVmPermissions(100, { 'VM.Allocate': true });
    const res = await convert('/pve1/qemu/100', { cookie });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: 'already-template' });
    expect(fakePve.templateCalls).toHaveLength(0);
  });

  it('400s guest-running for a running guest', async () => {
    const cookie = await setupSession();
    fakePve.setClusterResources(baseResources({ qemuStatus: 'running' }));
    fakePve.setVmPermissions(100, { 'VM.Allocate': true });
    const res = await convert('/pve1/qemu/100', { cookie });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: 'guest-running' });
    expect(fakePve.templateCalls).toHaveLength(0);
  });

  it('400s guest-running for a paused guest', async () => {
    const cookie = await setupSession();
    fakePve.setClusterResources(baseResources({ qemuStatus: 'paused' }));
    fakePve.setVmPermissions(100, { 'VM.Allocate': true });
    const res = await convert('/pve1/qemu/100', { cookie });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: 'guest-running' });
  });

  it('403s missing VM.Allocate, naming it', async () => {
    const cookie = await setupSession();
    fakePve.setClusterResources(baseResources());
    const res = await convert('/pve1/qemu/100', { cookie });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ error: 'forbidden', missing: 'VM.Allocate' });
    expect(fakePve.templateCalls).toHaveLength(0);
  });

  it('qemu: 202 with the upid, posting exactly /nodes/pve1/qemu/100/template with no body', async () => {
    const cookie = await setupSession();
    fakePve.setClusterResources(baseResources());
    fakePve.setVmPermissions(100, { 'VM.Allocate': true });

    const res = await convert('/pve1/qemu/100', { cookie, payload: {} });

    expect(res.statusCode).toBe(202);
    expect(res.json()).toEqual({ upid: 'UPID:fakepve:00000001:00000000:00000000:qmtemplate:100:root@pam:' });
    expect(fakePve.templateCalls).toStrictEqual([{ type: 'qemu', vmid: 100, body: {} }]);
  });

  it('lxc: 200 { ok } (PVE returns null), posting exactly /nodes/pve1/lxc/200/template', async () => {
    const cookie = await setupSession();
    fakePve.setClusterResources(baseResources());
    fakePve.setVmPermissions(200, { 'VM.Allocate': true });

    const res = await convert('/pve1/lxc/200', { cookie });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
    expect(fakePve.templateCalls).toStrictEqual([{ type: 'lxc', vmid: 200, body: {} }]);
  });

  it('surfaces a PVE 4xx as pve-rejected with the sanitized message', async () => {
    const cookie = await setupSession();
    fakePve.setClusterResources(baseResources());
    fakePve.setVmPermissions(100, { 'VM.Allocate': true });
    fakePve.setTemplateError('qemu', 100, 400, 'VM is locked (backup)');

    const res = await convert('/pve1/qemu/100', { cookie });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: 'pve-rejected', message: 'VM is locked (backup)' });
  });

  it('maps a PVE 5xx to 502 pve-unreachable without leaking the message', async () => {
    const cookie = await setupSession();
    fakePve.setClusterResources(baseResources());
    fakePve.setVmPermissions(100, { 'VM.Allocate': true });
    fakePve.setTemplateError('qemu', 100, 500, 'internal secret detail');

    const res = await convert('/pve1/qemu/100', { cookie });

    expect(res.statusCode).toBe(502);
    expect(res.json()).toEqual({ error: 'pve-unreachable' });
  });
});
