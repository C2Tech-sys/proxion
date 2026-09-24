import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { resolveIdentity } from '../pve/identity.js';

const guestTypeSchema = z.enum(['qemu', 'lxc']);
const vmidSchema = z.coerce.number().int().positive();
const widthSchema = z.coerce.number().int().min(1).max(800);

const DEFAULT_WIDTH = 400;

/**
 * Server-side VM console thumbnails: a downscaled PNG screenshot of the
 * guest's display, captured over a short-lived VNC (RFB) session through
 * the same `vncproxy`/`vncwebsocket` path the interactive console bridge
 * uses. See "Console thumbnails" in README.md for the full contract.
 */
export default async function consoleThumbnailRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/console/thumbnail/status', async (req, reply) => {
    const identity = await resolveIdentity(app, req);
    if (!identity) {
      reply.code(401).send({ error: 'Not authenticated' });
      return;
    }

    reply.send({
      inFlight: app.consoleThumbnails.inFlight,
      cached: app.consoleThumbnails.listCached(),
      agents: await app.consoleThumbnails.listAgentStatus(),
    });
  });

  app.get('/api/console/thumbnail/:node/:type/:vmid.png', async (req, reply) => {
    const params = req.params as Record<string, string>;
    const type = guestTypeSchema.safeParse(params.type);
    const vmid = vmidSchema.safeParse(params.vmid);
    if (!type.success || !vmid.success || !params.node) {
      reply.code(400).send({ error: 'Invalid node/type/vmid' });
      return;
    }

    const query = req.query as Record<string, string | undefined>;
    const parsedWidth = widthSchema.safeParse(query.w ?? DEFAULT_WIDTH);
    const width = parsedWidth.success ? parsedWidth.data : DEFAULT_WIDTH;
    const refresh = query.refresh === '1';

    const identity = await resolveIdentity(app, req);
    if (!identity) {
      reply.code(401).send({ error: 'Not authenticated' });
      return;
    }

    let hasConsolePermission: boolean;
    try {
      const vmPath = `/vms/${vmid.data}`;
      const perms = (await identity.client.get('/access/permissions', {
        path: vmPath,
      })) as Record<string, unknown>;
      // Real PVE nests the result under the requested path (`{ "/vms/113": { "VM.Console": 1, ... } }`);
      // fall back to a flat map (`{ "VM.Console": 1, ... }`) too, in case that ever changes.
      const scoped = (perms[vmPath] as Record<string, unknown> | undefined) ?? perms;
      hasConsolePermission = Boolean(scoped['VM.Console']);
    } catch (error) {
      app.log.warn({ err: error }, 'Failed to check VM.Console permission for console thumbnail');
      reply.header('Cache-Control', 'no-store').code(503).send({ error: 'capture-failed' });
      return;
    }
    if (!hasConsolePermission) {
      reply.code(403).send({ error: 'Forbidden' });
      return;
    }

    let running: boolean;
    try {
      const status =
        type.data === 'qemu'
          ? await identity.client.get('/nodes/{node}/qemu/{vmid}/status/current', {
              node: params.node,
              vmid: vmid.data,
            })
          : await identity.client.get('/nodes/{node}/lxc/{vmid}/status/current', {
              node: params.node,
              vmid: vmid.data,
            });
      running = status.status === 'running';
    } catch (error) {
      app.log.warn({ err: error }, 'Failed to check VM status for console thumbnail');
      reply.header('Cache-Control', 'no-store').code(503).send({ error: 'capture-failed' });
      return;
    }
    if (!running) {
      reply.header('Cache-Control', 'no-store').code(404).send({ error: 'not-running' });
      return;
    }

    const outcome = await app.consoleThumbnails.get({
      node: params.node,
      type: type.data,
      vmid: vmid.data,
      width,
      refresh,
      identity,
    });

    if (outcome.kind === 'busy') {
      reply.header('Cache-Control', 'no-store').code(503).send({ error: 'busy' });
      return;
    }
    if (outcome.kind === 'capture-failed') {
      reply.header('Cache-Control', 'no-store').code(503).send({ error: 'capture-failed' });
      return;
    }
    if (outcome.kind === 'not-running') {
      // The agent's view is authoritative at capture time -- the route's own status/current
      // check above can be stale by the time the capture actually runs.
      reply.header('Cache-Control', 'no-store').code(404).send({ error: 'not-running' });
      return;
    }

    reply
      .header('Cache-Control', 'private, max-age=30')
      .header('X-Proxion-Captured-At', outcome.capturedAtIso)
      .header('X-Proxion-Source', outcome.source)
      .header('X-Proxion-Capture', outcome.capturePath)
      .type('image/png')
      .send(outcome.png);
  });
}
