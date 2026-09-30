import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import { PveApiError, type PveClient } from '@proxion/pve-api';
import { resolveIdentity } from '../pve/identity.js';
import {
  guestTypeSchema,
  vmidSchema,
  hasPrivilege,
  hasStoragePrivilege,
  sanitizeDescription,
  formatPveErrorMessage,
  sanitizeMessage,
} from './shared.js';

/**
 * Guest clone (qemu/lxc) -- one more allow-listed write this server performs against PVE, plus a
 * `GET .../clone/nextid` convenience for the dialog's "Use next free ID" button, registered from
 * `actionsRoutes` (`routes.ts`) so it shares its rate limiter, same convention as
 * `registerMigrateRoutes`/`registerBackupRoutes`. See "Guest actions" in README.md for the full
 * contract (T42).
 */

/** Same shape/rationale as `NODE_NAME_RE` in `migrateRoutes.ts` -- `target` here is a body value
 * forwarded straight into a PVE API call, never a routed path segment. */
const NODE_NAME_RE = /^[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?$/;
const targetNodeSchema = z.string().min(1).max(63).regex(NODE_NAME_RE);

/** Same shape/rationale as `STORAGE_ID_RE` in `migrateRoutes.ts`/`backupRoutes.ts` (kept local --
 * every route file that forwards a storage id to PVE validates it the same way). */
const STORAGE_ID_RE = /^[A-Za-z][A-Za-z0-9._-]*$/;
const storageIdSchema = z.string().min(1).max(100).regex(STORAGE_ID_RE);

/** PVE's own vmid range (100-999999999), same as `targetVmidSchema` in `backupRoutes.ts`. */
const newIdSchema = z.number().int().min(100).max(999999999);

/** One label of a dns-name: `[A-Za-z0-9]`, optionally with inner `-` (never leading/trailing),
 * 1-63 characters -- same shape as `DNS_LABEL_RE` in `routes.ts`/`lib/guestName.ts`. The clone
 * dialog's own name field is capped at 253 (qemu's own `name` limit) regardless of guest type,
 * unlike the rename route's per-type cap -- see this ticket's own contract. */
const NAME_RE = /^[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*$/;
const MAX_NAME_LENGTH = 253;
const nameSchema = z.string().max(MAX_NAME_LENGTH).regex(NAME_RE);

/** A snapshot name, same shape PVE itself requires (`snapshotRoutes.ts`'s own `SNAPNAME_RE`, kept
 * local here for the same reason every other per-file regex in this app is). */
const SNAPNAME_RE = /^[A-Za-z][A-Za-z0-9_-]{0,39}$/;
const snapnameSchema = z.string().regex(SNAPNAME_RE);

/** Sanitised the same way a guest's config `description` is (`sanitizeDescription`), capped here
 * before sanitising -- sanitising only ever removes characters, so this remains a safe bound. */
const MAX_DESCRIPTION_LENGTH = 512;

// `.strict()`: an unknown key is a 400, same rationale as every other guest-action body schema in
// this app. `full` defaults to `true` (a full clone) rather than requiring the caller to always
// spell it out; `full: false` (a linked clone) is only accepted from a template source -- checked
// in the route handler once the source guest's own `template` flag is known.
const cloneBodySchema = z
  .object({
    newid: newIdSchema,
    name: nameSchema.optional(),
    full: z.boolean().default(true),
    target: targetNodeSchema.optional(),
    storage: storageIdSchema.optional(),
    snapname: snapnameSchema.optional(),
    description: z.string().max(MAX_DESCRIPTION_LENGTH).optional(),
    bwlimit: z.number().int().positive().optional(),
  })
  .strict();

interface GuestRouteParams {
  node: string;
  type: 'qemu' | 'lxc';
  vmid: number;
}

/** Parses/validates the common `:node/:type/:vmid` triple, same helper shape
 * `backupRoutes.ts`'s/`migrateRoutes.ts`'s own `parseGuestParams` (kept local, same rationale as
 * theirs). */
function parseGuestParams(rawParams: Record<string, string>): GuestRouteParams | undefined {
  const node = rawParams.node;
  const type = guestTypeSchema.safeParse(rawParams.type);
  const vmid = vmidSchema.safeParse(rawParams.vmid);
  if (!node || !type.success || !vmid.success) return undefined;
  return { node, type: type.data, vmid: vmid.data };
}

/** Maps a PVE call failure to the same `502`/`4xx` response shape every guest-action route uses
 * (mirrors `backupRoutes.ts`'s own `sendPveError`, including running PVE's per-field `errors` map
 * into the message via `formatPveErrorMessage` before sanitising); returns `true` iff it sent a
 * reply. */
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

/** One cluster resource row this route cares about, from `GET /cluster/resources` (no `type`
 * filter -- a single fetch covers the source guest's own row, whether `newid` already exists, and
 * whether a given `target` names a real cluster node, rather than three separate round trips). */
interface ClusterResourceRow {
  type?: string;
  vmid?: number;
  node?: string;
  template?: boolean | 0 | 1;
}

interface CloneClusterState {
  /** The source guest's own row, or `undefined` if it isn't in the cluster's resource list for
   * some reason (defensive -- the route was still reached via its own `:vmid`). */
  source: ClusterResourceRow | undefined;
  /** Whether `newid` already names an existing guest (any type) in the cluster. */
  targetExists: boolean;
  /** Whether `target` (when given) names a real node in the cluster. */
  targetNodeValid: (target: string) => boolean;
}

async function loadCloneClusterState(
  client: PveClient,
  vmid: number,
  newid: number,
): Promise<CloneClusterState> {
  const resources = (await client.get('/cluster/resources', {})) as ClusterResourceRow[];
  const source = resources.find((r) => (r.type === 'qemu' || r.type === 'lxc') && r.vmid === vmid);
  const targetExists = resources.some((r) => (r.type === 'qemu' || r.type === 'lxc') && r.vmid === newid);
  const nodeNames = new Set(resources.filter((r) => r.type === 'node').map((r) => r.node));
  return { source, targetExists, targetNodeValid: (target) => nodeNames.has(target) };
}

function isTemplate(row: ClusterResourceRow | undefined): boolean {
  return row?.template === 1 || row?.template === true;
}

/**
 * Dispatches the clone to PVE via one explicit, generated-endpoint-checked `client.post()` call
 * per guest type -- same rationale as `migrateRoutes.ts`'s own `callMigrate`. qemu's clone field
 * for the new guest's display name is `name`; lxc has no `name` config key, so the same rename
 * goes out as `hostname` instead (see `packages/pve-api/src/generated/endpoints.ts`). `full` is
 * always forwarded explicitly (both `true` and `false`): PVE's own default depends on whether the
 * source is a template, so this route never relies on it.
 */
async function callClone(
  client: PveClient,
  type: 'qemu' | 'lxc',
  {
    node,
    vmid,
    newid,
    name,
    full,
    target,
    storage,
    snapname,
    description,
    bwlimit,
  }: {
    node: string;
    vmid: number;
    newid: number;
    name: string | undefined;
    full: boolean;
    target: string | undefined;
    storage: string | undefined;
    snapname: string | undefined;
    description: string | undefined;
    bwlimit: number | undefined;
  },
): Promise<string> {
  if (type === 'qemu') {
    return client.post('/nodes/{node}/qemu/{vmid}/clone', {
      node,
      vmid,
      newid,
      full,
      ...(name !== undefined ? { name } : {}),
      ...(target !== undefined ? { target } : {}),
      ...(storage !== undefined ? { storage } : {}),
      ...(snapname !== undefined ? { snapname } : {}),
      ...(description !== undefined ? { description } : {}),
      ...(bwlimit !== undefined ? { bwlimit } : {}),
    });
  }
  return client.post('/nodes/{node}/lxc/{vmid}/clone', {
    node,
    vmid,
    newid,
    full,
    ...(name !== undefined ? { hostname: name } : {}),
    ...(target !== undefined ? { target } : {}),
    ...(storage !== undefined ? { storage } : {}),
    ...(snapname !== undefined ? { snapname } : {}),
    ...(description !== undefined ? { description } : {}),
    ...(bwlimit !== undefined ? { bwlimit } : {}),
  });
}

export function registerCloneRoutes(
  app: FastifyInstance,
  guestActionsRateLimit: ReturnType<FastifyInstance['rateLimit']>,
): void {
  app.post(
    '/api/actions/guest/:node/:type/:vmid/clone',
    { onRequest: guestActionsRateLimit },
    async (req, reply) => {
      const params = parseGuestParams(req.params as Record<string, string>);
      if (!params) {
        reply.code(400).send({ error: 'Invalid node/type/vmid' });
        return;
      }

      const body = cloneBodySchema.safeParse(req.body ?? {});
      if (!body.success) {
        reply.code(400).send({ error: 'Invalid request body' });
        return;
      }

      if (body.data.newid === params.vmid) {
        reply.code(400).send({ error: 'same-id' });
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

      let cluster: CloneClusterState;
      try {
        cluster = await loadCloneClusterState(identity.client, params.vmid, body.data.newid);
      } catch (error) {
        app.log.warn({ err: error }, 'Failed to look up cluster state for guest clone');
        reply.code(502).send({ error: 'pve-unreachable' });
        return;
      }

      if (cluster.targetExists) {
        reply.code(400).send({ error: 'target-exists' });
        return;
      }
      if (!body.data.full && !isTemplate(cluster.source)) {
        reply.code(400).send({
          error: 'linked-requires-template',
          message: 'A linked clone is only possible from a template.',
        });
        return;
      }
      if (body.data.target !== undefined && !cluster.targetNodeValid(body.data.target)) {
        reply.code(400).send({ error: 'unknown-target' });
        return;
      }

      let hasClone: boolean;
      let hasAllocate: boolean;
      try {
        [hasClone, hasAllocate] = await Promise.all([
          hasPrivilege(identity.client, params.vmid, 'VM.Clone'),
          hasPrivilege(identity.client, body.data.newid, 'VM.Allocate'),
        ]);
      } catch (error) {
        app.log.warn({ err: error }, 'Failed to check permissions for guest clone');
        reply.code(502).send({ error: 'pve-unreachable' });
        return;
      }
      if (!hasClone) {
        reply.code(403).send({ error: 'forbidden', missing: 'VM.Clone' });
        return;
      }
      if (!hasAllocate) {
        reply.code(403).send({ error: 'forbidden', missing: 'VM.Allocate' });
        return;
      }

      if (body.data.storage !== undefined) {
        let hasAllocateSpace: boolean;
        try {
          hasAllocateSpace = await hasStoragePrivilege(identity.client, body.data.storage, 'Datastore.AllocateSpace');
        } catch (error) {
          app.log.warn({ err: error }, 'Failed to check storage permission for guest clone');
          reply.code(502).send({ error: 'pve-unreachable' });
          return;
        }
        if (!hasAllocateSpace) {
          reply.code(403).send({ error: 'forbidden', missing: 'Datastore.AllocateSpace' });
          return;
        }
      }

      const description =
        body.data.description !== undefined ? sanitizeDescription(body.data.description) : undefined;

      let upid: string;
      try {
        upid = await callClone(identity.client, params.type, {
          node: params.node,
          vmid: params.vmid,
          newid: body.data.newid,
          name: body.data.name,
          full: body.data.full,
          target: body.data.target,
          storage: body.data.storage,
          snapname: body.data.snapname,
          description,
          bwlimit: body.data.bwlimit,
        });
      } catch (error) {
        if (sendPveError(reply, error)) return;
        app.log.warn({ err: error }, 'Guest clone request failed');
        reply.code(502).send({ error: 'pve-unreachable' });
        return;
      }

      app.log.info(
        {
          username: identity.username,
          node: params.node,
          type: params.type,
          vmid: params.vmid,
          newid: body.data.newid,
          target: body.data.target ?? params.node,
          full: body.data.full,
          upid,
        },
        'Guest clone requested',
      );
      reply.code(202).send({ upid });
    },
  );

  app.get(
    '/api/actions/guest/:node/:type/:vmid/clone/nextid',
    { onRequest: guestActionsRateLimit },
    async (req, reply) => {
      const params = parseGuestParams(req.params as Record<string, string>);
      if (!params) {
        reply.code(400).send({ error: 'Invalid node/type/vmid' });
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

      let vmid: number;
      try {
        vmid = await identity.client.get('/cluster/nextid');
      } catch (error) {
        if (sendPveError(reply, error)) return;
        app.log.warn({ err: error }, 'nextid request failed');
        reply.code(502).send({ error: 'pve-unreachable' });
        return;
      }

      reply.code(200).send({ vmid });
    },
  );
}
