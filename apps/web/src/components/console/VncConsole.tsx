import { useCallback, useEffect, useRef, useState } from 'react';
import RFB from '@novnc/novnc';
import { toast } from 'sonner';
import { Clipboard, Expand, Keyboard, Maximize, RefreshCw } from 'lucide-react';

import { EmptyState } from '@/components/EmptyState';
import { USE_FIXTURES, api } from '@/api/client';
import type { GuestType } from '@/api/types';
import { cn } from '@/lib/utils';
import { ConsoleToolbar, ConsoleToolbarButton } from './ConsoleToolbar';
import type { ConsoleConnectionStatus } from './ConsoleStatusPill';
import { CONSOLE_SURFACE_HEIGHT_CLASS } from './layout';

export interface VncConsoleProps {
  node: string;
  type: GuestType;
  vmid: number;
  /** Pop-out routes give this a real-height ancestor and want the console to fill it exactly. */
  fill?: boolean;
}

/**
 * Embedded noVNC console for a QEMU VM's display. Fetches a one-shot ticket
 * (`POST /api/console/vnc/:node/:type/:vmid`) then opens an RFB session against the
 * websocket it names; the ticket's password lives only inside the RFB instance for the
 * life of the connection, never in component state or storage.
 */
export function VncConsole({ node, type, vmid, fill }: VncConsoleProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const rfbRef = useRef<RFB | null>(null);
  const [status, setStatus] = useState<ConsoleConnectionStatus>('connecting');
  const [reason, setReason] = useState<string | undefined>(undefined);
  const [scaled, setScaled] = useState(true);
  const [attempt, setAttempt] = useState(0);

  // Prefixed with `import.meta.env.BASE_URL` so the pop-out window still resolves under the
  // GitHub Pages demo's `/proxion/` base -- see vite.config.ts's `base`.
  const popoutHref = `${import.meta.env.BASE_URL}console/${node}/${type}/${vmid}`;
  const heightClass = fill ? 'h-full' : CONSOLE_SURFACE_HEIGHT_CLASS;

  useEffect(() => {
    if (USE_FIXTURES) return;

    let cancelled = false;
    let rfb: RFB | null = null;

    async function connect() {
      try {
        const { wsPath, password } = await api.console.vnc(node, type, vmid);
        if (cancelled || !containerRef.current) return;

        const wsUrl =
          (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + wsPath;
        rfb = new RFB(containerRef.current, wsUrl, {
          credentials: { password },
          wsProtocols: ['binary'],
        });
        rfb.scaleViewport = scaled;
        rfb.resizeSession = false;
        rfb.clipViewport = false;
        rfb.focusOnClick = true;

        rfb.addEventListener('connect', () => {
          if (cancelled) return;
          setStatus('connected');
          setReason(undefined);
        });
        rfb.addEventListener('disconnect', (e) => {
          if (cancelled) return;
          const clean = (e as CustomEvent<{ clean: boolean }>).detail?.clean ?? true;
          setStatus('disconnected');
          setReason(clean ? undefined : 'Connection lost');
        });
        rfb.addEventListener('securityfailure', (e) => {
          if (cancelled) return;
          const detail = (e as CustomEvent<{ reason?: string; status?: number }>).detail;
          setStatus('disconnected');
          setReason(detail?.reason ?? 'Security handshake failed');
        });
        rfb.addEventListener('credentialsrequired', () => {
          if (cancelled) return;
          setStatus('disconnected');
          setReason('Credentials required');
        });

        rfbRef.current = rfb;
      } catch (err) {
        if (cancelled) return;
        setStatus('disconnected');
        setReason(err instanceof Error ? err.message : 'Failed to start console session');
      }
    }

    void connect();

    return () => {
      cancelled = true;
      rfb?.disconnect();
      rfbRef.current = null;
    };
    // `scaled` intentionally excluded -- toggling it flips the live RFB property (see
    // toggleScale) instead of tearing down and reconnecting the session.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [node, type, vmid, attempt]);

  const sendCtrlAltDel = useCallback(() => {
    rfbRef.current?.sendCtrlAltDel();
  }, []);

  const toggleScale = useCallback(() => {
    setScaled((prev) => {
      const next = !prev;
      if (rfbRef.current) rfbRef.current.scaleViewport = next;
      return next;
    });
  }, []);

  const requestFullscreen = useCallback(() => {
    containerRef.current?.requestFullscreen().catch(() => {
      toast.error('Fullscreen is not available');
    });
  }, []);

  const reconnect = useCallback(() => {
    setStatus('connecting');
    setReason(undefined);
    setAttempt((n) => n + 1);
  }, []);

  const pasteClipboard = useCallback(() => {
    navigator.clipboard
      .readText()
      .then((text) => rfbRef.current?.clipboardPasteFrom(text))
      .catch(() => toast.error('Could not read the clipboard'));
  }, []);

  const openPopout = useCallback(() => {
    window.open(popoutHref, '_blank', 'popup,width=1280,height=800');
  }, [popoutHref]);

  if (USE_FIXTURES) {
    return (
      <div className={cn('flex flex-col', heightClass)} data-hotkey-scope="console">
        <ConsoleToolbar
          status="disconnected"
          reason="Fixture mode"
          disabled
          popoutHref={popoutHref}
          onPopout={openPopout}
        >
          <ConsoleToolbarButton icon={Keyboard} label="Ctrl+Alt+Del" disabled />
          <ConsoleToolbarButton icon={Maximize} label="Scale to fit" disabled />
          <ConsoleToolbarButton icon={Expand} label="Fullscreen" disabled />
          <ConsoleToolbarButton icon={Clipboard} label="Paste clipboard" disabled />
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
        <ConsoleToolbarButton
          icon={Keyboard}
          label="Ctrl+Alt+Del"
          onClick={sendCtrlAltDel}
          disabled={status !== 'connected'}
        />
        <ConsoleToolbarButton
          icon={Maximize}
          label="Scale to fit"
          onClick={toggleScale}
          active={scaled}
        />
        <ConsoleToolbarButton icon={Expand} label="Fullscreen" onClick={requestFullscreen} />
        <ConsoleToolbarButton
          icon={Clipboard}
          label="Paste clipboard"
          onClick={pasteClipboard}
          disabled={status !== 'connected'}
        />
        <ConsoleToolbarButton icon={RefreshCw} label="Reconnect" onClick={reconnect} />
      </ConsoleToolbar>
      <div
        ref={containerRef}
        className="min-h-0 flex-1 overflow-hidden rounded-b-md border border-t-0 border-border bg-black"
      />
    </div>
  );
}
