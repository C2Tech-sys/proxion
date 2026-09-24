import type WebSocket from 'ws';
import type { RawData } from 'ws';

function toBuffer(data: RawData): Buffer {
  if (Buffer.isBuffer(data)) return data;
  if (Array.isArray(data)) return Buffer.concat(data);
  return Buffer.from(data);
}

export interface BridgeOptions {
  /** Called once the upstream socket opens (e.g. to send the terminal handshake line). */
  onUpstreamOpen?: () => void;
  /**
   * Inspects each upstream message before it would be relayed to the
   * browser. Return `true` to consume it (not forward it) -- used for the
   * terminal bridge's `OK` handshake reply.
   */
  interceptUpstreamMessage?: (data: RawData) => boolean;
  /**
   * When `true`, browser->upstream frames stay buffered -- even after the
   * upstream socket opens -- until `BridgeHandle.markReady()` is called.
   * Used by the terminal bridge to withhold the browser's frames (e.g. its
   * initial resize) until PVE's `OK` handshake reply has actually arrived;
   * sending anything upstream before that can corrupt the `user:ticket\n`
   * auth line PVE is still reading. Defaults to `false` (ready as soon as
   * the upstream socket opens -- the VNC bridge's behavior).
   */
  requiresExplicitReady?: boolean;
}

export interface BridgeHandle {
  /** Marks the bridge ready to relay browser->upstream frames, flushing anything buffered so far. */
  markReady(): void;
  /** Closes the browser socket with a specific code/reason and tears the upstream socket down too (e.g. a failed handshake). */
  fail(code: number, reason: string): void;
}

/**
 * Pipes binary frames both ways between a browser-facing websocket and an
 * upstream PVE websocket. Frames sent by the browser before the bridge is
 * "ready" (see `requiresExplicitReady`) are buffered and flushed once it is.
 *
 * Closing is directional: if the browser closes/errors first, the upstream
 * is torn down with a bare `terminate()` (there's no one left to explain
 * anything to). If the *upstream* closes/errors first, the browser is sent
 * a real close frame (code 4502) so the web client can show why, rather
 * than just dropping silently.
 */
export function bridgeSockets(browser: WebSocket, upstream: WebSocket, options: BridgeOptions = {}): BridgeHandle {
  let upstreamOpen = false;
  let ready = !options.requiresExplicitReady;
  const pending: Buffer[] = [];
  let closed = false;

  function flush(): void {
    if (!ready || !upstreamOpen) return;
    for (const chunk of pending.splice(0)) upstream.send(chunk);
  }

  function closeUpstream(): void {
    if (upstream.readyState === upstream.OPEN || upstream.readyState === upstream.CONNECTING) {
      upstream.terminate();
    }
  }

  function closeBrowser(code?: number, reason?: string): void {
    if (browser.readyState !== browser.OPEN && browser.readyState !== browser.CONNECTING) return;
    if (code === undefined) {
      browser.terminate();
    } else {
      browser.close(code, reason);
    }
  }

  function finish(browserCode?: number, browserReason?: string): void {
    if (closed) return;
    closed = true;
    closeBrowser(browserCode, browserReason);
    closeUpstream();
  }

  upstream.on('open', () => {
    upstreamOpen = true;
    options.onUpstreamOpen?.();
    flush();
  });

  browser.on('message', (data: RawData) => {
    const buf = toBuffer(data);
    if (ready && upstreamOpen) {
      upstream.send(buf);
    } else {
      pending.push(buf);
    }
  });

  upstream.on('message', (data: RawData) => {
    if (options.interceptUpstreamMessage?.(data)) return;
    browser.send(toBuffer(data));
  });

  // Browser side closes/errors first: nothing left to explain to, just tear the upstream down.
  browser.on('close', () => finish());
  browser.on('error', () => finish());

  // Upstream side closes/errors first: tell the browser why with a real close frame.
  upstream.on('close', () => finish(4502, 'Upstream PVE connection failed'));
  upstream.on('error', () => finish(4502, 'Upstream PVE connection failed'));

  return {
    markReady: () => {
      ready = true;
      flush();
    },
    fail: (code: number, reason: string) => finish(code, reason),
  };
}
