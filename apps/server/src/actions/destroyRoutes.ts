import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import { PveApiError, type PveClient } from '@proxion/pve-api';
import { resolveIdentity } from '../pve/identity.js';
import {
  guestTypeSchema,
  vmidSchema,
  hasPrivilege,
  formatPveErrorMessage,
  sanitizeMessage,
} from './shared.js';

/**
 * Guest delete/destroy (qemu/lxc) -- one more allow-listed write this server performs against PVE,
 * registered from `actionsRoutes` (`routes.ts`) so it shares its rate limiter, same convention as
 * `registerCloneRoutes`/`registerBackupRoutes` (T47).
 *
 * `DELETE /api/actions/guest/:node/:type/:vmid` with a strict JSON *body* (not query params):
 * `{ purge?: boolean (default false), destroyUnreferencedDisks?: boolean (default true) }`. The
 * browser's `fetch` sends a body on DELETE without trouble and Fastify parses one, so the flags
 * travel in the body like every other guest-action route's options do.
 */

// `.strict()`: an unknown key is a 400, same rationale as every other guest-action body schema in
// this app -- in particular PVE's own `skiplock`/`force` flags are deliberately not exposed.
// `destroyUnreferencedDisks` defaults to `true` (PVE's own UI defaults its "Destroy unreferenced
// disks" checkbox on, although the raw API default is off); `purge` defaults to `false`.
const destroyBodySchema = z
  .object({
    purge: z.boolean().default(false),
    destroyUnreferencedDisks: z.boolean().default(true),
  })
  .strict();

interface GuestRouteParams {
  node: string;
  type: 'qemu' | 'lxc';
  vmid: number;
}

/** Parses/validates the common `:node/:type/:vmid` triple, same helper shape as
 * `cloneRoutes.ts`'s own `parseGuestParams` (kept local, same rationale as theirs). */
function parseGuestParams(rawParams: Record<string, string>): GuestRouteParams | undefined {
  const node = rawParams.node;
  const type = guestTypeSchema.safeParse(rawParams.type);
  const vmid = vmidSchema.safeParse(rawParams.vmid);
  if (!node || !type.success || !vmid.success) return undefined;
  return { node, type: type.data, vmid: vmid.data };
}

/** Maps a PVE call failure to the same `502`/`4xx` response shape every guest-action route uses
 * (mirrors `cloneRoutes.ts`'s own `sendPveError`); returns `true` iff it sent a reply. */
function sendPveError(reply: FastifyReply, error: unknown): boolean {
  if (error instanceof PveApiError) {
    if (error.status >= 500) {
      reply.code(502).send({ error: 'pve-unreachable' });
    } else {
      reply.code(error.status).send({ error: 'pve-rejected', message: sanitizeMessage(formatPveErrorMessage(error)) });
    }
    return true;
  }
  return false;
}

/** One cluster resource row this route cares about, from `GET /cluster/resources`. */
interface ClusterResourceRow {
  type?: string;
  vmid?: number;
  node?: string;
  status?: string;
}

/**
 * Dispatches the destroy to PVE via one explicit, generated-endpoint-checked `client.delete()` call
 * per guest type -- same rationale as `cloneRoutes.ts`'s own `callClone`. Both flags are always
 * forwarded explicitly (booleans become PVE's `0`/`1`), so this route never relies on PVE's own
 * defaults. `skiplock` (qemu) / `force` (lxc) are intentionally never sent.
 */
async function callDestroy(
  client: PveClient,
  type: 'qemu' | 'lxc',
  {
    node,
    vmid,
    purge,
    destroyUnreferencedDisks,
  }: { node: string; vmid: number; purge: boolean; destroyUnreferencedDisks: boolean },
): Promise<string> {
  if (type === 'qemu') {
    return client.delete('/nodes/{node}/qemu/{vmid}', {
      node,
      vmid,
      purge,
      'destroy-unreferenced-disks': destroyUnreferencedDisks,
    });
  }
  return client.delete('/nodes/{node}/lxc/{vmid}', {
    node,
    vmid,
    purge,
    'destroy-unreferenced-disks': destroyUnreferencedDisks,
  });
}

export function registerDestroyRoutes(
  app: FastifyInstance,
  guestActionsRateLimit: ReturnType<FastifyInstance['rateLimit']>,
): void {
  app.delete(
    '/api/actions/guest/:node/:type/:vmid',
    { onRequest: guestActionsRateLimit },
    async (req, reply) => {
      const params = parseGuestParams(req.params as Record<string, string>);
      if (!params) {
        reply.code(400).send({ error: 'Invalid node/type/vmid' });
        return;
      }

      const body = destroyBodySchema.safeParse(req.body ?? {});
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

      // The guest's own row, read with the caller's own credentials (never the shared token), so
      // an existence/running answer never reveals more than the caller could already see.
      let guest: ClusterResourceRow | undefined;
      try {
        const resources = (await identity.client.get('/cluster/resources', {})) as ClusterResourceRow[];
        guest = resources.find((r) => r.type === params.type && r.vmid === params.vmid);
      } catch (error) {
        app.log.warn({ err: error }, 'Failed to look up cluster state for guest delete');
        reply.code(502).send({ error: 'pve-unreachable' });
        return;
      }
      if (!guest) {
        reply.code(404).send({ error: 'not-found' });
        return;
      }
      // PVE itself refuses to destroy a guest that isn't stopped -- a paused qemu guest still has
      // a live process, so only a non-running, non-paused guest passes here. Templates are always
      // stopped and may be deleted.
      if (guest.status === 'running' || guest.status === 'paused') {
        reply.code(400).send({ error: 'guest-running', message: 'Stop the guest before deleting it' });
        return;
      }

      let hasAllocate: boolean;
      try {
        hasAllocate = await hasPrivilege(identity.client, params.vmid, 'VM.Allocate');
      } catch (error) {
        app.log.warn({ err: error }, 'Failed to check permissions for guest delete');
        reply.code(502).send({ error: 'pve-unreachable' });
        return;
      }
      if (!hasAllocate) {
        reply.code(403).send({ error: 'forbidden', missing: 'VM.Allocate' });
        return;
      }

      let upid: string;
      try {
        upid = await callDestroy(identity.client, params.type, {
          node: params.node,
          vmid: params.vmid,
          purge: body.data.purge,
          destroyUnreferencedDisks: body.data.destroyUnreferencedDisks,
        });
      } catch (error) {
        if (sendPveError(reply, error)) return;
        app.log.warn({ err: error }, 'Guest delete request failed');
        reply.code(502).send({ error: 'pve-unreachable' });
        return;
      }

      app.log.info(
        {
          username: identity.username,
          node: params.node,
          type: params.type,
          vmid: params.vmid,
          purge: body.data.purge,
          destroyUnreferencedDisks: body.data.destroyUnreferencedDisks,
          upid,
        },
        'Guest delete requested',
      );
      reply.code(202).send({ upid });
    },
  );
}
