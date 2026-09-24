import type * as https from 'node:https';
import type { FastifyBaseLogger } from 'fastify';
import type { Config } from '../config.js';
import type { PveIdentity } from '../pve/identity.js';
import { openUpstreamConsoleSocket } from './upstream.js';
import { captureRfbFrame, type RfbFrame } from './rfbSnapshot.js';
import { decodePng, downscaleFrame, encodePng } from './thumbnailImage.js';
import { fetchAgentHealth, fetchAgentScreenshot } from './agentClient.js';

const CACHE_TTL_OK_MS = 60_000;
const CACHE_TTL_FAILED_MS = 15_000;
const THROTTLE_MS = 15_000;
/** Refresh throttle on the agent path: a local screendump is cheap and leaves no task-log
 *  entry, so an explicit refresh only needs protection against double clicks. */
const AGENT_THROTTLE_MS = 2_000;
const MAX_CONCURRENT_CAPTURES = 3;
/** How long a probed agent's `/health` result is trusted before probing again. */
const AGENT_HEALTH_TTL_MS = 60_000;
/** Never let `/api/console/thumbnail/status` wait on a slow/dead agent longer than this. */
const AGENT_HEALTH_MAX_WAIT_MS = 2_000;
/**
 * How long a request waits for a capture slot before giving up with `busy`. A dashboard
 * with N running guests queues N captures behind 3 slots at once, so this has to cover
 * the tail of that burst (a capture is typically 1-3 s, bounded by the 6 s RFB deadline).
 * The web client's fetch timeout is sized above this.
 */
const QUEUE_WAIT_MS = 30_000;
/** Widest thumbnail anyone can ask for (`w` max); the cached master is downscaled to this. */
export const MASTER_WIDTH = 800;

export type GuestType = 'qemu' | 'lxc';

/** Which path produced a capture: the host agent, or the existing VNC/RFB session. */
export type CapturePath = 'agent' | 'vnc';

interface CacheEntryOk {
  ok: true;
  capturedAt: number;
  node: string;
  type: GuestType;
  vmid: number;
  /** The capture, downscaled to at most MASTER_WIDTH and PNG-encoded. Every requested
   *  width is derived from this, so one VNC session serves the dashboard (400) and the
   *  VM page (800) alike. */
  master: Buffer;
  masterWidth: number;
  /** Per-width encodes derived from `master`, memoised. */
  pngByWidth: Map<number, Buffer>;
  /** Which path produced this master -- surfaced as `X-Proxion-Capture` and in `status`. */
  capturePath: CapturePath;
}

interface CacheEntryFailed {
  ok: false;
  capturedAt: number;
  /** Set when the agent (authoritative at capture time) reported the guest as not
   *  running, so the route can answer `404 not-running` instead of `503 capture-failed`. */
  reason?: 'not-running';
}

type CacheEntry = CacheEntryOk | CacheEntryFailed;

export type ThumbnailOutcome =
  | {
      kind: 'ok';
      png: Buffer;
      capturedAtIso: string;
      source: 'cache' | 'live';
      capturePath: CapturePath;
    }
  | { kind: 'busy' }
  | { kind: 'capture-failed' }
  | { kind: 'not-running' };

export interface CaptureContext {
  node: string;
  type: GuestType;
  vmid: number;
  /** Target thumbnail width in px (already validated/clamped by the caller). */
  width: number;
  refresh: boolean;
  identity: PveIdentity;
}

export interface CachedThumbnailInfo {
  node: string;
  type: GuestType;
  vmid: number;
  capturedAt: string;
  capturePath: CapturePath;
}

/** One row of `/api/console/thumbnail/status`'s `agents` array -- see `listAgentStatus`. */
export interface AgentStatusRow {
  node: string;
  url: string;
  ok: boolean;
  version?: string;
  checkedAt: string;
}

/** How to actually grab one frame of a guest's display over VNC -- overridable in tests to
 *  avoid real VNC timing. Used directly for LXC, and as the fallback for qemu when no agent
 *  is configured for the node or the agent capture fails (other than `agent-unauthorized`). */
export type CaptureFn = (ctx: CaptureContext) => Promise<RfbFrame>;

/** Internal result of one capture attempt, before it's turned into a `CacheEntry`. */
type CaptureAttempt =
  | { kind: 'frame'; frame: RfbFrame; capturePath: CapturePath }
  | { kind: 'not-running' }
  | { kind: 'agent-unauthorized' };

/** Last-known `/health` result for one agent -- `version` stays `undefined`-typed (not
 *  optional) so it can be assigned freely under `exactOptionalPropertyTypes`. */
interface AgentHealthState {
  ok: boolean;
  version: string | undefined;
  checkedAt: number;
}

function toAgentStatusRow(node: string, url: string, state: AgentHealthState): AgentStatusRow {
  return {
    node,
    url,
    ok: state.ok,
    ...(state.version !== undefined ? { version: state.version } : {}),
    checkedAt: new Date(state.checkedAt).toISOString(),
  };
}

/** Tunables, all defaulted to the production contract in README.md -- overridable in tests so concurrency/throttle/TTL behavior can be exercised without waiting on real 6-60s windows. */
export interface ConsoleThumbnailServiceOptions {
  cacheTtlOkMs?: number;
  cacheTtlFailedMs?: number;
  throttleMs?: number;
  agentThrottleMs?: number;
  maxConcurrentCaptures?: number;
  queueWaitMs?: number;
  captureImpl?: CaptureFn;
}

/**
 * In-memory cache, concurrency limiter, and per-VM refresh throttle for VM
 * console thumbnails -- see "Console thumbnails" in apps/server/README.md
 * for the full contract. Lives for the process lifetime; nothing here is
 * persisted (a restart just means the next request is a live capture).
 *
 * One capture per guest: the cache is keyed by (node, type, vmid), holds the
 * frame at MASTER_WIDTH, and derives any narrower `w` from it. Concurrent
 * requests for the same guest (dashboard tile + VM page, a double-clicked
 * "Refresh all") join the capture already in flight instead of queueing
 * another VNC session.
 */
export class ConsoleThumbnailService {
  private readonly cache = new Map<string, CacheEntry>();
  private readonly inFlightByVm = new Map<string, Promise<CacheEntry | 'busy'>>();
  private readonly lastLiveCaptureStartedAt = new Map<string, number>();
  private inFlightCount = 0;
  private readonly queue: Array<() => void> = [];

  /** Last-known `/health` result per node, refreshed at most every `AGENT_HEALTH_TTL_MS`. */
  private readonly agentHealth = new Map<string, AgentHealthState>();
  private readonly agentHealthInFlight = new Map<string, Promise<AgentHealthState>>();
  /** A misconfigured token is loud but only once per process, not once per failed request. */
  private agentUnauthorizedWarned = false;

  private readonly cacheTtlOkMs: number;
  private readonly cacheTtlFailedMs: number;
  private readonly throttleMs: number;
  private readonly agentThrottleMs: number;
  private readonly maxConcurrentCaptures: number;
  private readonly queueWaitMs: number;
  private readonly captureImpl: CaptureFn;

  constructor(
    private readonly config: Config,
    private readonly wsAgent: https.Agent | undefined,
    private readonly log: FastifyBaseLogger,
    options: ConsoleThumbnailServiceOptions = {},
  ) {
    this.cacheTtlOkMs = options.cacheTtlOkMs ?? CACHE_TTL_OK_MS;
    this.cacheTtlFailedMs = options.cacheTtlFailedMs ?? CACHE_TTL_FAILED_MS;
    this.throttleMs = options.throttleMs ?? THROTTLE_MS;
    this.agentThrottleMs = options.agentThrottleMs ?? AGENT_THROTTLE_MS;
    this.maxConcurrentCaptures = options.maxConcurrentCaptures ?? MAX_CONCURRENT_CAPTURES;
    this.queueWaitMs = options.queueWaitMs ?? QUEUE_WAIT_MS;
    this.captureImpl = options.captureImpl ?? ((ctx) => this.defaultCapture(ctx));
  }

  /** Number of live captures currently in progress (0..maxConcurrentCaptures). */
  get inFlight(): number {
    return this.inFlightCount;
  }

  /** One row per guest with a cached (successful) thumbnail. */
  listCached(): CachedThumbnailInfo[] {
    const rows: CachedThumbnailInfo[] = [];
    for (const entry of this.cache.values()) {
      if (!entry.ok) continue;
      rows.push({
        node: entry.node,
        type: entry.type,
        vmid: entry.vmid,
        capturedAt: new Date(entry.capturedAt).toISOString(),
        capturePath: entry.capturePath,
      });
    }
    return rows;
  }

  /**
   * One row per configured agent (`PROXION_AGENTS`), for `/api/console/thumbnail/status`.
   * `/health` is probed at most once per `AGENT_HEALTH_TTL_MS`; a request never waits on a
   * probe longer than `AGENT_HEALTH_MAX_WAIT_MS` -- past that it returns the last known
   * state (or `ok: false` with `checkedAt` now, if there is no known state yet), leaving the
   * probe running in the background for the next call to pick up.
   */
  async listAgentStatus(): Promise<AgentStatusRow[]> {
    const rows: AgentStatusRow[] = [];
    const now = Date.now();

    for (const [node, url] of this.config.agents ?? []) {
      const cached = this.agentHealth.get(node);
      if (cached && now - cached.checkedAt < AGENT_HEALTH_TTL_MS) {
        rows.push(toAgentStatusRow(node, url, cached));
        continue;
      }

      const probe = this.probeAgentHealth(node, url);
      const capped = await Promise.race([
        probe.then((state) => ({ timedOut: false as const, state })),
        new Promise<{ timedOut: true }>((resolve) =>
          setTimeout(() => resolve({ timedOut: true }), AGENT_HEALTH_MAX_WAIT_MS),
        ),
      ]);

      const state: AgentHealthState = capped.timedOut
        ? (cached ?? { ok: false, version: undefined, checkedAt: now })
        : capped.state;
      rows.push(toAgentStatusRow(node, url, state));
    }

    return rows;
  }

  /** Joins an in-flight probe for `node` if there is one, else starts (and caches) a new one. */
  private probeAgentHealth(node: string, url: string): Promise<AgentHealthState> {
    const inFlight = this.agentHealthInFlight.get(node);
    if (inFlight) return inFlight;

    const probe = fetchAgentHealth(url, this.config.PROXION_AGENT_TOKEN!, {
      timeoutMs: this.config.PROXION_AGENT_TIMEOUT_MS,
    })
      .then((result): AgentHealthState => {
        const state: AgentHealthState = {
          ok: result.kind === 'ok',
          version: result.kind === 'ok' ? result.version : undefined,
          checkedAt: Date.now(),
        };
        this.agentHealth.set(node, state);
        return state;
      })
      .finally(() => {
        this.agentHealthInFlight.delete(node);
      });

    this.agentHealthInFlight.set(node, probe);
    return probe;
  }

  async get(ctx: CaptureContext): Promise<ThumbnailOutcome> {
    const vmKey = `${ctx.node}:${ctx.type}:${ctx.vmid}`;
    const now = Date.now();

    if (!ctx.refresh) {
      const cached = this.cache.get(vmKey);
      if (cached && this.isFresh(cached, now)) return this.toOutcome(cached, ctx.width, 'cache');
    } else {
      const lastStart = this.lastLiveCaptureStartedAt.get(vmKey);
      const throttled = lastStart !== undefined && now - lastStart < this.refreshThrottleMs(ctx);
      if (throttled) {
        const cached = this.cache.get(vmKey);
        // Throttled refresh with something to fall back on: serve it (as
        // cache), even if its own TTL has technically lapsed -- the whole
        // point of throttling is *not* starting another live capture yet.
        if (cached?.ok) return this.toOutcome(cached, ctx.width, 'cache');
        // Nothing to fall back on: fall through and capture anyway, rather
        // than leaving the caller with no image at all.
      }
    }

    // A capture for this guest is already running or queued (another width, another
    // tab, a second click): join it rather than queue a second VNC session. The task is
    // registered *before* its slot wait so requests arriving during the wait join too.
    const joined = this.inFlightByVm.get(vmKey);
    if (joined) return this.outcomeOf(await joined, ctx.width, 'live');

    const task = this.captureWithSlot(ctx, vmKey);
    this.inFlightByVm.set(vmKey, task);
    try {
      return this.outcomeOf(await task, ctx.width, 'live');
    } finally {
      this.inFlightByVm.delete(vmKey);
    }
  }

  private outcomeOf(
    result: CacheEntry | 'busy',
    width: number,
    source: 'cache' | 'live',
  ): ThumbnailOutcome {
    if (result === 'busy') return { kind: 'busy' };
    return this.toOutcome(result, width, source);
  }

  /** Waits for a capture slot, then captures; `'busy'` if no slot freed up in time. Never rejects. */
  private async captureWithSlot(ctx: CaptureContext, vmKey: string): Promise<CacheEntry | 'busy'> {
    const acquired = await this.acquireSlot();
    if (!acquired) return 'busy';
    return this.runCapture(ctx, vmKey);
  }

  /** Owns one capture slot (already acquired) for the duration; never rejects. */
  private async runCapture(ctx: CaptureContext, vmKey: string): Promise<CacheEntry> {
    this.lastLiveCaptureStartedAt.set(vmKey, Date.now());
    try {
      const attempt = await this.captureFrame(ctx);

      if (attempt.kind === 'not-running') {
        // The agent's view is authoritative at capture time even though the route's
        // earlier status/current check said running -- treat it as a distinct, short-lived
        // outcome so the caller answers 404, not 503.
        const entry: CacheEntryFailed = { ok: false, capturedAt: Date.now(), reason: 'not-running' };
        this.cache.set(vmKey, entry);
        return entry;
      }
      if (attempt.kind === 'agent-unauthorized') {
        // No VNC fallback here on purpose: a misconfigured token should be loud
        // (already warned once in `captureFrame`), not silently degrade every request.
        const entry: CacheEntryFailed = { ok: false, capturedAt: Date.now() };
        this.cache.set(vmKey, entry);
        return entry;
      }

      const master = downscaleFrame(attempt.frame, MASTER_WIDTH);
      const entry: CacheEntryOk = {
        ok: true,
        capturedAt: Date.now(),
        node: ctx.node,
        type: ctx.type,
        vmid: ctx.vmid,
        master: encodePng(master),
        masterWidth: master.width,
        pngByWidth: new Map(),
        capturePath: attempt.capturePath,
      };
      this.cache.set(vmKey, entry);
      return entry;
    } catch (err) {
      this.log.warn({ err: (err as Error).message }, 'Console thumbnail capture failed');
      const entry: CacheEntryFailed = { ok: false, capturedAt: Date.now() };
      this.cache.set(vmKey, entry);
      return entry;
    } finally {
      this.releaseSlot();
    }
  }

  /**
   * Decides how to grab one frame for this guest: the node's agent when one is configured
   * for `ctx.node` and the guest is a `qemu` VM (LXC always uses VNC -- the agent contract
   * only covers `qemuscreendump`), falling back to the existing VNC capture (`captureImpl`)
   * on any agent failure except `agent-unauthorized`, which is surfaced as-is so a
   * misconfigured token doesn't silently degrade into a slower VNC path on every request.
   */
  private async captureFrame(ctx: CaptureContext): Promise<CaptureAttempt> {
    const agentUrl = ctx.type === 'qemu' ? this.config.agents?.get(ctx.node) : undefined;
    if (!agentUrl) {
      return { kind: 'frame', frame: await this.captureImpl(ctx), capturePath: 'vnc' };
    }

    const result = await fetchAgentScreenshot(agentUrl, this.config.PROXION_AGENT_TOKEN!, ctx.vmid, {
      timeoutMs: this.config.PROXION_AGENT_TIMEOUT_MS,
    });

    if (result.kind === 'ok') {
      return { kind: 'frame', frame: result.frame, capturePath: 'agent' };
    }
    if (result.kind === 'not-running') {
      return { kind: 'not-running' };
    }

    if (result.reason === 'agent-unauthorized') {
      if (!this.agentUnauthorizedWarned) {
        this.agentUnauthorizedWarned = true;
        this.log.warn(
          { node: ctx.node },
          'proxion-agent rejected the configured PROXION_AGENT_TOKEN (401) -- check the token; ' +
            'console thumbnail captures for this node will fail rather than silently fall back to VNC',
        );
      }
      return { kind: 'agent-unauthorized' };
    }

    this.log.warn(
      { reason: result.reason, node: ctx.node, vmid: ctx.vmid },
      'proxion-agent capture failed; falling back to VNC',
    );
    return { kind: 'frame', frame: await this.captureImpl(ctx), capturePath: 'vnc' };
  }

  /** Would a capture for this guest go through a host agent (qemu on a node with one)? */
  private usesAgent(ctx: CaptureContext): boolean {
    return ctx.type === 'qemu' && this.config.agents?.get(ctx.node) !== undefined;
  }

  /** Per-guest `refresh=1` throttle window: short on the agent path, 15 s over VNC. */
  private refreshThrottleMs(ctx: CaptureContext): number {
    return this.usesAgent(ctx) ? this.agentThrottleMs : this.throttleMs;
  }

  private isFresh(entry: CacheEntry, now: number): boolean {
    const ttl = entry.ok ? this.cacheTtlOkMs : this.cacheTtlFailedMs;
    return now - entry.capturedAt < ttl;
  }

  private toOutcome(entry: CacheEntry, width: number, source: 'cache' | 'live'): ThumbnailOutcome {
    if (!entry.ok) return entry.reason === 'not-running' ? { kind: 'not-running' } : { kind: 'capture-failed' };
    return {
      kind: 'ok',
      png: this.pngAtWidth(entry, width),
      capturedAtIso: new Date(entry.capturedAt).toISOString(),
      source,
      capturePath: entry.capturePath,
    };
  }

  /** The master itself when `width` is at least as wide (never upscale); else a memoised downscale. */
  private pngAtWidth(entry: CacheEntryOk, width: number): Buffer {
    if (width >= entry.masterWidth) return entry.master;
    const memo = entry.pngByWidth.get(width);
    if (memo) return memo;
    const png = encodePng(downscaleFrame(decodePng(entry.master), width));
    entry.pngByWidth.set(width, png);
    return png;
  }

  /** Resolves `true` once a capture slot is held, or `false` if none freed up within `queueWaitMs`. */
  private acquireSlot(): Promise<boolean> {
    if (this.inFlightCount < this.maxConcurrentCaptures) {
      this.inFlightCount++;
      return Promise.resolve(true);
    }

    return new Promise((resolve) => {
      let settled = false;
      const onSlot = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.inFlightCount++;
        resolve(true);
      };
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        const idx = this.queue.indexOf(onSlot);
        if (idx >= 0) this.queue.splice(idx, 1);
        resolve(false);
      }, this.queueWaitMs);
      this.queue.push(onSlot);
    });
  }

  private releaseSlot(): void {
    this.inFlightCount--;
    const next = this.queue.shift();
    next?.();
  }

  private async defaultCapture(ctx: CaptureContext): Promise<RfbFrame> {
    const result =
      ctx.type === 'qemu'
        ? await ctx.identity.client.post('/nodes/{node}/qemu/{vmid}/vncproxy', {
            node: ctx.node,
            vmid: ctx.vmid,
            websocket: true,
            'generate-password': false,
          })
        : await ctx.identity.client.post('/nodes/{node}/lxc/{vmid}/vncproxy', {
            node: ctx.node,
            vmid: ctx.vmid,
            websocket: true,
          });

    const path = `/nodes/${encodeURIComponent(ctx.node)}/${ctx.type}/${encodeURIComponent(String(ctx.vmid))}/vncwebsocket`;
    const ws = openUpstreamConsoleSocket(this.config, this.wsAgent, ctx.identity.credentials, path, {
      port: result.port,
      vncticket: result.ticket,
    });

    return captureRfbFrame(ws, result.ticket);
  }
}
