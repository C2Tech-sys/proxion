import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance, InjectOptions } from 'fastify';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { startFakePve, type FakePve } from './helpers/fakePve.js';

describe('node power action routes', () => {
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

  function nodeAction(
    node: string,
    command: string,
    options: { cookie?: string; payload?: Record<string, unknown> } = {},
  ) {
    const injectOptions: InjectOptions = { method: 'POST', url: `/api/actions/node/${node}/${command}` };
    if (options.cookie !== undefined) injectOptions.headers = { cookie: options.cookie };
    if (options.payload !== undefined) injectOptions.payload = options.payload;
    return app.inject(injectOptions);
  }

  it('403s in token mode', async () => {
    await setupTokenMode();
    const res = await nodeAction('pve1', 'reboot');
    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ error: 'writes-disabled-in-token-mode' });
  });

  it('403s a session that lacks Sys.PowerMgmt', async () => {
    const cookie = await setupSession();
    // No `setNodePermissions` call: Sys.PowerMgmt is absent by default (unlike the vm path,
    // the node permissions path has no default grants at all -- see fakePve.ts).
    const res = await nodeAction('pve1', 'reboot', { cookie });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ error: 'forbidden', missing: 'Sys.PowerMgmt' });
  });

  it('rejects an invalid node name', async () => {
    const cookie = await setupSession();
    const res = await nodeAction('not a node!', 'reboot', { cookie });
    expect(res.statusCode).toBe(400);
  });

  it('rejects an invalid command', async () => {
    const cookie = await setupSession();
    fakePve.setNodePermissions('pve1', { 'Sys.PowerMgmt': true });
    const res = await nodeAction('pve1', 'poweroff', { cookie });
    expect(res.statusCode).toBe(400);
  });

  it('rejects an unknown body field', async () => {
    const cookie = await setupSession();
    fakePve.setNodePermissions('pve1', { 'Sys.PowerMgmt': true });
    const res = await nodeAction('pve1', 'reboot', { cookie, payload: { force: true } });
    expect(res.statusCode).toBe(400);
  });

  it('reboot: 202 { ok: true }, and PVE received command=reboot', async () => {
    const cookie = await setupSession();
    fakePve.setNodePermissions('pve1', { 'Sys.PowerMgmt': true });

    const res = await nodeAction('pve1', 'reboot', { cookie });

    expect(res.statusCode).toBe(202);
    expect(res.json()).toEqual({ ok: true });

    const call = fakePve.nodeStatusCalls.at(-1);
    expect(call?.node).toBe('pve1');
    expect(call?.body).toEqual({ command: 'reboot' });
  });

  it('shutdown: 202 { ok: true }, and PVE received command=shutdown', async () => {
    const cookie = await setupSession();
    fakePve.setNodePermissions('pve1', { 'Sys.PowerMgmt': true });

    const res = await nodeAction('pve1', 'shutdown', { cookie });

    expect(res.statusCode).toBe(202);
    expect(res.json()).toEqual({ ok: true });

    const call = fakePve.nodeStatusCalls.at(-1);
    expect(call?.node).toBe('pve1');
    expect(call?.body).toEqual({ command: 'shutdown' });
  });

  it('maps a PVE error to a sanitised message with the PVE status code', async () => {
    const cookie = await setupSession();
    fakePve.setNodePermissions('pve1', { 'Sys.PowerMgmt': true });
    fakePve.setNodeStatusError('pve1', 400, 'node is already rebooting\x00');

    const res = await nodeAction('pve1', 'reboot', { cookie });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: 'pve-rejected', message: 'node is already rebooting' });
  });

  it('rate-limits at 30 requests/minute per session', async () => {
    const cookie = await setupSession();
    fakePve.setNodePermissions('pve1', { 'Sys.PowerMgmt': true });

    let last;
    for (let i = 0; i < 31; i++) {
      last = await nodeAction('pve1', 'reboot', { cookie });
    }
    expect(last!.statusCode).toBe(429);
  });
});
