import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import { PveApiError } from '@proxion/pve-api';
import { resolveIdentity } from '../pve/identity.js';
import {
  guestTypeSchema,
  vmidSchema,
  hasPrivilege,
  formatPveErrorMessage,
  sanitizeMessage,
} from './shared.js';

/**
 * Convert a guest to a template (T63) -- one more allow-listed write this server performs against
 * PVE, registered from `actionsRoutes` (`routes.ts`) so it shares its rate limiter, same
 * convention as `registerDestroyRoutes`.
 *
 * `POST /api/actions/guest/:node/:type/:vmid/template` takes no options (an empty strict JSON
 * body, or none at all). The conversion is irreversible, so the browser asks for a typed-VMID
 * confirmation first; this route is the server-side half and enforces the preconditions itself:
 * the guest must exist, must not already be a template, and must be stopped.
 *
 * PVE answers the qemu endpoint with a task UPID (`202 { upid }`) and the lxc endpoint with a null
 * result (`200 { ok: true }`).
 */

const templateBodySchema = z.object({}).strict();

interface GuestRouteParams {
  node: string;
  type: 'qemu' | 'lxc';
  vmid: number;
}

function parseGuestParams(rawParams: Record<string, string>): GuestRouteParams | undefined {
  const node = rawParams.node;
  const type = guestTypeSchema.safeParse(rawParams.type);
  const vmid = vmidSchema.safeParse(rawParams.vmid);
  if (!node || !type.success || !vmid.success) return undefined;
  return { node, type: type.data, vmid: vmid.data };
}

/** Maps a PVE call failure to the same `502`/`4xx` response shape every guest-action route uses;
 * returns `true` iff it sent a reply. */
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
  template?: number | boolean;
}

export function registerTemplateRoutes(
  app: FastifyInstance,
  guestActionsRateLimit: ReturnType<FastifyInstance['rateLimit']>,
): void {
  app.post(
    '/api/actions/guest/:node/:type/:vmid/template',
    { onRequest: guestActionsRateLimit },
    async (req, reply) => {
      const params = parseGuestParams(req.params as Record<string, string>);
      if (!params) {
        reply.code(400).send({ error: 'Invalid node/type/vmid' });
        return;
      }

      const body = templateBodySchema.safeParse(req.body ?? {});
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
        app.log.warn({ err: error }, 'Failed to look up cluster state for convert-to-template');
        reply.code(502).send({ error: 'pve-unreachable' });
        return;
      }
      if (!guest) {
        reply.code(404).send({ error: 'not-found' });
        return;
      }
      if (guest.template === 1 || guest.template === true) {
        reply.code(400).send({ error: 'already-template', message: 'This guest is already a template' });
        return;
      }
      // PVE itself refuses to convert a guest that isn't stopped -- a paused qemu guest still has
      // a live process, so only a non-running, non-paused guest passes here.
      if (guest.status === 'running' || guest.status === 'paused') {
        reply.code(400).send({ error: 'guest-running', message: 'Stop the guest before converting it to a template' });
        return;
      }

      let hasAllocate: boolean;
      try {
        hasAllocate = await hasPrivilege(identity.client, params.vmid, 'VM.Allocate');
      } catch (error) {
        app.log.warn({ err: error }, 'Failed to check permissions for convert-to-template');
        reply.code(502).send({ error: 'pve-unreachable' });
        return;
      }
      if (!hasAllocate) {
        reply.code(403).send({ error: 'forbidden', missing: 'VM.Allocate' });
        return;
      }

      // One explicit, generated-endpoint-checked call per guest type, same rationale as
      // `destroyRoutes.ts`'s `callDestroy`.
      let result: unknown;
      try {
        result =
          params.type === 'qemu'
            ? await identity.client.post('/nodes/{node}/qemu/{vmid}/template', {
                node: params.node,
                vmid: params.vmid,
              })
            : await identity.client.post('/nodes/{node}/lxc/{vmid}/template', {
                node: params.node,
                vmid: params.vmid,
              });
      } catch (error) {
        if (sendPveError(reply, error)) return;
        app.log.warn({ err: error }, 'Convert-to-template request failed');
        reply.code(502).send({ error: 'pve-unreachable' });
        return;
      }

      const upid = typeof result === 'string' && result.length > 0 ? result : undefined;
      app.log.info(
        { username: identity.username, node: params.node, type: params.type, vmid: params.vmid, upid },
        'Guest convert-to-template requested',
      );
      if (upid) {
        reply.code(202).send({ upid });
        return;
      }
      reply.code(200).send({ ok: true });
    },
  );
}
