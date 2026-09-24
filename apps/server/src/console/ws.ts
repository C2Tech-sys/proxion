import type { FastifyInstance } from 'fastify';
import type { RawData } from 'ws';
import { bridgeSockets, type BridgeHandle } from './bridge.js';
import { openUpstreamConsoleSocket } from './upstream.js';
import type { PendingConsole } from './ticketStore.js';

function toText(data: RawData): string {
  if (Buffer.isBuffer(data)) return data.toString('utf8');
  if (Array.isArray(data)) return Buffer.concat(data).toString('utf8');
  return Buffer.from(data).toString('utf8');
}

function vncwebsocketPath(entry: Extract<PendingConsole, { kind: 'vnc' }>): string {
  return `/nodes/${encodeURIComponent(entry.node)}/${entry.type}/${encodeURIComponent(String(entry.vmid))}/vncwebsocket`;
}

function termProxyPath(entry: Extract<PendingConsole, { kind: 'term' }>): string {
  if (entry.type === 'node') {
    return `/nodes/${encodeURIComponent(entry.node)}/vncwebsocket`;
  }
  return `/nodes/${encodeURIComponent(entry.node)}/${entry.type}/${encodeURIComponent(String(entry.vmid))}/vncwebsocket`;
}

export default async function consoleWsRoutes(app: FastifyInstance): Promise<void> {
  app.get('/ws/vnc/:id', { websocket: true }, (socket, req) => {
    const { id } = req.params as { id: string };
    const entry = app.consoleTicketStore.consume(id);
    if (!entry || entry.kind !== 'vnc') {
      socket.close(4404, 'Unknown or expired console session');
      return;
    }

    const upstream = openUpstreamConsoleSocket(
      app.proxionConfig,
      app.pveWsAgent,
      entry.credentials,
      vncwebsocketPath(entry),
      {
        port: entry.port,
        vncticket: entry.vncticket,
      },
    );
    upstream.on('error', (err) =>
      app.log.warn({ err: err.message }, 'Upstream PVE VNC connection failed'),
    );

    bridgeSockets(socket, upstream);
  });

  app.get('/ws/term/:id', { websocket: true }, (socket, req) => {
    const { id } = req.params as { id: string };
    const entry = app.consoleTicketStore.consume(id);
    if (!entry || entry.kind !== 'term') {
      socket.close(4404, 'Unknown or expired console session');
      return;
    }

    const upstream = openUpstreamConsoleSocket(
      app.proxionConfig,
      app.pveWsAgent,
      entry.credentials,
      termProxyPath(entry),
      {
        port: entry.port,
        vncticket: entry.vncticket,
      },
    );
    upstream.on('error', (err) =>
      app.log.warn({ err: err.message }, 'Upstream PVE terminal connection failed'),
    );

    let handshakeDone = false;

    const handle: BridgeHandle = bridgeSockets(socket, upstream, {
      // Never relay browser frames (keystrokes, the initial resize, ...) upstream
      // until PVE's `OK` handshake reply has actually arrived -- PVE is still
      // reading the `user:ticket\n` auth line up to that point, and anything sent
      // early can corrupt it or is silently dropped.
      requiresExplicitReady: true,
      onUpstreamOpen: () => {
        // Never logged: this line carries the caller's PVE ticket.
        upstream.send(`${entry.user}:${entry.vncticket}\n`);
      },
      interceptUpstreamMessage: (data) => {
        if (handshakeDone) return false;
        if (toText(data).includes('OK')) {
          handshakeDone = true;
          handle.markReady();
        } else {
          handle.fail(4502, 'PVE terminal handshake failed');
        }
        return true;
      },
    });

    // Added *after* `bridgeSockets` already attached its own `close` listener, but
    // `prependListener` runs it first regardless: if the upstream closes before we
    // ever saw `OK`, report the handshake failure specifically, instead of falling
    // through to the bridge's generic "Upstream PVE connection failed".
    upstream.prependListener('close', () => {
      if (!handshakeDone) handle.fail(4502, 'PVE terminal handshake failed');
    });
  });
}
