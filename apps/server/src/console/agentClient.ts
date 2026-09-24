import { PNG } from 'pngjs';
import type { RfbFrame } from './rfbSnapshot.js';

/**
 * HTTP client for the optional per-node "proxion-agent" -- a small host-side
 * process that returns a QEMU screendump as PNG without going through the
 * PVE API (and so without leaving a `vncproxy` task in the task log). One
 * agent per PVE node, reached over plain HTTP(S) on a private/mesh address;
 * see "Console thumbnails" / "Host agent" in README.md for the full
 * contract. Every call here is designed to never throw: every failure mode
 * comes back as a discriminated result so `thumbnailService.ts` can decide
 * whether to fall back to the existing VNC capture.
 */

export interface AgentRequestOptions {
  /** Aborts the request (and reports it as `agent-timeout`) after this many ms. */
  timeoutMs: number;
  /** Overridable for tests; defaults to the global `fetch`. */
  fetchImpl?: typeof fetch;
}

export type AgentScreenshotResult =
  | { kind: 'ok'; frame: RfbFrame; capturedAt: Date }
  | { kind: 'not-running' }
  | { kind: 'failed'; reason: string };

export type AgentHealthResult =
  | { kind: 'ok'; version?: string; hostname?: string }
  | { kind: 'failed' };

function joinUrl(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/+$/, '')}${path}`;
}

/** Best-effort read of `{ error: "..." }` from a JSON error body; never throws. */
async function readErrorReason(res: Response, fallback: string): Promise<string> {
  try {
    const body = (await res.json()) as { error?: unknown };
    if (typeof body.error === 'string' && body.error.length > 0) return body.error;
  } catch {
    // Non-JSON or empty body -- fall through to the generic reason.
  }
  return fallback;
}

function isAbortError(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { name?: unknown }).name === 'AbortError';
}

/**
 * Fetches one guest's full-resolution screenshot from its node's agent
 * (`GET /screenshot/<vmid>`). Never throws -- never logs `token`.
 */
export async function fetchAgentScreenshot(
  baseUrl: string,
  token: string,
  vmid: number,
  options: AgentRequestOptions,
): Promise<AgentScreenshotResult> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs);

  try {
    let res: Response;
    try {
      res = await fetchImpl(joinUrl(baseUrl, `/screenshot/${vmid}`), {
        headers: { Authorization: `Bearer ${token}` },
        signal: controller.signal,
      });
    } catch (err) {
      return { kind: 'failed', reason: isAbortError(err) ? 'agent-timeout' : 'agent-unreachable' };
    }

    if (res.status === 401) return { kind: 'failed', reason: 'agent-unauthorized' };
    if (res.status === 404) return { kind: 'not-running' };
    if (res.status !== 200) {
      return { kind: 'failed', reason: await readErrorReason(res, `agent-http-${res.status}`) };
    }

    const capturedAtHeader = res.headers.get('x-proxion-agent-captured-at');
    const capturedAt =
      capturedAtHeader && !Number.isNaN(Date.parse(capturedAtHeader))
        ? new Date(capturedAtHeader)
        : new Date();

    const buf = Buffer.from(await res.arrayBuffer());
    let decoded: PNG;
    try {
      decoded = PNG.sync.read(buf);
    } catch {
      return { kind: 'failed', reason: 'agent-bad-image' };
    }

    // pngjs always decodes to RGBA regardless of the source color type
    // (RGB gets alpha=255 filled in), matching RfbFrame's format.
    return {
      kind: 'ok',
      frame: { width: decoded.width, height: decoded.height, data: decoded.data },
      capturedAt,
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Probes one agent's `GET /health`. Never throws; any failure (network,
 * timeout, auth, malformed body) is reported as `{ kind: 'failed' }` -- the
 * status route only needs an ok/not-ok signal plus the version when known.
 */
export async function fetchAgentHealth(
  baseUrl: string,
  token: string,
  options: AgentRequestOptions,
): Promise<AgentHealthResult> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs);

  try {
    const res = await fetchImpl(joinUrl(baseUrl, '/health'), {
      headers: { Authorization: `Bearer ${token}` },
      signal: controller.signal,
    });
    if (!res.ok) return { kind: 'failed' };

    const body = (await res.json()) as { ok?: unknown; version?: unknown; hostname?: unknown };
    if (body.ok !== true) return { kind: 'failed' };

    const version = typeof body.version === 'string' ? body.version : undefined;
    const hostname = typeof body.hostname === 'string' ? body.hostname : undefined;
    return {
      kind: 'ok',
      ...(version !== undefined ? { version } : {}),
      ...(hostname !== undefined ? { hostname } : {}),
    };
  } catch {
    return { kind: 'failed' };
  } finally {
    clearTimeout(timer);
  }
}
