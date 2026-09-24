import { useEffect, useRef, useState } from 'react';
import { Terminal as XTerm } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import '@xterm/xterm/css/xterm.css';
import { toast } from 'sonner';
import { Expand, RefreshCw } from 'lucide-react';

import { EmptyState } from '@/components/EmptyState';
import { USE_FIXTURES, api } from '@/api/client';
import type { GuestType } from '@/api/types';
import { cn } from '@/lib/utils';
import { encodeInputFrame, encodePingFrame, encodeResizeFrame } from '@/lib/term-framing';
import { ConsoleToolbar, ConsoleToolbarButton } from './ConsoleToolbar';
import type { ConsoleConnectionStatus } from './ConsoleStatusPill';
import { CONSOLE_SURFACE_HEIGHT_CLASS } from './layout';
import { readCssColor, readCssFontFamily } from './theme';

const PING_INTERVAL_MS = 30_000;

/**
 * Dev-only escape hatch (see apps/web/scripts/mock-term-server.ts): when set, the terminal
 * connects straight to this websocket instead of asking our server for a ticket, so it can
 * be exercised (and screenshotted) without a live Proxion server. Read in dev, and also in a
 * `--mode screenshot` build (screenshot.ts's second, mock-term build stage) -- both
 * `import.meta.env.DEV` and `import.meta.env.MODE` are statically known at build time, so
 * this whole branch is dead-code-eliminated from an ordinary production bundle.
 */
const MOCK_WS_URL =
  import.meta.env.DEV || import.meta.env.MODE === 'screenshot'
    ? (import.meta.env.VITE_MOCK_TERM_WS as string | undefined)
    : undefined;

export interface TerminalProps {
  node: string;
  /** Omit type/vmid for a node shell; pass both for a guest console (lxc). */
  type?: GuestType | undefined;
  vmid?: number | undefined;
  /** Pop-out routes give this a real-height ancestor and want the terminal to fill it exactly. */
  fill?: boolean;
}

/**
 * xterm.js terminal wired to the Proxion term websocket bridge
 * (`POST /api/console/term/:node[/:type/:vmid]` -> `{ wsPath }`). Framing is defined by the
 * server's console-bridge README and implemented in `@/lib/term-framing`.
 */
export function Terminal({ node, type, vmid, fill }: TerminalProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const [status, setStatus] = useState<ConsoleConnectionStatus>('connecting');
  const [reason, setReason] = useState<string | undefined>(undefined);
  const [attempt, setAttempt] = useState(0);

  // Prefixed with `import.meta.env.BASE_URL` so the pop-out window still resolves under the
  // GitHub Pages demo's `/proxion/` base -- see vite.config.ts's `base`.
  const popoutHref =
    type && vmid !== undefined
      ? `${import.meta.env.BASE_URL}console/${node}/${type}/${vmid}`
      : `${import.meta.env.BASE_URL}shell/${node}`;
  const showFixtureEmptyState = USE_FIXTURES && !MOCK_WS_URL;
  const heightClass = fill ? 'h-full' : CONSOLE_SURFACE_HEIGHT_CLASS;

  useEffect(() => {
    if (showFixtureEmptyState) return;
    const container = containerRef.current;
    if (!container) return;

    let cancelled = false;
    let pingInterval: ReturnType<typeof setInterval> | undefined;
    let disposeDataHandler: (() => void) | undefined;
    let disposeResizeHandler: (() => void) | undefined;

    const term = new XTerm({
      cursorBlink: true,
      scrollback: 5000,
      fontFamily: readCssFontFamily(
        '--font-mono',
        'ui-monospace, "Cascadia Mono", Consolas, SFMono-Regular, monospace',
      ),
      fontSize: 13,
      theme: {
        background: readCssColor('--background'),
        foreground: readCssColor('--foreground'),
        cursor: readCssColor('--accent-teal'),
        selectionBackground: readCssColor('--accent-teal', '#6b7280'),
      },
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.loadAddon(new WebLinksAddon());
    term.open(container);
    fit.fit();

    function sendResize(ws: WebSocket) {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(encodeResizeFrame(term.cols, term.rows));
      }
    }

    async function connect() {
      let wsUrl: string;
      try {
        if (MOCK_WS_URL) {
          wsUrl = MOCK_WS_URL;
        } else {
          const { wsPath } = await api.console.term(node, type, vmid);
          wsUrl = (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + wsPath;
        }
      } catch (err) {
        if (!cancelled) {
          setStatus('disconnected');
          setReason(err instanceof Error ? err.message : 'Failed to start shell session');
        }
        return;
      }
      if (cancelled) return;

      const ws = new WebSocket(wsUrl, ['binary']);
      ws.binaryType = 'arraybuffer';
      wsRef.current = ws;

      ws.onopen = () => {
        if (cancelled) return;
        setStatus('connected');
        setReason(undefined);
        sendResize(ws);
        pingInterval = setInterval(() => {
          if (ws.readyState === WebSocket.OPEN) ws.send(encodePingFrame());
        }, PING_INTERVAL_MS);
      };
      ws.onmessage = (ev) => {
        // With `binaryType = 'arraybuffer'`, non-string frames arrive as ArrayBuffer -- but
        // an `instanceof ArrayBuffer` check can false-negative across realms (e.g. a jsdom
        // test environment's ArrayBuffer vs. Node's), so branch on the one shape the server
        // actually sends text as (string) instead.
        if (typeof ev.data === 'string') {
          term.write(ev.data);
        } else {
          term.write(new Uint8Array(ev.data as ArrayBuffer));
        }
      };
      ws.onclose = () => {
        if (pingInterval) clearInterval(pingInterval);
        if (cancelled) return;
        setStatus('disconnected');
        setReason('Disconnected');
      };
      ws.onerror = () => {
        if (cancelled) return;
        setStatus('disconnected');
        setReason('Connection error');
      };

      const dataListener = term.onData((data) => {
        if (ws.readyState === WebSocket.OPEN) ws.send(encodeInputFrame(data));
      });
      const resizeListener = term.onResize(() => sendResize(ws));
      disposeDataHandler = () => dataListener.dispose();
      disposeResizeHandler = () => resizeListener.dispose();
    }

    void connect();

    let resizeObserver: ResizeObserver | undefined;
    if (typeof ResizeObserver !== 'undefined') {
      resizeObserver = new ResizeObserver(() => fit.fit());
      resizeObserver.observe(container);
    }

    return () => {
      cancelled = true;
      resizeObserver?.disconnect();
      if (pingInterval) clearInterval(pingInterval);
      disposeDataHandler?.();
      disposeResizeHandler?.();
      wsRef.current?.close();
      wsRef.current = null;
      term.dispose();
    };
  }, [node, type, vmid, attempt, showFixtureEmptyState]);

  function reconnect() {
    setStatus('connecting');
    setReason(undefined);
    setAttempt((n) => n + 1);
  }

  function requestFullscreen() {
    containerRef.current?.requestFullscreen().catch(() => {
      toast.error('Fullscreen is not available');
    });
  }

  function openPopout() {
    window.open(popoutHref, '_blank', 'popup,width=1280,height=800');
  }

  if (showFixtureEmptyState) {
    return (
      <div className={cn('flex flex-col', heightClass)} data-hotkey-scope="console">
        <ConsoleToolbar
          status="disconnected"
          reason="Fixture mode"
          disabled
          popoutHref={popoutHref}
          onPopout={openPopout}
        >
          <ConsoleToolbarButton icon={Expand} label="Fullscreen" disabled />
          <ConsoleToolbarButton icon={RefreshCw} label="Reconnect" disabled />
        </ConsoleToolbar>
        <div className="flex flex-1 min-h-0 items-center justify-center rounded-b-md border border-t-0 border-border bg-surface-sunken">
          <EmptyState message="Console needs a connected Proxion server" />
        </div>
      </div>
    );
  }

  return (
    <div className={cn('flex flex-col', heightClass)} data-hotkey-scope="console">
      <ConsoleToolbar status={status} reason={reason} popoutHref={popoutHref} onPopout={openPopout}>
        <ConsoleToolbarButton icon={Expand} label="Fullscreen" onClick={requestFullscreen} />
        <ConsoleToolbarButton icon={RefreshCw} label="Reconnect" onClick={reconnect} />
      </ConsoleToolbar>
      <div
        ref={containerRef}
        className="min-h-0 flex-1 overflow-hidden rounded-b-md border border-t-0 border-border bg-black p-1"
      />
    </div>
  );
}
