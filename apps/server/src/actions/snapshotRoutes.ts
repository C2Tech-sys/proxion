import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import { PveApiError, type PveClient } from '@proxion/pve-api';
import { resolveIdentity } from '../pve/identity.js';
import {
  guestTypeSchema,
  vmidSchema,
  hasPrivilege,
  sanitizeDescription,
  sanitizeMessage,
  MAX_DESCRIPTION_LENGTH,
} from './shared.js';

/**
 * PVE's own snapshot-name rule: starts with a letter, then any run of letters, digits,
 * underscores or hyphens, 2-40 characters total. `current` is PVE's reserved sentinel for the
 * live-state row (`GET .../snapshot` always includes one) and is never a valid name to create,
 * delete or roll back to, even though it happens to match this shape.
 *
 * KEEP THIS IDENTICAL to `isValidSnapshotName` in `apps/web/src/lib/snapshotName.ts` -- same
 * rule, enforced client-side for inline validation before a request is ever sent; this copy is
 * what actually protects PVE, the client-side one is only a UX nicety (mirrors the `isValidDnsName`
 * pair documented in `routes.ts`/`apps/web/src/lib/guestName.ts`).
 */
const SNAPSHOT_NAME_RE = /^[A-Za-z][A-Za-z0-9_-]{1,39}$/;

export function isValidSnapshotName(value: string): boolean {
  return value !== 'current' && SNAPSHOT_NAME_RE.test(value);
}

// `.strict()`: an unknown key is a 400 rather than being silently ignored, same rationale as the
// power-action/config routes' own body schemas. `snapname`'s shape isn't validated here -- it's
// the same rule for both routes below but each needs a distinct error response, so the route
// handlers call `isValidSnapshotName` themselves once the guest `type` is known (relevant for the
// `vmstate`-is-qemu-only check that also depends on `type`).
const createBodySchema = z
  .object({
    snapname: z.string(),
    description: z.string().max(MAX_DESCRIPTION_LENGTH).optional(),
    vmstate: z.boolean().optional(),
  })
  .strict();

const rollbackBodySchema = z
  .object({
    start: z.boolean().optional(),
  })
  .strict();

interface GuestRouteParams {
  node: string;
  type: 'qemu' | 'lxc';
  vmid: number;
}

/** Parses/validates the common `:node/:type/:vmid` triple every route below starts with. */
function parseGuestParams(rawParams: Record<string, string>): GuestRouteParams | undefined {
  const node = rawParams.node;
  const type = guestTypeSchema.safeParse(rawParams.type);
  const vmid = vmidSchema.safeParse(rawParams.vmid);
  if (!node || !type.success || !vmid.success) return undefined;
  return { node, type: type.data, vmid: vmid.data };
}

/**
 * Dispatches the snapshot create to PVE via one explicit, generated-endpoint-checked
 * `client.post()` call per guest type -- same rationale as `callAction` in `routes.ts`. qemu's
 * endpoint accepts `vmstate`; lxc's has no such parameter at all.
 */
async function callCreateSnapshot(
  client: PveClient,
  type: 'qemu' | 'lxc',
  { node, vmid, snapname, description, vmstate }: GuestRouteParams & {
    snapname: string;
    description?: string;
    vmstate?: boolean;
  },
): Promise<string> {
  if (type === 'qemu') {
    return client.post('/nodes/{node}/qemu/{vmid}/snapshot', {
      node,
      vmid,
      snapname,
      ...(description !== undefined ? { description } : {}),
      ...(vmstate !== undefined ? { vmstate } : {}),
    });
  }
  return client.post('/nodes/{node}/lxc/{vmid}/snapshot', {
    node,
    vmid,
    snapname,
    ...(description !== undefined ? { description } : {}),
  });
}

async function callDeleteSnapshot(
  client: PveClient,
  type: 'qemu' | 'lxc',
  { node, vmid, snapname, force }: GuestRouteParams & { snapname: string; force?: boolean },
): Promise<string> {
  if (type === 'qemu') {
    return client.delete('/nodes/{node}/qemu/{vmid}/snapshot/{snapname}', {
      node,
      vmid,
      snapname,
      ...(force !== undefined ? { force } : {}),
    });
  }
  return client.delete('/nodes/{node}/lxc/{vmid}/snapshot/{snapname}', {
    node,
    vmid,
    snapname,
    ...(force !== undefined ? { force } : {}),
  });
}

async function callRollbackSnapshot(
  client: PveClient,
  type: 'qemu' | 'lxc',
  { node, vmid, snapname, start }: GuestRouteParams & { snapname: string; start?: boolean },
): Promise<string> {
  if (type === 'qemu') {
    return client.post('/nodes/{node}/qemu/{vmid}/snapshot/{snapname}/rollback', {
      node,
      vmid,
      snapname,
      ...(start !== undefined ? { start } : {}),
    });
  }
  return client.post('/nodes/{node}/lxc/{vmid}/snapshot/{snapname}/rollback', { node, vmid, snapname });
}

/** Maps a PVE call failure to the same `502`/`4xx` response shape every guest-action route uses;
 * returns `true` iff it sent a reply (so the caller can just `return` on `true`). */
function sendPveError(reply: FastifyReply, error: unknown): boolean {
  if (error instanceof PveApiError) {
    if (error.status >= 500) {
      reply.code(502).send({ error: 'pve-unreachable' });
    } else {
      reply.code(error.status).send({ error: 'pve-rejected', message: sanitizeMessage(error.message) });
    }
    return true;
  }
  return false;
}

/**
 * Snapshot create/delete/rollback -- three more allow-listed writes this server performs
 * against PVE, registered from `actionsRoutes` (`routes.ts`) so they share its rate limiter. See
 * "Guest actions" in README.md for the full contract.
 */
export function registerSnapshotRoutes(
  app: FastifyInstance,
  guestActionsRateLimit: ReturnType<FastifyInstance['rateLimit']>,
): void {
  app.post(
    '/api/actions/guest/:node/:type/:vmid/snapshots',
    { onRequest: guestActionsRateLimit },
    async (req, reply) => {
      const params = parseGuestParams(req.params as Record<string, string>);
      if (!params) {
        reply.code(400).send({ error: 'Invalid node/type/vmid' });
        return;
      }

      const body = createBodySchema.safeParse(req.body ?? {});
      if (!body.success) {
        reply.code(400).send({ error: 'Invalid request body' });
        return;
      }

      if (!isValidSnapshotName(body.data.snapname)) {
        reply.code(400).send({
          error: 'invalid-snapname',
          message:
            'Name must start with a letter, then letters, digits, underscores or hyphens, 2-40 characters total, and cannot be "current".',
        });
        return;
      }

      if (params.type === 'lxc' && body.data.vmstate !== undefined) {
        reply.code(400).send({ error: 'vmstate is only valid for qemu guests' });
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

      let allowed: boolean;
      try {
        allowed = await hasPrivilege(identity.client, params.vmid, 'VM.Snapshot');
      } catch (error) {
        app.log.warn({ err: error }, 'Failed to check VM.Snapshot permission for snapshot create');
        reply.code(502).send({ error: 'pve-unreachable' });
        return;
      }
      if (!allowed) {
        reply.code(403).send({ error: 'forbidden', missing: 'VM.Snapshot' });
        return;
      }

      const description =
        body.data.description !== undefined ? sanitizeDescription(body.data.description) : undefined;

      let upid: string;
      try {
        upid = await callCreateSnapshot(identity.client, params.type, {
          ...params,
          snapname: body.data.snapname,
          ...(description !== undefined ? { description } : {}),
          ...(body.data.vmstate !== undefined ? { vmstate: body.data.vmstate } : {}),
        });
      } catch (error) {
        if (sendPveError(reply, error)) return;
        app.log.warn({ err: error }, 'Snapshot create request failed');
        reply.code(502).send({ error: 'pve-unreachable' });
        return;
      }

      // Never the description -- it may hold anything the caller wrote, same rule as the guest
      // config-update route's own log line.
      app.log.info(
        {
          username: identity.username,
          node: params.node,
          type: params.type,
          vmid: params.vmid,
          snapname: body.data.snapname,
          upid,
        },
        'Snapshot create requested',
      );
      reply.code(202).send({ upid });
    },
  );

  app.delete(
    '/api/actions/guest/:node/:type/:vmid/snapshots/:snapname',
    { onRequest: guestActionsRateLimit },
    async (req, reply) => {
      const params = parseGuestParams(req.params as Record<string, string>);
      const rawParams = req.params as Record<string, string>;
      const snapname = rawParams.snapname;
      if (!params || !snapname) {
        reply.code(400).send({ error: 'Invalid node/type/vmid/snapname' });
        return;
      }
      if (!isValidSnapshotName(snapname)) {
        reply.code(400).send({ error: 'invalid-snapname' });
        return;
      }

      const query = req.query as { force?: string };
      const force = query.force === '1' ? true : undefined;

      const identity = await resolveIdentity(app, req);
      if (!identity) {
        reply.code(401).send({ error: 'Not authenticated' });
        return;
      }
      if (identity.credentials.type === 'token') {
        reply.code(403).send({ error: 'writes-disabled-in-token-mode' });
        return;
      }

      let allowed: boolean;
      try {
        allowed = await hasPrivilege(identity.client, params.vmid, 'VM.Snapshot');
      } catch (error) {
        app.log.warn({ err: error }, 'Failed to check VM.Snapshot permission for snapshot delete');
        reply.code(502).send({ error: 'pve-unreachable' });
        return;
      }
      if (!allowed) {
        reply.code(403).send({ error: 'forbidden', missing: 'VM.Snapshot' });
        return;
      }

      let upid: string;
      try {
        upid = await callDeleteSnapshot(identity.client, params.type, {
          ...params,
          snapname,
          ...(force !== undefined ? { force } : {}),
        });
      } catch (error) {
        if (sendPveError(reply, error)) return;
        app.log.warn({ err: error }, 'Snapshot delete request failed');
        reply.code(502).send({ error: 'pve-unreachable' });
        return;
      }

      app.log.info(
        { username: identity.username, node: params.node, type: params.type, vmid: params.vmid, snapname, upid },
        'Snapshot delete requested',
      );
      reply.code(202).send({ upid });
    },
  );

  app.post(
    '/api/actions/guest/:node/:type/:vmid/snapshots/:snapname/rollback',
    { onRequest: guestActionsRateLimit },
    async (req, reply) => {
      const params = parseGuestParams(req.params as Record<string, string>);
      const rawParams = req.params as Record<string, string>;
      const snapname = rawParams.snapname;
      if (!params || !snapname) {
        reply.code(400).send({ error: 'Invalid node/type/vmid/snapname' });
        return;
      }
      if (!isValidSnapshotName(snapname)) {
        reply.code(400).send({ error: 'invalid-snapname' });
        return;
      }

      const body = rollbackBodySchema.safeParse(req.body ?? {});
      if (!body.success) {
        reply.code(400).send({ error: 'Invalid request body' });
        return;
      }
      if (params.type === 'lxc' && body.data.start !== undefined) {
        reply.code(400).send({ error: 'start is only valid for qemu guests' });
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

      let allowed: boolean;
      try {
        allowed = await hasPrivilege(identity.client, params.vmid, 'VM.Snapshot.Rollback');
      } catch (error) {
        app.log.warn({ err: error }, 'Failed to check VM.Snapshot.Rollback permission for snapshot rollback');
        reply.code(502).send({ error: 'pve-unreachable' });
        return;
      }
      if (!allowed) {
        reply.code(403).send({ error: 'forbidden', missing: 'VM.Snapshot.Rollback' });
        return;
      }

      let upid: string;
      try {
        upid = await callRollbackSnapshot(identity.client, params.type, {
          ...params,
          snapname,
          ...(body.data.start !== undefined ? { start: body.data.start } : {}),
        });
      } catch (error) {
        if (sendPveError(reply, error)) return;
        app.log.warn({ err: error }, 'Snapshot rollback request failed');
        reply.code(502).send({ error: 'pve-unreachable' });
        return;
      }

      app.log.info(
        { username: identity.username, node: params.node, type: params.type, vmid: params.vmid, snapname, upid },
        'Snapshot rollback requested',
      );
      reply.code(202).send({ upid });
    },
  );
}
