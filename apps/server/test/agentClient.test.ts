import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { PNG } from 'pngjs';
import { afterEach, describe, expect, it } from 'vitest';
import { fetchAgentHealth, fetchAgentScreenshot } from '../src/console/agentClient.js';

const TOKEN = 'test-token';

/** A tiny known PNG: 4x3, solid, with one distinct pixel at (1,1) for a pixel-level assertion. */
function makePng(): Buffer {
  const png = new PNG({ width: 4, height: 3 });
  for (let y = 0; y < png.height; y++) {
    for (let x = 0; x < png.width; x++) {
      const off = (png.width * y + x) << 2;
      png.data[off] = 10;
      png.data[off + 1] = 20;
      png.data[off + 2] = 30;
      png.data[off + 3] = 255;
    }
  }
  // A distinct pixel to assert decoding preserves per-pixel data, not just size.
  const markerOff = (png.width * 1 + 1) << 2;
  png.data[markerOff] = 200;
  png.data[markerOff + 1] = 100;
  png.data[markerOff + 2] = 50;
  png.data[markerOff + 3] = 255;
  return PNG.sync.write(png);
}

type Handler = (req: IncomingMessage, res: ServerResponse) => void;

async function startFakeAgent(handler: Handler): Promise<{ baseUrl: string; close: () => Promise<void> }> {
  const server = http.createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

let activeAgent: { baseUrl: string; close: () => Promise<void> } | undefined;

afterEach(async () => {
  await activeAgent?.close();
  activeAgent = undefined;
});

describe('fetchAgentScreenshot', () => {
  it('200 PNG: decodes to a frame with the correct size and a known pixel', async () => {
    const png = makePng();
    activeAgent = await startFakeAgent((req, res) => {
      expect(req.headers.authorization).toBe(`Bearer ${TOKEN}`);
      res.writeHead(200, {
        'content-type': 'image/png',
        'x-proxion-agent-captured-at': '2026-01-01T00:00:00.000Z',
        'x-proxion-agent-width': '4',
        'x-proxion-agent-height': '3',
      });
      res.end(png);
    });

    const result = await fetchAgentScreenshot(activeAgent.baseUrl, TOKEN, 113, { timeoutMs: 2000 });

    expect(result.kind).toBe('ok');
    if (result.kind !== 'ok') throw new Error('unreachable');
    expect(result.frame.width).toBe(4);
    expect(result.frame.height).toBe(3);
    expect(result.capturedAt.toISOString()).toBe('2026-01-01T00:00:00.000Z');
    const markerOff = (result.frame.width * 1 + 1) << 2;
    expect([...result.frame.data.subarray(markerOff, markerOff + 4)]).toEqual([200, 100, 50, 255]);
  });

  it('falls back to the current time when the captured-at header is missing', async () => {
    const png = makePng();
    activeAgent = await startFakeAgent((_req, res) => {
      res.writeHead(200, { 'content-type': 'image/png' });
      res.end(png);
    });

    const before = Date.now();
    const result = await fetchAgentScreenshot(activeAgent.baseUrl, TOKEN, 113, { timeoutMs: 2000 });
    if (result.kind !== 'ok') throw new Error('unreachable');
    expect(result.capturedAt.getTime()).toBeGreaterThanOrEqual(before);
  });

  it('401: reason "agent-unauthorized"', async () => {
    activeAgent = await startFakeAgent((_req, res) => {
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'unauthorized' }));
    });

    const result = await fetchAgentScreenshot(activeAgent.baseUrl, TOKEN, 113, { timeoutMs: 2000 });
    expect(result).toEqual({ kind: 'failed', reason: 'agent-unauthorized' });
  });

  it('404: kind "not-running"', async () => {
    activeAgent = await startFakeAgent((_req, res) => {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'not-running' }));
    });

    const result = await fetchAgentScreenshot(activeAgent.baseUrl, TOKEN, 113, { timeoutMs: 2000 });
    expect(result).toEqual({ kind: 'not-running' });
  });

  it('503 busy: reason from the body\'s error field', async () => {
    activeAgent = await startFakeAgent((_req, res) => {
      res.writeHead(503, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'busy' }));
    });

    const result = await fetchAgentScreenshot(activeAgent.baseUrl, TOKEN, 113, { timeoutMs: 2000 });
    expect(result).toEqual({ kind: 'failed', reason: 'busy' });
  });

  it('503 capture-failed: reason from the body\'s error field', async () => {
    activeAgent = await startFakeAgent((_req, res) => {
      res.writeHead(503, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'capture-failed' }));
    });

    const result = await fetchAgentScreenshot(activeAgent.baseUrl, TOKEN, 113, { timeoutMs: 2000 });
    expect(result).toEqual({ kind: 'failed', reason: 'capture-failed' });
  });

  it('timeout: reason "agent-timeout"', async () => {
    activeAgent = await startFakeAgent((_req, res) => {
      // Never respond -- the request should abort on the client's timeout.
      void res;
    });

    const result = await fetchAgentScreenshot(activeAgent.baseUrl, TOKEN, 113, { timeoutMs: 30 });
    expect(result).toEqual({ kind: 'failed', reason: 'agent-timeout' });
  });

  it('non-PNG body: reason "agent-bad-image"', async () => {
    activeAgent = await startFakeAgent((_req, res) => {
      res.writeHead(200, { 'content-type': 'image/png' });
      res.end('not actually a png');
    });

    const result = await fetchAgentScreenshot(activeAgent.baseUrl, TOKEN, 113, { timeoutMs: 2000 });
    expect(result).toEqual({ kind: 'failed', reason: 'agent-bad-image' });
  });

  it('network error (nothing listening): reason "agent-unreachable"', async () => {
    // Port 1 is a reserved, never-listening port -- connection is refused immediately.
    const result = await fetchAgentScreenshot('http://127.0.0.1:1', TOKEN, 113, { timeoutMs: 2000 });
    expect(result).toEqual({ kind: 'failed', reason: 'agent-unreachable' });
  });

  it('400 bad-vmid: reported as failed with the body\'s error as reason', async () => {
    activeAgent = await startFakeAgent((_req, res) => {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'bad-vmid' }));
    });

    const result = await fetchAgentScreenshot(activeAgent.baseUrl, TOKEN, 113, { timeoutMs: 2000 });
    expect(result).toEqual({ kind: 'failed', reason: 'bad-vmid' });
  });

  it('never logs the token', async () => {
    // The Authorization header itself is asserted inline above; this test just
    // confirms a failure path doesn't leak the token into the returned reason.
    activeAgent = await startFakeAgent((_req, res) => {
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'unauthorized' }));
    });

    const result = await fetchAgentScreenshot(activeAgent.baseUrl, 'super-secret-token', 113, {
      timeoutMs: 2000,
    });
    expect(JSON.stringify(result)).not.toContain('super-secret-token');
  });
});

describe('fetchAgentHealth', () => {
  it('200 { ok: true, version }: reported as ok with the version', async () => {
    activeAgent = await startFakeAgent((req, res) => {
      expect(req.headers.authorization).toBe(`Bearer ${TOKEN}`);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, agent: 'proxion-agent', version: '0.1.0', hostname: 'pve1' }));
    });

    const result = await fetchAgentHealth(activeAgent.baseUrl, TOKEN, { timeoutMs: 2000 });
    expect(result).toEqual({ kind: 'ok', version: '0.1.0', hostname: 'pve1' });
  });

  it('non-200: reported as failed', async () => {
    activeAgent = await startFakeAgent((_req, res) => {
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'unauthorized' }));
    });

    const result = await fetchAgentHealth(activeAgent.baseUrl, TOKEN, { timeoutMs: 2000 });
    expect(result).toEqual({ kind: 'failed' });
  });

  it('timeout: reported as failed', async () => {
    activeAgent = await startFakeAgent((_req, res) => {
      void res;
    });

    const result = await fetchAgentHealth(activeAgent.baseUrl, TOKEN, { timeoutMs: 30 });
    expect(result).toEqual({ kind: 'failed' });
  });

  it('network error: reported as failed', async () => {
    const result = await fetchAgentHealth('http://127.0.0.1:1', TOKEN, { timeoutMs: 2000 });
    expect(result).toEqual({ kind: 'failed' });
  });
});
