import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { PNG } from 'pngjs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FastifyBaseLogger } from 'fastify';
import type { Config } from '../src/config.js';
import type { PveIdentity } from '../src/pve/identity.js';
import {
  ConsoleThumbnailService,
  type CaptureFn,
  type ConsoleThumbnailServiceOptions,
} from '../src/console/thumbnailService.js';
import type { RfbFrame } from '../src/console/rfbSnapshot.js';
import { decodePng } from '../src/console/thumbnailImage.js';

/** A solid mid-grey RGBA frame standing in for a captured display. */
function frame(width = 8, height = 6): RfbFrame {
  return { width, height, data: Buffer.alloc(width * height * 4, 0x80) };
}

const fakeLog = { warn: vi.fn() } as unknown as FastifyBaseLogger;
const fakeIdentity = { username: 'root@pam!proxion' } as PveIdentity;

function makeService(
  captureImpl: CaptureFn,
  overrides: Omit<ConsoleThumbnailServiceOptions, 'captureImpl'> = {},
  config: Partial<Config> = {},
): ConsoleThumbnailService {
  return new ConsoleThumbnailService({ ...config } as Config, undefined, fakeLog, {
    maxConcurrentCaptures: 2,
    queueWaitMs: 10_000,
    throttleMs: 15_000,
    cacheTtlOkMs: 60_000,
    cacheTtlFailedMs: 15_000,
    captureImpl,
    ...overrides,
  });
}

function ctx(
  vmid: number,
  extra: Partial<{ refresh: boolean; width: number; type: 'qemu' | 'lxc'; node: string }> = {},
) {
  return {
    node: extra.node ?? 'node1',
    type: extra.type ?? ('qemu' as const),
    vmid,
    width: extra.width ?? 400,
    refresh: extra.refresh ?? false,
    identity: fakeIdentity,
  };
}

// --- Fake agent server (proxion-agent HTTP contract), for the capture-strategy tests below ---

const AGENT_TOKEN = 'agent-token';

type AgentHandler = (req: IncomingMessage, res: ServerResponse) => void;

async function startFakeAgent(handler: AgentHandler): Promise<{ baseUrl: string; close: () => Promise<void> }> {
  const server = http.createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise<void>((resolve) => {
        // A "never responds" handler leaves its connection open; force it shut rather
        // than waiting on a client-side timeout the test itself doesn't care about.
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
}

function agentPng(width = 4, height = 3): Buffer {
  const png = new PNG({ width, height });
  png.data.fill(0x40);
  return PNG.sync.write(png);
}

/** Like `makeService`, but with an injectable logger (for asserting `warn` calls). */
function makeServiceWithLog(
  captureImpl: CaptureFn,
  config: Partial<Config>,
  log: FastifyBaseLogger,
  overrides: Omit<ConsoleThumbnailServiceOptions, 'captureImpl'> = {},
): ConsoleThumbnailService {
  return new ConsoleThumbnailService(config as Config, undefined, log, {
    maxConcurrentCaptures: 2,
    queueWaitMs: 10_000,
    captureImpl,
    ...overrides,
  });
}

describe('ConsoleThumbnailService: concurrency limiter', () => {
  it('caps in-flight captures at maxConcurrentCaptures and runs a queued one once a slot frees', async () => {
    const resolvers: Array<(frame: RfbFrame) => void> = [];
    let calls = 0;
    const capture: CaptureFn = () =>
      new Promise((resolve) => {
        calls++;
        resolvers.push(resolve);
      });

    const service = makeService(capture, { maxConcurrentCaptures: 2, queueWaitMs: 5000 });

    const p1 = service.get(ctx(1));
    const p2 = service.get(ctx(2));
    const p3 = service.get(ctx(3)); // should queue -- only 2 slots

    await new Promise((r) => setTimeout(r, 20)); // let the microtask queue settle
    expect(service.inFlight).toBe(2);
    expect(calls).toBe(2);

    resolvers[0]!(frame());
    const r1 = await p1;
    expect(r1).toMatchObject({ kind: 'ok', source: 'live' });

    // The queued 3rd request should now have taken the freed slot.
    await new Promise((r) => setTimeout(r, 20));
    expect(calls).toBe(3);
    expect(service.inFlight).toBe(2);

    resolvers[1]!(frame());
    resolvers[2]!(frame());
    const [r2, r3] = await Promise.all([p2, p3]);
    expect(r2).toMatchObject({ kind: 'ok' });
    expect(r3).toMatchObject({ kind: 'ok' });
    expect(service.inFlight).toBe(0);
  });

  it('concurrent requests for the same guest join the capture already in flight', async () => {
    let resolveCapture: ((frame: RfbFrame) => void) | undefined;
    const capture = vi.fn<CaptureFn>(
      () =>
        new Promise((resolve) => {
          resolveCapture = resolve;
        }),
    );
    const service = makeService(capture, { maxConcurrentCaptures: 1 });

    const dashboardTile = service.get(ctx(1, { width: 400 }));
    const vmPage = service.get(ctx(1, { width: 800 }));
    const refreshClick = service.get(ctx(1, { width: 400, refresh: true }));
    await new Promise((r) => setTimeout(r, 10));
    expect(capture).toHaveBeenCalledTimes(1);
    expect(service.inFlight).toBe(1);

    resolveCapture!(frame(64, 48));
    const [a, b, c] = await Promise.all([dashboardTile, vmPage, refreshClick]);
    expect(a).toMatchObject({ kind: 'ok', source: 'live' });
    expect(b).toMatchObject({ kind: 'ok', source: 'live' });
    expect(c).toMatchObject({ kind: 'ok', source: 'live' });
    expect(capture).toHaveBeenCalledTimes(1);
    expect(service.inFlight).toBe(0);
  });

  it('returns "busy" when no slot frees up within queueWaitMs', async () => {
    const capture: CaptureFn = () => new Promise(() => {}); // never resolves -- holds its slot forever
    const service = makeService(capture, { maxConcurrentCaptures: 1, queueWaitMs: 40 });

    void service.get(ctx(1)); // occupies the only slot, deliberately not awaited (never settles)
    await new Promise((r) => setTimeout(r, 5)); // ensure it actually acquired the slot first

    const start = Date.now();
    const result = await service.get(ctx(2));
    const elapsed = Date.now() - start;

    expect(result).toEqual({ kind: 'busy' });
    expect(elapsed).toBeGreaterThanOrEqual(35);
  });

  it('a captureImpl rejection is reported as capture-failed and still releases the slot', async () => {
    const capture: CaptureFn = vi.fn().mockRejectedValueOnce(new Error('boom')).mockResolvedValueOnce(frame());
    const service = makeService(capture, { maxConcurrentCaptures: 1 });

    const failed = await service.get(ctx(1));
    expect(failed).toEqual({ kind: 'capture-failed' });
    expect(service.inFlight).toBe(0);

    // A different vmid (different cache key) proceeds normally -- the slot was released.
    const ok = await service.get(ctx(2));
    expect(ok).toMatchObject({ kind: 'ok', source: 'live' });
  });
});

describe('ConsoleThumbnailService: cache and refresh throttle', () => {
  it('serves a cache hit for identical (node,type,vmid,width) without re-capturing', async () => {
    const capture = vi.fn<CaptureFn>().mockResolvedValue(frame());
    const service = makeService(capture);

    const first = await service.get(ctx(1));
    const second = await service.get(ctx(1));

    expect(first).toMatchObject({ source: 'live' });
    expect(second).toMatchObject({ source: 'cache' });
    expect(capture).toHaveBeenCalledTimes(1);
  });

  it('every width is derived from the one capture per guest: no second capture, never upscaled', async () => {
    const capture = vi.fn<CaptureFn>().mockResolvedValue(frame(64, 48));
    const service = makeService(capture);

    const wide = await service.get(ctx(1, { width: 400 }));
    const narrow = await service.get(ctx(1, { width: 16 }));
    const narrowAgain = await service.get(ctx(1, { width: 16 }));

    expect(capture).toHaveBeenCalledTimes(1);
    expect(wide).toMatchObject({ kind: 'ok', source: 'live' });
    expect(narrow).toMatchObject({ kind: 'ok', source: 'cache' });
    if (wide.kind !== 'ok' || narrow.kind !== 'ok' || narrowAgain.kind !== 'ok') throw new Error('unreachable');
    expect(decodePng(wide.png)).toMatchObject({ width: 64, height: 48 }); // never upscaled past the frame
    expect(decodePng(narrow.png)).toMatchObject({ width: 16, height: 12 });
    expect(narrowAgain.png).toBe(narrow.png); // memoised per width
  });

  it('throttles refresh=true to one live capture per VM per throttleMs, falling back to cache', async () => {
    const capture = vi.fn<CaptureFn>().mockResolvedValue(frame());
    const service = makeService(capture, { throttleMs: 50 });

    const first = await service.get(ctx(1, { refresh: true }));
    expect(first).toMatchObject({ source: 'live' });

    const throttled = await service.get(ctx(1, { refresh: true }));
    expect(throttled).toMatchObject({ source: 'cache' });
    expect(capture).toHaveBeenCalledTimes(1);

    await new Promise((r) => setTimeout(r, 60));
    const afterThrottle = await service.get(ctx(1, { refresh: true }));
    expect(afterThrottle).toMatchObject({ source: 'live' });
    expect(capture).toHaveBeenCalledTimes(2);
  });

  it('refresh=true with nothing cached yet still captures live (throttle has nothing to fall back on)', async () => {
    const capture = vi.fn<CaptureFn>().mockResolvedValue(frame());
    const service = makeService(capture, { throttleMs: 50_000 });

    const result = await service.get(ctx(1, { refresh: true }));
    expect(result).toMatchObject({ kind: 'ok', source: 'live' });
    expect(capture).toHaveBeenCalledTimes(1);
  });

  it('a cached failure is not served past cacheTtlFailedMs -- a fresh capture is attempted again', async () => {
    const capture = vi
      .fn<CaptureFn>()
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce(frame());
    const service = makeService(capture, { cacheTtlFailedMs: 30 });

    const first = await service.get(ctx(1));
    expect(first).toEqual({ kind: 'capture-failed' });

    const stillFailed = await service.get(ctx(1));
    expect(stillFailed).toEqual({ kind: 'capture-failed' });
    expect(capture).toHaveBeenCalledTimes(1); // served from the (short-lived) failure cache

    await new Promise((r) => setTimeout(r, 40));
    const retried = await service.get(ctx(1));
    expect(retried).toMatchObject({ kind: 'ok', source: 'live' });
    expect(capture).toHaveBeenCalledTimes(2);
  });

  it('listCached reports one row per VM (latest width captured) and inFlight reflects live captures', async () => {
    const capture = vi.fn<CaptureFn>().mockResolvedValue(frame());
    const service = makeService(capture);

    expect(service.listCached()).toEqual([]);
    await service.get(ctx(1));
    await service.get(ctx(2));

    const cached = service.listCached();
    expect(cached).toHaveLength(2);
    expect(cached.map((c) => c.vmid).sort()).toEqual([1, 2]);
    expect(cached[0]).toMatchObject({ node: 'node1', type: 'qemu' });
    expect(new Date(cached[0]!.capturedAt).toString()).not.toBe('Invalid Date');
  });
});

describe('ConsoleThumbnailService: agent capture strategy', () => {
  let fakeAgent: { baseUrl: string; close: () => Promise<void> } | undefined;

  afterEach(async () => {
    await fakeAgent?.close();
    fakeAgent = undefined;
  });

  it('uses the agent for qemu when one is configured for the node, and never calls the VNC captureImpl', async () => {
    fakeAgent = await startFakeAgent((_req, res) => {
      res.writeHead(200, {
        'content-type': 'image/png',
        'x-proxion-agent-captured-at': new Date().toISOString(),
      });
      res.end(agentPng());
    });
    const vncCapture = vi.fn<CaptureFn>().mockResolvedValue(frame());
    const service = makeService(vncCapture, {}, {
      agents: new Map([['node1', fakeAgent.baseUrl]]),
      PROXION_AGENT_TOKEN: AGENT_TOKEN,
      PROXION_AGENT_TIMEOUT_MS: 2000,
    });

    const result = await service.get(ctx(1, { type: 'qemu' }));
    expect(result).toMatchObject({ kind: 'ok', capturePath: 'agent' });
    expect(vncCapture).not.toHaveBeenCalled();
    expect(service.listCached()).toEqual([
      expect.objectContaining({ node: 'node1', type: 'qemu', vmid: 1, capturePath: 'agent' }),
    ]);
  });

  it('throttles refresh=true far less on the agent path (agentThrottleMs) than over VNC', async () => {
    let agentCalls = 0;
    fakeAgent = await startFakeAgent((_req, res) => {
      agentCalls++;
      res.writeHead(200, { 'content-type': 'image/png' });
      res.end(agentPng());
    });
    const vncCapture = vi.fn<CaptureFn>().mockResolvedValue(frame());
    const service = makeService(vncCapture, { throttleMs: 60_000, agentThrottleMs: 5_000 }, {
      agents: new Map([['node1', fakeAgent.baseUrl]]),
      PROXION_AGENT_TOKEN: AGENT_TOKEN,
      PROXION_AGENT_TIMEOUT_MS: 2000,
    });

    // Freeze the clock (Date only -- real timers, so the fake agent's HTTP still works): the
    // second call is then inside the window no matter how loaded the machine is, and the
    // third is past it by decree rather than by sleeping.
    vi.useFakeTimers({ toFake: ['Date'], now: Date.now() });
    try {
      expect(await service.get(ctx(1, { type: 'qemu', refresh: true }))).toMatchObject({ source: 'live' });
      expect(await service.get(ctx(1, { type: 'qemu', refresh: true }))).toMatchObject({ source: 'cache' });
      expect(agentCalls).toBe(1);

      vi.setSystemTime(Date.now() + 6_000);
      expect(await service.get(ctx(1, { type: 'qemu', refresh: true }))).toMatchObject({ source: 'live' });
      expect(agentCalls).toBe(2);
      expect(vncCapture).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('always uses VNC for lxc, even when an agent is configured for the node', async () => {
    let agentCalls = 0;
    fakeAgent = await startFakeAgent((_req, res) => {
      agentCalls++;
      res.writeHead(200, { 'content-type': 'image/png' });
      res.end(agentPng());
    });
    const vncCapture = vi.fn<CaptureFn>().mockResolvedValue(frame());
    const service = makeService(vncCapture, {}, {
      agents: new Map([['node1', fakeAgent.baseUrl]]),
      PROXION_AGENT_TOKEN: AGENT_TOKEN,
      PROXION_AGENT_TIMEOUT_MS: 2000,
    });

    const result = await service.get(ctx(1, { type: 'lxc' }));
    expect(result).toMatchObject({ kind: 'ok', capturePath: 'vnc' });
    expect(vncCapture).toHaveBeenCalledTimes(1);
    expect(agentCalls).toBe(0); // the agent was never contacted for an lxc guest
  });

  it('uses VNC when the node has no configured agent', async () => {
    const vncCapture = vi.fn<CaptureFn>().mockResolvedValue(frame());
    const service = makeService(vncCapture, {}, {
      agents: new Map([['other-node', 'http://127.0.0.1:1']]),
      PROXION_AGENT_TOKEN: AGENT_TOKEN,
      PROXION_AGENT_TIMEOUT_MS: 2000,
    });

    const result = await service.get(ctx(1, { type: 'qemu', node: 'node1' }));
    expect(result).toMatchObject({ kind: 'ok', capturePath: 'vnc' });
    expect(vncCapture).toHaveBeenCalledTimes(1);
  });

  it('falls back to VNC when the agent capture fails (e.g. busy), logging a warning', async () => {
    fakeAgent = await startFakeAgent((_req, res) => {
      res.writeHead(503, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'busy' }));
    });
    const vncCapture = vi.fn<CaptureFn>().mockResolvedValue(frame());
    const warn = vi.fn();
    const service = makeServiceWithLog(
      vncCapture,
      {
        agents: new Map([['node1', fakeAgent.baseUrl]]),
        PROXION_AGENT_TOKEN: AGENT_TOKEN,
        PROXION_AGENT_TIMEOUT_MS: 2000,
      },
      { warn } as unknown as FastifyBaseLogger,
    );

    const result = await service.get(ctx(1, { type: 'qemu' }));
    expect(result).toMatchObject({ kind: 'ok', capturePath: 'vnc' });
    expect(vncCapture).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ reason: 'busy', node: 'node1' }),
      expect.stringContaining('falling back to VNC'),
    );
  });

  it('returns a distinct "not-running" outcome (no VNC fallback) when the agent reports 404', async () => {
    fakeAgent = await startFakeAgent((_req, res) => {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'not-running' }));
    });
    const vncCapture = vi.fn<CaptureFn>().mockResolvedValue(frame());
    const service = makeService(vncCapture, {}, {
      agents: new Map([['node1', fakeAgent.baseUrl]]),
      PROXION_AGENT_TOKEN: AGENT_TOKEN,
      PROXION_AGENT_TIMEOUT_MS: 2000,
    });

    const result = await service.get(ctx(1, { type: 'qemu' }));
    expect(result).toEqual({ kind: 'not-running' });
    expect(vncCapture).not.toHaveBeenCalled();
  });

  it('does not fall back on agent-unauthorized: capture-failed, and warns once per process, not per request', async () => {
    fakeAgent = await startFakeAgent((_req, res) => {
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'unauthorized' }));
    });
    const vncCapture = vi.fn<CaptureFn>().mockResolvedValue(frame());
    const warn = vi.fn();
    const service = makeServiceWithLog(
      vncCapture,
      {
        agents: new Map([['node1', fakeAgent.baseUrl]]),
        PROXION_AGENT_TOKEN: AGENT_TOKEN,
        PROXION_AGENT_TIMEOUT_MS: 2000,
      },
      { warn } as unknown as FastifyBaseLogger,
    );

    const first = await service.get(ctx(1, { type: 'qemu' }));
    expect(first).toEqual({ kind: 'capture-failed' });
    expect(vncCapture).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledTimes(1);

    // Cache-failed TTL default (15s) means the second call re-captures rather than serving
    // a cached failure -- assert the *process-wide* warn dedup, not the cache TTL.
    const second = await service.get(ctx(2, { type: 'qemu' }));
    expect(second).toEqual({ kind: 'capture-failed' });
    expect(warn).toHaveBeenCalledTimes(1); // still 1 -- not once per request
  });
});

describe('ConsoleThumbnailService: agent status probing (listAgentStatus)', () => {
  let fakeAgent: { baseUrl: string; close: () => Promise<void> } | undefined;

  afterEach(async () => {
    await fakeAgent?.close();
    fakeAgent = undefined;
  });

  it('reports ok + version for a healthy agent, and caches the result', async () => {
    let calls = 0;
    fakeAgent = await startFakeAgent((_req, res) => {
      calls++;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, agent: 'proxion-agent', version: '0.1.0', hostname: 'pve1' }));
    });
    const service = makeService(vi.fn(), {}, {
      agents: new Map([['node1', fakeAgent.baseUrl]]),
      PROXION_AGENT_TOKEN: AGENT_TOKEN,
      PROXION_AGENT_TIMEOUT_MS: 2000,
    });

    const rows = await service.listAgentStatus();
    expect(rows).toEqual([
      expect.objectContaining({ node: 'node1', url: fakeAgent.baseUrl, ok: true, version: '0.1.0' }),
    ]);
    expect(calls).toBe(1);

    // Second call within the 60s TTL is served from cache -- no second /health request.
    await service.listAgentStatus();
    expect(calls).toBe(1);
  });

  it('reports ok: false for an agent that is down, without throwing', async () => {
    const service = makeService(vi.fn(), {}, {
      agents: new Map([['node1', 'http://127.0.0.1:1']]),
      PROXION_AGENT_TOKEN: AGENT_TOKEN,
      PROXION_AGENT_TIMEOUT_MS: 500,
    });

    const rows = await service.listAgentStatus();
    expect(rows).toEqual([
      expect.objectContaining({ node: 'node1', url: 'http://127.0.0.1:1', ok: false }),
    ]);
  });

  it('never blocks past the 2s cap: a slow agent yields ok:false with a checkedAt', async () => {
    fakeAgent = await startFakeAgent((_req, res) => {
      // Never respond within the probe's own timeout window used here.
      void res;
    });
    const service = makeService(vi.fn(), {}, {
      agents: new Map([['node1', fakeAgent.baseUrl]]),
      PROXION_AGENT_TOKEN: AGENT_TOKEN,
      // Agent's own fetch timeout is long, but listAgentStatus must still cap the wait at 2s.
      PROXION_AGENT_TIMEOUT_MS: 60_000,
    });

    const start = Date.now();
    const rows = await service.listAgentStatus();
    const elapsed = Date.now() - start;

    expect(elapsed).toBeLessThan(2_500);
    expect(rows).toEqual([
      expect.objectContaining({ node: 'node1', ok: false }),
    ]);
    expect(typeof rows[0]!.checkedAt).toBe('string');
  }, 10_000);

  it('returns an empty array when no agents are configured', async () => {
    const service = makeService(vi.fn());
    expect(await service.listAgentStatus()).toEqual([]);
  });
});
