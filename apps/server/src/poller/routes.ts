import type { FastifyInstance } from 'fastify';
import { resolveIdentity } from '../pve/identity.js';

const HEARTBEAT_INTERVAL_MS = 15000;

function sseWrite(raw: NodeJS.WritableStream, event: string, data: unknown): void {
  raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

export default async function pollerRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/state', async (req, reply) => {
    // The snapshot is the whole inventory: never serve it to an unauthenticated caller,
    // and do not even reveal whether polling is configured.
    if (!(await resolveIdentity(app, req))) {
      reply.code(401).send({ error: 'Not authenticated' });
      return;
    }
    const poller = app.proxionPoller;
    if (!poller) {
      reply.code(503).send({ error: 'Live polling is disabled (no service token configured)' });
      return;
    }
    reply.send(poller.getSnapshot());
  });

  app.get('/api/events', async (req, reply) => {
    if (!(await resolveIdentity(app, req))) {
      reply.code(401).send({ error: 'Not authenticated' });
      return;
    }
    const poller = app.proxionPoller;
    if (!poller) {
      reply.code(503).send({ error: 'Live polling is disabled (no service token configured)' });
      return;
    }

    reply.raw.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    });
    reply.hijack();

    sseWrite(reply.raw, 'snapshot', poller.getSnapshot());

    const unsubscribe = poller.on((event) => sseWrite(reply.raw, event.type, event.data));
    const heartbeat = setInterval(() => reply.raw.write(':heartbeat\n\n'), HEARTBEAT_INTERVAL_MS);

    const cleanup = () => {
      clearInterval(heartbeat);
      unsubscribe();
    };
    req.raw.on('close', cleanup);
    reply.raw.on('close', cleanup);
  });
}
