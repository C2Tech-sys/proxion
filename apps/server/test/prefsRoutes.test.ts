import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { startFakePve, type FakePve } from './helpers/fakePve.js';

function cookieFrom(setCookieHeader: string | string[] | undefined): string {
  const raw = Array.isArray(setCookieHeader) ? setCookieHeader[0] : setCookieHeader;
  if (!raw) throw new Error('no Set-Cookie header');
  return raw.split(';')[0]!;
}

describe('/api/prefs', () => {
  let fakePve: FakePve;
  let app: FastifyInstance;

  afterEach(async () => {
    await app?.close();
    await fakePve?.close();
  });

  async function setup(extraEnv: Record<string, string> = {}) {
    fakePve = await startFakePve();
    app = await buildApp({ config: loadConfig({ NODE_ENV: 'test', PVE_URL: fakePve.url, ...extraEnv }) });
  }

  async function loginCookie(): Promise<string> {
    const login = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { username: 'root@pam', password: 'goodpass' },
    });
    return cookieFrom(login.headers['set-cookie']);
  }

  it('GET /api/prefs is 401 with no identity', async () => {
    await setup();
    const res = await app.inject({ method: 'GET', url: '/api/prefs' });
    expect(res.statusCode).toBe(401);
  });

  it('PUT/PATCH /api/prefs are 401 with no identity', async () => {
    await setup();
    const put = await app.inject({ method: 'PUT', url: '/api/prefs', payload: { theme: 'dark' } });
    expect(put.statusCode).toBe(401);
    const patch = await app.inject({ method: 'PATCH', url: '/api/prefs', payload: { theme: 'dark' } });
    expect(patch.statusCode).toBe(401);
  });

  it('GET /api/prefs returns all-defaults (plus readOnly: false) for a session with nothing saved yet', async () => {
    await setup();
    const cookie = await loginCookie();
    const res = await app.inject({ method: 'GET', url: '/api/prefs', headers: { cookie } });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toMatchObject({
      theme: 'system',
      defaultRange: 'hour',
      consoleThumbnails: true,
      thumbnailRefreshSeconds: 60,
      density: 'comfortable',
      readOnly: false,
    });
  });

  it('PUT then GET round-trips a full document', async () => {
    await setup();
    const cookie = await loginCookie();
    const put = await app.inject({
      method: 'PUT',
      url: '/api/prefs',
      headers: { cookie },
      payload: {
        version: 1,
        theme: 'dark',
        defaultRange: 'month',
        consoleThumbnails: false,
        thumbnailRefreshSeconds: 300,
        density: 'compact',
      },
    });
    expect(put.statusCode).toBe(200);
    expect(put.json().theme).toBe('dark');

    const get = await app.inject({ method: 'GET', url: '/api/prefs', headers: { cookie } });
    expect(get.json()).toMatchObject({ theme: 'dark', defaultRange: 'month', density: 'compact' });
  });

  it('PATCH applies a partial update and returns the merged document', async () => {
    await setup();
    const cookie = await loginCookie();
    const patch = await app.inject({
      method: 'PATCH',
      url: '/api/prefs',
      headers: { cookie },
      payload: { theme: 'light' },
    });
    expect(patch.statusCode).toBe(200);
    expect(patch.json()).toMatchObject({ theme: 'light', defaultRange: 'hour' });
  });

  it('PUT with an invalid document is 400 and writes nothing', async () => {
    await setup();
    const cookie = await loginCookie();
    const res = await app.inject({
      method: 'PUT',
      url: '/api/prefs',
      headers: { cookie },
      payload: { theme: 'rainbow' },
    });
    expect(res.statusCode).toBe(400);

    const get = await app.inject({ method: 'GET', url: '/api/prefs', headers: { cookie } });
    expect(get.json().theme).toBe('system');
  });

  it('PATCH with an invalid value is 400', async () => {
    await setup();
    const cookie = await loginCookie();
    const res = await app.inject({
      method: 'PATCH',
      url: '/api/prefs',
      headers: { cookie },
      payload: { thumbnailRefreshSeconds: 45 },
    });
    expect(res.statusCode).toBe(400);
  });

  it('PATCH accepts a valid summaryLayout and preserves other previously-set fields', async () => {
    await setup();
    const cookie = await loginCookie();
    await app.inject({
      method: 'PATCH',
      url: '/api/prefs',
      headers: { cookie },
      payload: { theme: 'dark' },
    });

    const patch = await app.inject({
      method: 'PATCH',
      url: '/api/prefs',
      headers: { cookie },
      payload: { summaryLayout: { qemu: ['notes', 'console', 'guest'] } },
    });
    expect(patch.statusCode).toBe(200);
    expect(patch.json()).toMatchObject({
      theme: 'dark',
      summaryLayout: { qemu: ['notes', 'console', 'guest'] },
    });

    const get = await app.inject({ method: 'GET', url: '/api/prefs', headers: { cookie } });
    expect(get.json()).toMatchObject({
      theme: 'dark',
      summaryLayout: { qemu: ['notes', 'console', 'guest'] },
    });
  });

  it('PATCH with summaryLayout: {} clears a previously-saved order', async () => {
    await setup();
    const cookie = await loginCookie();
    await app.inject({
      method: 'PATCH',
      url: '/api/prefs',
      headers: { cookie },
      payload: { summaryLayout: { qemu: ['notes'] } },
    });
    const patch = await app.inject({
      method: 'PATCH',
      url: '/api/prefs',
      headers: { cookie },
      payload: { summaryLayout: {} },
    });
    expect(patch.statusCode).toBe(200);
    expect(patch.json().summaryLayout).toEqual({});
  });

  it('PATCH with more than 24 summaryLayout entries is 400', async () => {
    await setup();
    const cookie = await loginCookie();
    const tooMany = Array.from({ length: 25 }, (_, i) => `panel-${i}`);
    const res = await app.inject({
      method: 'PATCH',
      url: '/api/prefs',
      headers: { cookie },
      payload: { summaryLayout: { qemu: tooMany } },
    });
    expect(res.statusCode).toBe(400);
  });

  it('PATCH with a non-string summaryLayout entry is 400', async () => {
    await setup();
    const cookie = await loginCookie();
    const res = await app.inject({
      method: 'PATCH',
      url: '/api/prefs',
      headers: { cookie },
      payload: { summaryLayout: { qemu: ['notes', 42] } },
    });
    expect(res.statusCode).toBe(400);
  });

  it('token mode: GET returns read-only defaults, PUT/PATCH are 403', async () => {
    await setup({
      PVE_TOKEN_ID: 'root@pam!proxion',
      PVE_TOKEN_SECRET: 'tokensecret',
      PROXION_ALLOW_TOKEN_MODE: 'true',
    });

    const get = await app.inject({ method: 'GET', url: '/api/prefs' });
    expect(get.statusCode).toBe(200);
    expect(get.json()).toMatchObject({ theme: 'system', readOnly: true });

    const put = await app.inject({ method: 'PUT', url: '/api/prefs', payload: { theme: 'dark' } });
    expect(put.statusCode).toBe(403);
    expect(put.json()).toEqual({ error: 'prefs-read-only-in-token-mode' });

    const patch = await app.inject({ method: 'PATCH', url: '/api/prefs', payload: { theme: 'dark' } });
    expect(patch.statusCode).toBe(403);
    expect(patch.json()).toEqual({ error: 'prefs-read-only-in-token-mode' });
  });

  it('a session prefs write does not leak into token mode\'s identity', async () => {
    await setup({
      PVE_TOKEN_ID: 'root@pam!proxion',
      PVE_TOKEN_SECRET: 'tokensecret',
      PROXION_ALLOW_TOKEN_MODE: 'true',
    });
    const cookie = await loginCookie();
    await app.inject({
      method: 'PATCH',
      url: '/api/prefs',
      headers: { cookie },
      payload: { theme: 'dark' },
    });

    // No session cookie now -- falls through to the token identity, which is always read-only
    // defaults regardless of what the session wrote.
    const tokenGet = await app.inject({ method: 'GET', url: '/api/prefs' });
    expect(tokenGet.json()).toMatchObject({ theme: 'system', readOnly: true });
  });

  it('rate-limits writes to 20/min per session', async () => {
    await setup();
    const cookie = await loginCookie();
    for (let i = 0; i < 20; i++) {
      const res = await app.inject({
        method: 'PATCH',
        url: '/api/prefs',
        headers: { cookie },
        payload: { theme: i % 2 === 0 ? 'dark' : 'light' },
      });
      expect(res.statusCode).toBe(200);
    }
    const blocked = await app.inject({
      method: 'PATCH',
      url: '/api/prefs',
      headers: { cookie },
      payload: { theme: 'dark' },
    });
    expect(blocked.statusCode).toBe(429);
  });
});
