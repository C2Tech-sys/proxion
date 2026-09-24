import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';

describe('GET /api/health', () => {
  it('returns ok, name, and version', async () => {
    const app = await buildApp({
      config: loadConfig({ NODE_ENV: 'test', PVE_URL: 'https://127.0.0.1:1' }),
    });

    const response = await app.inject({ method: 'GET', url: '/api/health' });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      ok: true,
      name: 'proxion',
      version: expect.any(String),
    });

    await app.close();
  });
});
