import type { GuestType } from '@/api/types';

/**
 * Console-thumbnail helpers shared between the real HTTP client, the fixture client, and
 * `ConsoleThumbnail`. Kept dependency-free of `api/client-types.ts` (which imports the types
 * below) so there is exactly one direction of import between the two modules.
 */

/** Server clamps `w` to this; the client clamps too so a bad prop never round-trips a huge request. */
export const THUMBNAIL_MAX_WIDTH = 800;
export const THUMBNAIL_DEFAULT_WIDTH = 400;
/** Dashboard tile size; the Summary tab panel asks for the larger `THUMBNAIL_MAX_WIDTH`. */
export const THUMBNAIL_SUMMARY_WIDTH = THUMBNAIL_MAX_WIDTH;

/** How often a visible, focused `ConsoleThumbnail` re-fetches its image in the background. */
export const THUMBNAIL_REFRESH_INTERVAL_MS = 60_000;


/**
 * A 503 `{ error: 'busy' }` means the server's capture queue was full for its whole wait
 * window (a big dashboard burst). That is "still loading", not a failure: keep whatever is
 * on screen and try again shortly, up to this many times, before showing "Preview unavailable".
 */
export const THUMBNAIL_BUSY_RETRY_MS = 4_000;
export const THUMBNAIL_BUSY_MAX_RETRIES = 8;

/** The console pop-out route (also used by the Console tab's toolbar). Prefixed with
 *  `import.meta.env.BASE_URL` (always `/`-terminated) so the pop-out window's URL still
 *  resolves under the GitHub Pages demo's `/proxion/` base -- see vite.config.ts's `base`. */
export function consolePopoutHref(node: string, type: GuestType, vmid: number): string {
  return `${import.meta.env.BASE_URL}console/${encodeURIComponent(node)}/${type}/${vmid}`;
}

/** One pop-out window per guest: reusing the name focuses the window already open. */
export function consolePopoutWindowName(node: string, type: GuestType, vmid: number): string {
  return `proxion-console-${node}-${type}-${vmid}`;
}

/** Same window features the Console tab's pop-out button uses. */
export const CONSOLE_POPOUT_FEATURES = 'popup,width=1280,height=800';

/** True when a 503 body is the server's "busy" signal (vs `capture-failed`). */
export function isBusyThumbnailBody(body: unknown): boolean {
  return typeof body === 'object' && body !== null && (body as { error?: unknown }).error === 'busy';
}

export interface ThumbnailUrlOptions {
  /** Requested width in px; clamped to `THUMBNAIL_MAX_WIDTH`. Defaults to `THUMBNAIL_DEFAULT_WIDTH`. */
  w?: number | undefined;
  /** Forces a live capture (still server-throttled to one per 15s per VM). */
  refresh?: boolean | undefined;
}

export interface ThumbnailCacheEntry {
  node: string;
  type: GuestType;
  vmid: number;
  capturedAt: string;
}

/** `GET /api/console/thumbnail/status` response shape. */
export interface ThumbnailStatus {
  inFlight: number;
  cached: ThumbnailCacheEntry[];
}

/** Builds the `GET /api/console/thumbnail/:node/:type/:vmid.png` path + query string. */
export function buildThumbnailPath(
  node: string,
  type: GuestType,
  vmid: number,
  opts?: ThumbnailUrlOptions,
): string {
  const w = Math.max(1, Math.min(opts?.w ?? THUMBNAIL_DEFAULT_WIDTH, THUMBNAIL_MAX_WIDTH));
  const params = new URLSearchParams({ w: String(w) });
  if (opts?.refresh) params.set('refresh', '1');
  return `/api/console/thumbnail/${node}/${type}/${vmid}.png?${params.toString()}`;
}

export type ThumbnailPhase = 'loading' | 'ok' | 'stopped' | 'forbidden' | 'error';

/** What a single fetch attempt resolved to -- a strict subset of `ThumbnailPhase` that leaves
 *  out `'loading'` (which only ever describes "no attempt has resolved yet", never an outcome). */
export type ThumbnailFetchOutcome = 'ok' | 'stopped' | 'forbidden' | 'error';

/**
 * Maps a thumbnail image response's HTTP status to the outcome `ConsoleThumbnail` renders.
 * 401 (no identity) and any other non-2xx (503 capture-failed/busy, network hiccups, ...)
 * collapse into `'error'` -- a retryable "Preview unavailable", same as a timeout.
 */
export function classifyThumbnailStatus(status: number): ThumbnailFetchOutcome {
  if (status >= 200 && status < 300) return 'ok';
  if (status === 404) return 'stopped';
  if (status === 403) return 'forbidden';
  return 'error';
}

/** "captured 34s ago" style freshness label from the `X-Proxion-Captured-At` header. `null` when unknown. */
export function formatCapturedAgo(
  capturedAtIso: string | null | undefined,
  nowMs: number,
): string | null {
  if (!capturedAtIso) return null;
  const capturedMs = Date.parse(capturedAtIso);
  if (Number.isNaN(capturedMs)) return null;
  const deltaSeconds = Math.max(0, Math.round((nowMs - capturedMs) / 1000));
  if (deltaSeconds < 5) return 'captured just now';
  if (deltaSeconds < 60) return `captured ${deltaSeconds}s ago`;
  const deltaMinutes = Math.round(deltaSeconds / 60);
  if (deltaMinutes < 60) return `captured ${deltaMinutes}m ago`;
  const deltaHours = Math.round(deltaMinutes / 60);
  return `captured ${deltaHours}h ago`;
}
