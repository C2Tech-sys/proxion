import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { PNG } from 'pngjs';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { startFakePve, type FakePve } from './helpers/fakePve.js';
import { attachFakePveWs } from './helpers/fakePveWs.js';
import { scriptedRfbServer } from './helpers/fakeRfbServer.js';

const FRAMEBUFFER_WIDTH = 64;
const FRAMEBUFFER_HEIGHT = 48;

describe('console thumbnails', () => {
  let fakePve: FakePve;
  let app: FastifyInstance;
  let baseUrl: string;
  let wsClose: (() => void) | undefined;

  afterEach(async () => {
    wsClose?.();
    await app?.close();
    await fakePve?.close();
  });

  async function setup(rfbOptions: Partial<Parameters<typeof scriptedRfbServer>[0]> = {}) {
    fakePve = await startFakePve();
    const { onConnection } = scriptedRfbServer({
      width: FRAMEBUFFER_WIDTH,
      height: FRAMEBUFFER_HEIGHT,
      password: 'VNCTICKET', // matches fakePve's hardcoded vncproxy ticket
      ...rfbOptions,
    });
    const attached = attachFakePveWs(fakePve.app.server, onConnection);
    wsClose = attached.close;

    app = await buildApp({
      config: loadConfig({
        NODE_ENV: 'test',
        PVE_URL: fakePve.url,
        PVE_TOKEN_ID: 'root@pam!proxion',
        PVE_TOKEN_SECRET: 'tokensecret',
        PROXION_ALLOW_TOKEN_MODE: 'true',
      }),
    });
    baseUrl = await app.listen({ port: 0, host: '127.0.0.1' });
  }

  async function fetchThumbnail(
    path: string,
    init?: RequestInit,
  ): Promise<{ status: number; headers: Headers; body: Buffer }> {
    const res = await fetch(`${baseUrl}${path}`, init);
    const body = Buffer.from(await res.arrayBuffer());
    return { status: res.status, headers: res.headers, body };
  }

  it('captures a live thumbnail: valid downscaled PNG with the expected quadrant colours', async () => {
    await setup();

    const res = await fetchThumbnail('/api/console/thumbnail/node1/qemu/100.png?w=32');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/png');
    expect(res.headers.get('x-proxion-source')).toBe('live');
    expect(res.headers.get('cache-control')).toBe('private, max-age=30');
    expect(res.headers.get('x-proxion-captured-at')).toMatch(/^\d{4}-\d{2}-\d{2}T/);

    const png = PNG.sync.read(res.body);
    expect(png.width).toBe(32);
    expect(png.height).toBe(24); // 48 * (32/64), aspect preserved

    const pixelAt = (x: number, y: number) => {
      const idx = (png.width * y + x) << 2;
      return [png.data[idx], png.data[idx + 1], png.data[idx + 2]];
    };

    expect(pixelAt(0, 0)).toEqual([255, 0, 0]); // top-left: red
    expect(pixelAt(png.width - 1, 0)).toEqual([0, 255, 0]); // top-right: green
    expect(pixelAt(0, png.height - 1)).toEqual([0, 0, 255]); // bottom-left: blue
    expect(pixelAt(png.width - 1, png.height - 1)).toEqual([255, 255, 0]); // bottom-right: yellow
  });

  it('never upscales: a requested width wider than the source framebuffer returns the source size', async () => {
    await setup();
    const res = await fetchThumbnail('/api/console/thumbnail/node1/qemu/100.png?w=400');
    expect(res.status).toBe(200);
    const png = PNG.sync.read(res.body);
    expect(png.width).toBe(FRAMEBUFFER_WIDTH);
    expect(png.height).toBe(FRAMEBUFFER_HEIGHT);
  });

  it('401s with no identity', async () => {
    fakePve = await startFakePve();
    app = await buildApp({
      config: loadConfig({ NODE_ENV: 'test', PVE_URL: fakePve.url }), // no token mode
    });
    baseUrl = await app.listen({ port: 0, host: '127.0.0.1' });

    const res = await fetchThumbnail('/api/console/thumbnail/node1/qemu/100.png');
    expect(res.status).toBe(401);

    const status = await fetchThumbnail('/api/console/thumbnail/status');
    expect(status.status).toBe(401);
  });

  it('403s when the caller lacks VM.Console', async () => {
    await setup();
    fakePve.setVmConsolePermission(100, false);

    const res = await fetchThumbnail('/api/console/thumbnail/node1/qemu/100.png');
    expect(res.status).toBe(403);
  });

  it('404s with not-running (and no-store) when the guest is stopped', async () => {
    await setup();
    fakePve.setVmStatus('qemu', 100, 'stopped');

    const res = await fetchThumbnail('/api/console/thumbnail/node1/qemu/100.png');
    expect(res.status).toBe(404);
    const body = JSON.parse(res.body.toString('utf8'));
    expect(body).toEqual({ error: 'not-running' });
    expect(res.headers.get('cache-control')).toBe('no-store');
  });

  it('serves a cache hit on the second request within the TTL, without another live capture', async () => {
    await setup();

    const first = await fetchThumbnail('/api/console/thumbnail/node1/qemu/100.png?w=32');
    expect(first.status).toBe(200);
    expect(first.headers.get('x-proxion-source')).toBe('live');
    expect(fakePve.vncproxyCalls).toBe(1);

    const second = await fetchThumbnail('/api/console/thumbnail/node1/qemu/100.png?w=32');
    expect(second.status).toBe(200);
    expect(second.headers.get('x-proxion-source')).toBe('cache');
    expect(fakePve.vncproxyCalls).toBe(1); // no new vncproxy call -- served from cache
    expect(second.body.equals(first.body)).toBe(true);
  });

  it('a different width is derived from the same capture (one VNC session per guest)', async () => {
    await setup();
    await fetchThumbnail('/api/console/thumbnail/node1/qemu/100.png?w=32');
    expect(fakePve.vncproxyCalls).toBe(1);

    const res = await fetchThumbnail('/api/console/thumbnail/node1/qemu/100.png?w=16');
    expect(res.status).toBe(200);
    expect(res.headers.get('x-proxion-source')).toBe('cache');
    expect(fakePve.vncproxyCalls).toBe(1);
    expect(PNG.sync.read(res.body).width).toBe(16);
  });

  it('refresh=1 throttles repeated live captures to one per VM per 15s, falling back to cache', async () => {
    await setup();

    const first = await fetchThumbnail('/api/console/thumbnail/node1/qemu/100.png?w=32&refresh=1');
    expect(first.status).toBe(200);
    expect(first.headers.get('x-proxion-source')).toBe('live');
    expect(fakePve.vncproxyCalls).toBe(1);

    const second = await fetchThumbnail('/api/console/thumbnail/node1/qemu/100.png?w=32&refresh=1');
    expect(second.status).toBe(200);
    expect(second.headers.get('x-proxion-source')).toBe('cache');
    expect(fakePve.vncproxyCalls).toBe(1); // throttled -- no second live capture
  });

  it('reports status: inFlight and cached entries', async () => {
    await setup();
    await fetchThumbnail('/api/console/thumbnail/node1/qemu/100.png?w=32');

    const res = await fetchThumbnail('/api/console/thumbnail/status');
    expect(res.status).toBe(200);
    const body = JSON.parse(res.body.toString('utf8')) as {
      inFlight: number;
      cached: Array<{ node: string; type: string; vmid: number; capturedAt: string }>;
    };
    expect(body.inFlight).toBe(0);
    expect(body.cached).toEqual([
      expect.objectContaining({ node: 'node1', type: 'qemu', vmid: 100 }),
    ]);
  });

  it('503s capture-failed when the RFB handshake fails (wrong VNC auth)', async () => {
    await setup({ forceAuthFailure: true });

    const res = await fetchThumbnail('/api/console/thumbnail/node1/qemu/100.png');
    expect(res.status).toBe(503);
    const body = JSON.parse(res.body.toString('utf8'));
    expect(body).toEqual({ error: 'capture-failed' });
    expect(res.headers.get('cache-control')).toBe('no-store');
  });

  it('maps the thumbnail service reporting "busy" to a 503 (concurrency limit is enforced in thumbnailService.test.ts)', async () => {
    await setup();
    // Swap in a stand-in service to test the route's mapping in isolation --
    // the concurrency semaphore/queue itself is exercised directly (with
    // fast, injectable timeouts) in thumbnailService.test.ts.
    app.consoleThumbnails = {
      inFlight: 3,
      get: async () => ({ kind: 'busy' as const }),
      listCached: () => [],
    } as unknown as FastifyInstance['consoleThumbnails'];

    const res = await fetchThumbnail('/api/console/thumbnail/node1/qemu/100.png');
    expect(res.status).toBe(503);
    expect(JSON.parse(res.body.toString('utf8'))).toEqual({ error: 'busy' });
  });

  it('sets X-Proxion-Capture: vnc on a successful VNC capture (no agent configured)', async () => {
    await setup();
    const res = await fetchThumbnail('/api/console/thumbnail/node1/qemu/100.png?w=32');
    expect(res.status).toBe(200);
    expect(res.headers.get('x-proxion-capture')).toBe('vnc');
  });

  it('maps the thumbnail service reporting "not-running" (from the agent, authoritative at capture time) to a 404', async () => {
    await setup();
    app.consoleThumbnails = {
      inFlight: 0,
      get: async () => ({ kind: 'not-running' as const }),
      listCached: () => [],
      listAgentStatus: async () => [],
    } as unknown as FastifyInstance['consoleThumbnails'];

    const res = await fetchThumbnail('/api/console/thumbnail/node1/qemu/100.png');
    expect(res.status).toBe(404);
    expect(JSON.parse(res.body.toString('utf8'))).toEqual({ error: 'not-running' });
    expect(res.headers.get('cache-control')).toBe('no-store');
  });

  it('reports status: agents is an empty array when none are configured', async () => {
    await setup();
    const res = await fetchThumbnail('/api/console/thumbnail/status');
    expect(res.status).toBe(200);
    const body = JSON.parse(res.body.toString('utf8')) as { agents: unknown[] };
    expect(body.agents).toEqual([]);
  });
});
