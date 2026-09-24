// Dev-only stand-in for the Proxion server's term websocket bridge, so Terminal.tsx (and its
// screenshots) can be exercised without a live server. Speaks the same wire framing as the
// real bridge (see src/lib/term-framing.ts and the server's console-bridge README):
//
//   client -> server  "0:<byteLength>:<data>"   input bytes (byteLength counts UTF-8 bytes)
//   client -> server  "1:<cols>:<rows>:"         (re)size the pty
//   client -> server  "2"                        keepalive ping
//   server -> client  binary frames              raw pty output bytes
//
// Point Terminal.tsx at it with VITE_MOCK_TERM_WS=ws://localhost:3099/term (dev only --
// never read in a production build, see the guard in Terminal.tsx).
//
// Usage: node --experimental-strip-types scripts/mock-term-server.ts  (or via tsx/vite-node)
import { WebSocketServer, type WebSocket } from 'ws';

const PORT = 3099;
const PATH = '/term';
const PROMPT = 'mock@proxion:~$ ';

const wss = new WebSocketServer({ port: PORT, path: PATH });

function send(ws: WebSocket, text: string) {
  ws.send(Buffer.from(text, 'utf8'), { binary: true });
}

/** Parses one client->server frame; returns null for anything malformed (ignored). */
function parseFrame(
  raw: string,
):
  | { kind: 'input'; data: string }
  | { kind: 'resize'; cols: number; rows: number }
  | { kind: 'ping' }
  | null {
  if (raw === '2') return { kind: 'ping' };

  if (raw.startsWith('0:')) {
    const secondColon = raw.indexOf(':', 2);
    if (secondColon === -1) return null;
    const data = raw.slice(secondColon + 1);
    return { kind: 'input', data };
  }

  if (raw.startsWith('1:')) {
    const parts = raw.split(':');
    // ["1", cols, rows, ""]
    const cols = Number(parts[1]);
    const rows = Number(parts[2]);
    if (!Number.isFinite(cols) || !Number.isFinite(rows)) return null;
    return { kind: 'resize', cols, rows };
  }

  return null;
}

wss.on('connection', (ws) => {
  console.log('[mock-term-server] client connected');
  send(ws, `Proxion mock shell -- type something.\r\n${PROMPT}`);

  ws.on('message', (raw, isBinary) => {
    if (isBinary) return;
    const frame = parseFrame(raw.toString('utf8'));
    if (!frame) return;

    if (frame.kind === 'ping') {
      // No pong frame in this wire format; the ping alone keeps the connection alive.
      return;
    }
    if (frame.kind === 'resize') {
      console.log(`[mock-term-server] resize ${frame.cols}x${frame.rows}`);
      return;
    }
    // Echo typed input back, and print a fresh prompt after Enter -- just enough to look
    // like a live shell in a screenshot.
    send(ws, frame.data);
    if (frame.data.includes('\r') || frame.data.includes('\n')) {
      send(ws, `\r\n${PROMPT}`);
    }
  });

  ws.on('close', () => {
    console.log('[mock-term-server] client disconnected');
  });
});

console.log(`[mock-term-server] listening on ws://localhost:${PORT}${PATH}`);
