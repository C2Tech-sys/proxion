import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';

const webDistDir = path.resolve(import.meta.dirname, 'fixtures/web-dist');

describe('SPA fallback (production mode)', () => {
  let app: FastifyInstance;

  afterEach(async () => {
    await app?.close();
  });

  async function setup() {
    app = await buildApp({
      config: loadConfig({
        NODE_ENV: 'production',
        PVE_URL: 'https://127.0.0.1:1',
        SESSION_SECRET: 'x'.repeat(32),
      }),
      webDistDir,
    });
  }

  it('serves index.html for a GET to an unknown client-side route', async () => {
    await setup();
    const response = await app.inject({ method: 'GET', url: '/vms/100/summary' });
    expect(response.statusCode).toBe(200);
    expect(response.body).toContain('Proxion SPA shell');
  });

  it('serves index.html for a HEAD to an unknown client-side route', async () => {
    await setup();
    const response = await app.inject({ method: 'HEAD', url: '/vms/100/summary' });
    expect(response.statusCode).toBe(200);
  });

  it('serves an existing asset file', async () => {
    await setup();
    const response = await app.inject({ method: 'GET', url: '/assets/app.js' });
    expect(response.statusCode).toBe(200);
    expect(response.body).toContain('fixture asset');
  });

  it('returns 404 JSON (never index.html) for a missing asset', async () => {
    await setup();
    const response = await app.inject({ method: 'GET', url: '/assets/does-not-exist.js' });
    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ ok: false, error: 'Not Found' });
  });

  it('returns 404 JSON for an unknown API path, regardless of method', async () => {
    await setup();
    const getResponse = await app.inject({ method: 'GET', url: '/api/does-not-exist' });
    expect(getResponse.statusCode).toBe(404);
    expect(getResponse.json()).toEqual({ ok: false, error: 'Not Found' });

    const postResponse = await app.inject({ method: 'POST', url: '/api/does-not-exist' });
    expect(postResponse.statusCode).toBe(404);
  });

  it('returns 405 JSON (never index.html) for a non-GET/HEAD request to a client-side route', async () => {
    await setup();
    const response = await app.inject({ method: 'POST', url: '/vms/100/summary' });
    expect(response.statusCode).toBe(405);
    expect(response.json()).toEqual({ ok: false, error: 'Method Not Allowed' });
    expect(response.body).not.toContain('Proxion SPA shell');
  });

  it('serves index.html for a client-side route that merely starts with "api" or "ws" (not an actual /api or /ws path)', async () => {
    await setup();
    for (const url of ['/apiary', '/ws-help', '/apis', '/wsdocs']) {
      const response = await app.inject({ method: 'GET', url });
      expect(response.statusCode, `GET ${url}`).toBe(200);
      expect(response.body, `GET ${url}`).toContain('Proxion SPA shell');
    }
  });

  it('still 404s exact /api and /ws, and real /api/* and /ws/* prefixes', async () => {
    await setup();
    for (const url of ['/api', '/ws', '/api/does-not-exist', '/ws/does-not-exist']) {
      const response = await app.inject({ method: 'GET', url });
      expect(response.statusCode, `GET ${url}`).toBe(404);
      expect(response.json(), `GET ${url}`).toEqual({ ok: false, error: 'Not Found' });
    }
  });

  // buildApp's resolution order is `options.webDistDir ?? config.PROXION_WEB_DIST ?? <default>`
  // (see app.ts), but every other test in this file passes `webDistDir` directly, so it never
  // actually exercises the `config.PROXION_WEB_DIST` branch -- a regression that dropped it from
  // the chain would still pass every test above.
  it('falls back to config.PROXION_WEB_DIST when no webDistDir option is given', async () => {
    app = await buildApp({
      config: loadConfig({
        NODE_ENV: 'production',
        PVE_URL: 'https://127.0.0.1:1',
        SESSION_SECRET: 'x'.repeat(32),
        PROXION_WEB_DIST: webDistDir,
      }),
    });

    const response = await app.inject({ method: 'GET', url: '/' });
    expect(response.statusCode).toBe(200);
    expect(response.body).toContain('Proxion SPA shell');
  });
});
