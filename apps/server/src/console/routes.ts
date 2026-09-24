import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { resolveIdentity } from '../pve/identity.js';

const guestTypeSchema = z.enum(['qemu', 'lxc']);
const vmidSchema = z.coerce.number().int().positive();

export default async function consoleRoutes(app: FastifyInstance): Promise<void> {
  app.post('/api/console/vnc/:node/:type/:vmid', async (req, reply) => {
    const params = req.params as Record<string, string>;
    const type = guestTypeSchema.safeParse(params.type);
    const vmid = vmidSchema.safeParse(params.vmid);
    if (!type.success || !vmid.success || !params.node) {
      reply.code(400).send({ error: 'Invalid node/type/vmid' });
      return;
    }

    const identity = await resolveIdentity(app, req);
    if (!identity) {
      reply.code(401).send({ error: 'Not authenticated' });
      return;
    }

    try {
      const result =
        type.data === 'qemu'
          ? await identity.client.post('/nodes/{node}/qemu/{vmid}/vncproxy', {
              node: params.node,
              vmid: vmid.data,
              websocket: true,
              'generate-password': false,
            })
          : await identity.client.post('/nodes/{node}/lxc/{vmid}/vncproxy', {
              node: params.node,
              vmid: vmid.data,
              websocket: true,
            });

      const id = app.consoleTicketStore.create({
        kind: 'vnc',
        node: params.node,
        type: type.data,
        vmid: vmid.data,
        port: result.port,
        vncticket: result.ticket,
        credentials: identity.credentials,
      });

      reply.send({ wsPath: `/ws/vnc/${id}`, password: result.ticket });
    } catch (error) {
      app.log.warn({ err: error }, 'Failed to start VNC console session');
      reply.code(502).send({ error: 'Failed to start console session' });
    }
  });

  app.post('/api/console/term/:node', async (req, reply) => {
    const params = req.params as Record<string, string>;
    if (!params.node) {
      reply.code(400).send({ error: 'Invalid node' });
      return;
    }

    const identity = await resolveIdentity(app, req);
    if (!identity) {
      reply.code(401).send({ error: 'Not authenticated' });
      return;
    }

    try {
      const result = await identity.client.post('/nodes/{node}/termproxy', { node: params.node });
      const id = app.consoleTicketStore.create({
        kind: 'term',
        type: 'node',
        node: params.node,
        port: result.port,
        vncticket: result.ticket,
        user: result.user,
        credentials: identity.credentials,
      });
      reply.send({ wsPath: `/ws/term/${id}` });
    } catch (error) {
      app.log.warn({ err: error }, 'Failed to start node shell session');
      reply.code(502).send({ error: 'Failed to start console session' });
    }
  });

  app.post('/api/console/term/:node/:type/:vmid', async (req, reply) => {
    const params = req.params as Record<string, string>;
    const type = guestTypeSchema.safeParse(params.type);
    const vmid = vmidSchema.safeParse(params.vmid);
    if (!type.success || !vmid.success || !params.node) {
      reply.code(400).send({ error: 'Invalid node/type/vmid' });
      return;
    }

    const identity = await resolveIdentity(app, req);
    if (!identity) {
      reply.code(401).send({ error: 'Not authenticated' });
      return;
    }

    try {
      const result =
        type.data === 'qemu'
          ? await identity.client.post('/nodes/{node}/qemu/{vmid}/termproxy', {
              node: params.node,
              vmid: vmid.data,
              serial: 'serial0',
            })
          : await identity.client.post('/nodes/{node}/lxc/{vmid}/termproxy', {
              node: params.node,
              vmid: vmid.data,
            });

      const id = app.consoleTicketStore.create({
        kind: 'term',
        node: params.node,
        type: type.data,
        vmid: vmid.data,
        port: result.port,
        vncticket: result.ticket,
        user: result.user,
        credentials: identity.credentials,
      });
      reply.send({ wsPath: `/ws/term/${id}` });
    } catch (error) {
      app.log.warn({ err: error }, 'Failed to start guest console session');
      reply.code(502).send({ error: 'Failed to start console session' });
    }
  });
}
