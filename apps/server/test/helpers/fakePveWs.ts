import type { IncomingMessage, Server } from 'node:http';
import { WebSocketServer, type WebSocket as WsWebSocket } from 'ws';

/**
 * Attaches PVE's `vncwebsocket` upgrade endpoint to an *already-listening*
 * `http.Server` -- specifically `fakePve.app.server` from `startFakePve`, so
 * REST calls (`vncproxy`/`termproxy`) and the websocket upgrade share one
 * host:port, exactly as `PVE_URL` requires. Only upgrades requests whose
 * path contains `vncwebsocket`; anything else is destroyed.
 */
export function attachFakePveWs(
  server: Server,
  onConnection: (ws: WsWebSocket, req: IncomingMessage) => void,
): { wss: WebSocketServer; close: () => void } {
  const wss = new WebSocketServer({ noServer: true });
  wss.on('connection', onConnection);

  server.on('upgrade', (req, socket, head) => {
    if (req.url?.includes('vncwebsocket')) {
      wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
    } else {
      socket.destroy();
    }
  });

  return { wss, close: () => wss.close() };
}

export type TermproxyHandshakeAction = 'ok' | 'reject' | 'close';

/**
 * A scripted stand-in for PVE's `termproxy`/`vncwebsocket` handshake: records
 * every message it receives, in order, treats the first as the
 * `user:ticket\n` handshake line, and reacts per `onHandshake`'s decision --
 * `'ok'` replies `OK` (optionally after `okDelayMs`, to prove the bridge
 * actually withholds later frames rather than happening to be fast enough),
 * `'reject'` replies with something that is *not* `OK`, and `'close'` closes
 * the connection without replying at all. Anything received after the
 * handshake is echoed back unchanged.
 */
export function scriptedTermproxy(options: {
  onHandshake: (line: string) => TermproxyHandshakeAction;
  okDelayMs?: number;
}): { onConnection: (ws: WsWebSocket) => void; received: string[] } {
  const received: string[] = [];

  const onConnection = (ws: WsWebSocket) => {
    let handshakeSeen = false;
    ws.on('message', (data) => {
      const text = Buffer.isBuffer(data) ? data.toString('utf8') : String(data);
      received.push(text);

      if (!handshakeSeen) {
        handshakeSeen = true;
        const action = options.onHandshake(text);
        if (action === 'ok') {
          if (options.okDelayMs) {
            setTimeout(() => ws.send('OK'), options.okDelayMs);
          } else {
            ws.send('OK');
          }
        } else if (action === 'reject') {
          ws.send('ERR');
        } else {
          ws.close();
        }
        return;
      }

      ws.send(data);
    });
  };

  return { onConnection, received };
}
