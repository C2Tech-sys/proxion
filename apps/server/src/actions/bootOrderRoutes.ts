import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { PveApiError, type PveClient } from '@proxion/pve-api';
import { resolveIdentity } from '../pve/identity.js';
import { guestTypeSchema, vmidSchema, hasPrivilege, formatPveErrorMessage, sanitizeMessage } from './shared.js';

/**
 * VM boot order (T51): `PUT /api/actions/guest/:node/:type/:vmid/boot-order`. One more allow-listed
 * write this server performs against PVE, registered from `actionsRoutes` (`routes.ts`) so it shares
 * its rate limiter, same convention as `registerHardwareRoutes`. qemu only -- a container has no
 * boot order. Always writes the modern `boot: order=dev;dev` form (the legacy `boot: cdn` +
 * `bootdisk` pair is only ever read, by the web side). See "Guest actions" in README.md.
 */

/** A bootable qemu device: a disk/CD-ROM slot (ide0-3, sata0-5, scsi0-30, virtio0-15) or a NIC
 * (net0-31) -- qemu's own slot ranges, same as `hardwareRoutes.ts`. */
const BOOT_DEVICE_RE = /^(ide[0-3]|sata[0-5]|scsi(\d|[12]\d|30)|virtio(\d|1[0-5])|net(\d|[12]\d|3[01]))$/;
const MAX_BOOT_DEVICES = 16;

const bodySchema = z
  .object({
    order: z
      .array(z.string().regex(BOOT_DEVICE_RE))
      .max(MAX_BOOT_DEVICES)
      .refine((order) => new Set(order).size === order.length, { message: 'Duplicate boot device' }),
  })
  .strict();

const PRIVILEGE = 'VM.Config.Options';

interface PendingRow {
  key: string;
  pending?: unknown;
  delete?: unknown;
}

export function registerBootOrderRoutes(
  app: FastifyInstance,
  guestActionsRateLimit: ReturnType<FastifyInstance['rateLimit']>,
): void {
  app.put(
    '/api/actions/guest/:node/:type/:vmid/boot-order',
    { onRequest: guestActionsRateLimit },
    async (req, reply) => {
      const rawParams = req.params as Record<string, string>;
      const node = rawParams.node;
      const type = guestTypeSchema.safeParse(rawParams.type);
      const vmid = vmidSchema.safeParse(rawParams.vmid);
      if (!node || !type.success || !vmid.success) {
        reply.code(400).send({ error: 'Invalid node/type/vmid' });
        return;
      }
      if (type.data !== 'qemu') {
        reply.code(400).send({ error: 'not-applicable', message: 'Containers have no boot order.' });
        return;
      }

      const body = bodySchema.safeParse(req.body ?? {});
      if (!body.success) {
        reply.code(400).send({ error: 'Invalid request body' });
        return;
      }

      const identity = await resolveIdentity(app, req);
      if (!identity) {
        reply.code(401).send({ error: 'Not authenticated' });
        return;
      }
      if (identity.credentials.type === 'token') {
        reply.code(403).send({ error: 'writes-disabled-in-token-mode' });
        return;
      }
      const client: PveClient = identity.client;

      let allowed: boolean;
      try {
        allowed = await hasPrivilege(client, vmid.data, PRIVILEGE);
      } catch (error) {
        app.log.warn({ err: error }, 'Failed to check VM.Config.Options permission for boot order update');
        reply.code(502).send({ error: 'pve-unreachable' });
        return;
      }
      if (!allowed) {
        reply.code(403).send({ error: 'forbidden', missing: PRIVILEGE });
        return;
      }

      const sendPveError = (error: unknown): boolean => {
        if (!(error instanceof PveApiError)) return false;
        if (error.status >= 500) {
          reply.code(502).send({ error: 'pve-unreachable' });
        } else {
          reply
            .code(error.status)
            .send({ error: 'pve-rejected', message: sanitizeMessage(formatPveErrorMessage(error)) });
        }
        return true;
      };

      // Every entry must be a device the guest actually has: PVE would otherwise happily store a
      // boot order naming a slot that does not exist.
      let current: Record<string, unknown>;
      try {
        current = (await client.get('/nodes/{node}/qemu/{vmid}/config', {
          node,
          vmid: vmid.data,
        })) as Record<string, unknown>;
      } catch (error) {
        if (sendPveError(error)) return;
        app.log.warn({ err: error }, 'Failed to read current config for boot order update');
        reply.code(502).send({ error: 'pve-unreachable' });
        return;
      }
      const missing = body.data.order.filter((device) => current[device] === undefined || current[device] === null);
      if (missing.length > 0) {
        reply.code(400).send({
          error: 'unknown-device',
          message: `This guest has no device ${missing.join(', ')}.`,
        });
        return;
      }

      // An empty order clears the `boot` key (`delete=boot`): the generated API gives `boot` no
      // documented "no devices" spelling for `order=`, and the PVE UI itself removes the key when
      // nothing is ticked. PVE then falls back to its own default order.
      const order = body.data.order;
      try {
        await client.put(
          '/nodes/{node}/qemu/{vmid}/config',
          (order.length > 0
            ? { node, vmid: vmid.data, boot: `order=${order.join(';')}` }
            : { node, vmid: vmid.data, delete: 'boot' }) as never,
        );
      } catch (error) {
        if (sendPveError(error)) return;
        app.log.warn({ err: error }, 'Boot order update request failed');
        reply.code(502).send({ error: 'pve-unreachable' });
        return;
      }

      // Whether PVE is holding the change back until the guest restarts. A failure to read the
      // pending list never fails the (already applied) update -- it just reports none.
      let pending: string[] = [];
      try {
        const rows: unknown = await client.get('/nodes/{node}/qemu/{vmid}/pending', { node, vmid: vmid.data });
        const held = Array.isArray(rows)
          ? (rows as PendingRow[]).some(
              (row) => row.key === 'boot' && (row.pending !== undefined || Boolean(row.delete)),
            )
          : false;
        pending = held ? ['boot'] : [];
      } catch (error) {
        app.log.warn({ err: error }, 'Failed to read pending config after boot order update');
      }

      app.log.info(
        { username: identity.username, node, type: type.data, vmid: vmid.data, devices: order.length, pending },
        'Guest boot order updated',
      );
      reply.code(200).send({ ok: true, pending });
    },
  );
}
