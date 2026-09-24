import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type MouseEvent,
} from 'react';
import { Lock, Power, RefreshCw, TriangleAlert } from 'lucide-react';

import { StatusDot } from '@/components/StatusDot';
import { Skeleton } from '@/components/ui/skeleton';
import { api } from '@/api/client';
import type { GuestType } from '@/api/types';
import { cn } from '@/lib/utils';
import {
  THUMBNAIL_BUSY_MAX_RETRIES,
  THUMBNAIL_BUSY_RETRY_MS,
  THUMBNAIL_REFRESH_INTERVAL_MS,
  consolePopoutHref,
  consolePopoutWindowName,
  CONSOLE_POPOUT_FEATURES,
  THUMBNAIL_SUMMARY_WIDTH,
  classifyThumbnailStatus,
  formatCapturedAgo,
  isBusyThumbnailBody,
  type ThumbnailPhase,
} from '@/lib/thumbnails';

export interface ConsoleThumbnailProps {
  node: string;
  type: GuestType;
  vmid: number;
  /** Shown in the overlay strip and the "Open console for <name>" aria-label. */
  name: string;
  /** Raw PVE status (e.g. "running"/"stopped"). Anything but a running, non-template guest
   * never touches the network -- it renders the "Powered off" placeholder directly. */
  status: string;
  template?: boolean | undefined;
  /** `'lg'` requests the 800px-wide capture (VM Summary); default is the dashboard-tile size. */
  size?: 'default' | 'lg' | undefined;
  className?: string | undefined;
  /** Bump this (e.g. from a "Refresh all" button) to force one live re-capture, regardless of visibility. */
  refreshToken?: number | undefined;
  /** Background re-fetch interval while visible/focused; defaults to `THUMBNAIL_REFRESH_INTERVAL_MS`.
   *  Overridden by a caller reading the `thumbnailRefreshSeconds` preference (see DashboardPage.tsx). */
  refreshIntervalMs?: number | undefined;
}

interface LoadedImage {
  url: string;
  capturedAt: string | null;
}

/** The last thing a fetch resolved to. `null` = nothing fetched yet this mount (renders as
 *  'loading', unless the guest isn't running at all -- see `phase` below, which is derived
 *  from this plus `isRunning` rather than kept as its own synchronized state. */
type FetchResult =
  | { kind: 'ok'; image: LoadedImage }
  | { kind: 'not-running' }
  | { kind: 'forbidden' }
  | { kind: 'error' };

/** Above the server's own capture-queue wait (30 s) plus one capture (6 s RFB deadline), so a
 *  request that is merely queued behind a dashboard burst is not aborted client-side. */
const FETCH_TIMEOUT_MS = 45_000;
/** How long the "already fresh" note replaces the freshness label after a throttled refresh. */
const NOTICE_MS = 2_500;

/**
 * A VM/CT's console display as a small, lazily- and gently-refreshed screenshot. Fetches
 * through `fetch`/`createObjectURL` (not a plain `<img src>`) so it can read the server's
 * `X-Proxion-Captured-At` header for the freshness label. Only ever fetches for a running
 * guest, only while the tile is on-screen (`IntersectionObserver`) and the tab is focused, and
 * re-fetches at most once every 60s in the background -- never while hidden. Clicking (or
 * Enter/Space) opens the guest's console in its own pop-out window (one per guest: a second
 * click focuses the window already open).
 */
export function ConsoleThumbnail({
  node,
  type,
  vmid,
  name,
  status,
  template,
  size = 'default',
  className,
  refreshToken,
  refreshIntervalMs = THUMBNAIL_REFRESH_INTERVAL_MS,
}: ConsoleThumbnailProps) {
  const isRunning = status === 'running' && template !== true;
  const width = size === 'lg' ? THUMBNAIL_SUMMARY_WIDTH : 400;

  const containerRef = useRef<HTMLDivElement | null>(null);
  const mountedRef = useRef(true);
  const resultRef = useRef<FetchResult | null>(null);
  const inFlightRef = useRef(false);
  const busyRetriesRef = useRef(0);
  const noticeTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const prevRefreshTokenRef = useRef(refreshToken);
  const prevManualTriggerRef = useRef(0);

  const [result, setResult] = useState<FetchResult | null>(null);
  const [isVisible, setIsVisible] = useState(false);
  const [isFocused, setIsFocused] = useState(
    () => typeof document === 'undefined' || document.visibilityState === 'visible',
  );
  const [nowMs, setNowMs] = useState(() => Date.now());
  // Bumped by the retry/manual-refresh buttons (an ordinary event-handler state update, not an
  // effect one) so the single fetch effect below can treat it exactly like an external
  // `refreshToken` bump -- one more "do a live refresh=1 fetch now" dependency change.
  const [manualTrigger, setManualTrigger] = useState(0);
  // The refresh button's spinner: set by the click handler, cleared when that fetch settles.
  const [fetching, setFetching] = useState(false);
  // Brief feedback when a manual refresh came back from the server's cache (it throttles
  // refreshes per guest): shown in place of the freshness label for a moment.
  const [notice, setNotice] = useState<string | null>(null);

  // `phase`/`image` are derived from `isRunning` + the last fetch result rather than kept as
  // their own state: a guest flipping running <-> stopped (e.g. a dashboard resource refetch)
  // then needs no effect of its own to "sync" a mirrored phase -- it just falls out of render.
  const phase: ThumbnailPhase = !isRunning
    ? 'stopped'
    : result === null
      ? 'loading'
      : result.kind === 'not-running'
        ? 'stopped'
        : result.kind;
  const image = result?.kind === 'ok' ? result.image : null;

  useEffect(() => {
    resultRef.current = result;
  }, [result]);

  useEffect(
    () => () => {
      mountedRef.current = false;
      if (noticeTimerRef.current !== undefined) clearTimeout(noticeTimerRef.current);
      if (resultRef.current?.kind === 'ok') URL.revokeObjectURL(resultRef.current.image.url);
    },
    [],
  );

  useEffect(() => {
    const el = containerRef.current;
    if (!el || typeof IntersectionObserver === 'undefined') {
      setIsVisible(true);
      return;
    }
    const observer = new IntersectionObserver((entries) => {
      setIsVisible(entries[0]?.isIntersecting ?? false);
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (typeof document === 'undefined') return;
    function onVisibilityChange() {
      setIsFocused(document.visibilityState === 'visible');
    }
    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => document.removeEventListener('visibilitychange', onVisibilityChange);
  }, []);

  // Ticks `nowMs` every 15s (only while there's a freshness label to keep current) purely so
  // "captured Ns ago" keeps counting up between fetches, without needing a fresh capture.
  useEffect(() => {
    if (phase !== 'ok') return;
    const interval = setInterval(() => setNowMs(Date.now()), 15_000);
    return () => clearInterval(interval);
  }, [phase]);

  // The single effect that ever fetches a capture. Fetch-triggering "events" -- becoming
  // visible/focused, an external `refreshToken` bump, or a retry/manual-refresh click -- are
  // all just dependency changes here; the async fetch itself is defined and invoked directly
  // inside the effect (the shape https://react.dev/learn/you-might-not-need-an-effect's own
  // data-fetching example uses), so every `setResult` call happens strictly after an `await`,
  // never synchronously as part of the effect running.
  useEffect(() => {
    if (!isRunning) return;

    const refreshTokenChanged =
      refreshToken !== undefined && refreshToken !== prevRefreshTokenRef.current;
    const manualTriggerChanged = manualTrigger !== prevManualTriggerRef.current;
    prevRefreshTokenRef.current = refreshToken;
    prevManualTriggerRef.current = manualTrigger;
    const isManual = refreshTokenChanged || manualTriggerChanged;

    // Never fetch while hidden or unfocused -- except an explicit manual bump, which is a
    // deliberate action (e.g. a dashboard "Refresh all") independent of visibility.
    if ((!isVisible || !isFocused) && !isManual) return;

    let cancelled = false;
    let busyRetryTimer: ReturnType<typeof setTimeout> | undefined;

    async function run(refresh: boolean) {
      if (!mountedRef.current || inFlightRef.current || cancelled) return;
      inFlightRef.current = true;
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
      try {
        const url = api.thumbnails.url(node, type, vmid, { w: width, refresh });
        const res = await fetch(url, { signal: controller.signal });
        if (!mountedRef.current || cancelled) return;

        const outcome = classifyThumbnailStatus(res.status);
        if (outcome !== 'ok') {
          if (res.status === 503 && busyRetriesRef.current < THUMBNAIL_BUSY_MAX_RETRIES) {
            const body: unknown = await res.json().catch(() => null);
            if (!mountedRef.current || cancelled) return;
            if (isBusyThumbnailBody(body)) {
              // Queued behind a burst, not failed: keep the skeleton (or the last image)
              // and ask again shortly. `inFlightRef` is cleared in `finally` before the
              // timer fires, so the retry is an ordinary run.
              busyRetriesRef.current += 1;
              busyRetryTimer = setTimeout(() => void run(refresh), THUMBNAIL_BUSY_RETRY_MS);
              return;
            }
          }
          setResult({ kind: outcome === 'stopped' ? 'not-running' : outcome });
          return;
        }
        busyRetriesRef.current = 0;

        const capturedAt = res.headers.get('X-Proxion-Captured-At');
        const servedFromCache = res.headers.get('X-Proxion-Source') === 'cache';
        const blob = await res.blob();
        if (!mountedRef.current || cancelled) return;

        if (refresh && servedFromCache) {
          // The server throttled this refresh and re-served its cached capture: say so,
          // briefly, instead of leaving the click looking like it did nothing.
          setNotice('already fresh');
          if (noticeTimerRef.current !== undefined) clearTimeout(noticeTimerRef.current);
          noticeTimerRef.current = setTimeout(() => {
            if (mountedRef.current) setNotice(null);
          }, NOTICE_MS);
        }

        const objectUrl = URL.createObjectURL(blob);
        const previous = resultRef.current;
        setResult({ kind: 'ok', image: { url: objectUrl, capturedAt } });
        if (previous?.kind === 'ok') URL.revokeObjectURL(previous.image.url);
      } catch {
        if (mountedRef.current && !cancelled) setResult({ kind: 'error' });
      } finally {
        clearTimeout(timeout);
        inFlightRef.current = false;
        if (mountedRef.current) setFetching(false);
      }
    }

    void run(isManual);
    const interval =
      isVisible && isFocused ? setInterval(() => void run(false), refreshIntervalMs) : undefined;

    return () => {
      cancelled = true;
      if (interval !== undefined) clearInterval(interval);
      if (busyRetryTimer !== undefined) clearTimeout(busyRetryTimer);
    };
  }, [
    isRunning,
    isVisible,
    isFocused,
    refreshToken,
    manualTrigger,
    node,
    type,
    vmid,
    width,
    refreshIntervalMs,
  ]);

  const manualRefresh = useCallback((event: MouseEvent<HTMLButtonElement>) => {
    event.stopPropagation();
    if (inFlightRef.current) return; // the button is disabled while fetching anyway
    setFetching(true);
    setManualTrigger((n) => n + 1);
  }, []);

  const retry = useCallback((event: MouseEvent<HTMLButtonElement>) => {
    event.stopPropagation();
    setManualTrigger((n) => n + 1);
  }, []);

  const openConsole = useCallback(() => {
    // Same pop-out the Console tab's toolbar opens; the window name keeps one per guest.
    window.open(
      consolePopoutHref(node, type, vmid),
      consolePopoutWindowName(node, type, vmid),
      CONSOLE_POPOUT_FEATURES,
    );
  }, [node, type, vmid]);

  const onKeyDown = useCallback(
    (event: KeyboardEvent<HTMLDivElement>) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        openConsole();
      }
    },
    [openConsole],
  );

  const freshness = image ? formatCapturedAgo(image.capturedAt, nowMs) : null;

  return (
    <div
      ref={containerRef}
      role="button"
      tabIndex={0}
      aria-label={`Open console for ${name} in a new window`}
      onClick={openConsole}
      onKeyDown={onKeyDown}
      className={cn(
        'group relative aspect-[4/3] w-full cursor-pointer overflow-hidden rounded-md border border-border bg-black outline-none focus-visible:ring-2 focus-visible:ring-ring',
        className,
      )}
    >
      {phase === 'loading' && <Skeleton className="absolute inset-0 rounded-none" />}

      {phase === 'ok' && image && (
        <img
          src={image.url}
          alt={`Console preview for ${name}`}
          className="h-full w-full object-contain"
        />
      )}

      {phase === 'stopped' && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-1.5 text-zinc-500">
          <Power className="size-6" />
          <span className="text-xs">Powered off</span>
        </div>
      )}

      {phase === 'forbidden' && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-1.5 text-zinc-500">
          <Lock className="size-6" />
          <span className="text-xs">No console access</span>
        </div>
      )}

      {phase === 'error' && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-1.5 text-zinc-500">
          <TriangleAlert className="size-6" />
          <span className="text-xs">Preview unavailable</span>
          <button
            type="button"
            onClick={retry}
            className="rounded-sm border border-zinc-700 px-2 py-0.5 text-[11px] text-zinc-300 hover:bg-zinc-800 hover:text-zinc-100"
          >
            Retry
          </button>
        </div>
      )}

      {phase !== 'loading' && (
        <div className="pointer-events-none absolute inset-x-0 bottom-0 flex items-center justify-between gap-2 bg-gradient-to-t from-black/85 to-transparent px-2 py-1.5">
          <div className="flex min-w-0 items-center gap-1.5">
            <StatusDot status={status} template={template} />
            <span className="truncate text-xs font-medium text-white">{name}</span>
            <span className="shrink-0 font-numeric text-[11px] text-zinc-300">#{vmid}</span>
          </div>
          {phase === 'ok' && (
            <div className="pointer-events-auto flex shrink-0 items-center gap-1.5">
              {(notice ?? freshness) && (
                <span className="text-[10px] text-zinc-300">{notice ?? freshness}</span>
              )}
              <button
                type="button"
                aria-label={`Refresh console preview for ${name}`}
                title="Refresh preview"
                onClick={manualRefresh}
                disabled={fetching}
                aria-busy={fetching}
                className="rounded-sm p-0.5 text-zinc-300 hover:bg-white/10 hover:text-white disabled:opacity-70"
              >
                <RefreshCw className={cn('size-3', fetching && 'animate-spin')} />
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
