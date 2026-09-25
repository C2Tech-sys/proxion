import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import { PveApiError, type PveClient } from '@proxion/pve-api';
import { resolveIdentity } from '../pve/identity.js';
import { guestTypeSchema, vmidSchema, hasPrivilege, sanitizeMessage } from './shared.js';

/**
 * A PVE node name: `[A-Za-z0-9]`, optionally with inner `-` (never leading/trailing), 1-63
 * characters -- the same shape `:node` path segments already are in practice, but validated here
 * because `target` is a body or query value this route forwards straight into a PVE API call
 * rather than a routed path segment fastify itself constrains.
 */
const NODE_NAME_RE = /^[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?$/;
const targetNodeSchema = z.string().min(1).max(63).regex(NODE_NAME_RE);

/** PVE storage id: a letter, then letters/digits/`.`/`_`/`-`, up to 100 characters. Only ever
 * forwarded to PVE (as `targetstorage`/`target-storage`) -- never used to build a request path. */
const STORAGE_ID_RE = /^[A-Za-z][A-Za-z0-9._-]*$/;
const storageIdSchema = z.string().min(1).max(100).regex(STORAGE_ID_RE);

// `.strict()`: an unknown key is a 400, same rationale as every other guest-action body schema
// in this app (see `routes.ts`/`snapshotRoutes.ts`). `restart` (lxc-only) and `withLocalDisks`
// (qemu-only) aren't cross-validated here -- that depends on the guest `type` path param, which
// this schema doesn't have access to; the route handler rejects the wrong one for the guest's
// type once `type` is known.
const migrateBodySchema = z
  .object({
    target: targetNodeSchema,
    online: z.boolean().optional(),
    withLocalDisks: z.boolean().optional(),
    restart: z.boolean().optional(),
    bwlimit: z.number().int().positive().optional(),
    targetStorage: storageIdSchema.optional(),
  })
  .strict();

interface MigrateRouteParams {
  node: string;
  type: 'qemu' | 'lxc';
  vmid: number;
}

/** Parses/validates the common `:node/:type/:vmid` triple, same helper shape
 * `snapshotRoutes.ts`'s `parseGuestParams` uses (kept local -- it's a two-line function and the
 * two files would otherwise need a shared import just for this). */
function parseGuestParams(rawParams: Record<string, string>): MigrateRouteParams | undefined {
  const node = rawParams.node;
  const type = guestTypeSchema.safeParse(rawParams.type);
  const vmid = vmidSchema.safeParse(rawParams.vmid);
  if (!node || !type.success || !vmid.success) return undefined;
  return { node, type: type.data, vmid: vmid.data };
}

/**
 * Dispatches the migrate start to PVE via one explicit, generated-endpoint-checked
 * `client.post()` call per guest type -- same rationale as `callAction` in `routes.ts`. qemu's
 * endpoint accepts `online`/`with-local-disks`/`targetstorage`; lxc's accepts `online`/`restart`/
 * `target-storage` (different field name than qemu's own storage param).
 */
async function callMigrate(
  client: PveClient,
  type: 'qemu' | 'lxc',
  {
    node,
    vmid,
    target,
    online,
    withLocalDisks,
    restart,
    bwlimit,
    targetStorage,
  }: MigrateRouteParams & {
    target: string;
    online?: boolean | undefined;
    withLocalDisks?: boolean | undefined;
    restart?: boolean | undefined;
    bwlimit?: number | undefined;
    targetStorage?: string | undefined;
  },
): Promise<string> {
  if (type === 'qemu') {
    return client.post('/nodes/{node}/qemu/{vmid}/migrate', {
      node,
      vmid,
      target,
      ...(online !== undefined ? { online } : {}),
      ...(withLocalDisks !== undefined ? { 'with-local-disks': withLocalDisks } : {}),
      ...(bwlimit !== undefined ? { bwlimit } : {}),
      ...(targetStorage !== undefined ? { targetstorage: targetStorage } : {}),
    });
  }
  return client.post('/nodes/{node}/lxc/{vmid}/migrate', {
    node,
    vmid,
    target,
    ...(online !== undefined ? { online } : {}),
    ...(restart !== undefined ? { restart } : {}),
    ...(bwlimit !== undefined ? { bwlimit } : {}),
    ...(targetStorage !== undefined ? { 'target-storage': targetStorage } : {}),
  });
}

/** The migrate precheck, normalised to one shape for both guest types (see README's "Guest
 * actions" section). lxc's endpoint reports less than qemu's -- `localDisks`/`localResources`
 * are always empty for lxc, since PVE's lxc migrate precheck doesn't report either. */
export interface MigratePrecheckResult {
  running: boolean;
  allowedNodes: string[];
  notAllowedNodes: Record<string, { unavailableStorages: string[]; blockingHaResources: string[] }>;
  localDisks: Array<{ volid: string; size: number; cdrom: boolean; isUnused: boolean }>;
  localResources: string[];
}

/** The raw shape PVE's own migrate-precheck endpoints report `not_allowed_nodes`/
 * `not-allowed-nodes` in: a map keyed by node name, each value naming why that node doesn't
 * qualify. Declared locally (rather than trusted from `@proxion/pve-api`'s generated types,
 * which -- for this one field -- describe a single flat object instead of the per-node map PVE's
 * own API docs and real responses use) since normalisation below needs the per-node keys to
 * build `notAllowedNodes`. */
interface RawNotAllowedNodes {
  [node: string]: { unavailable_storages?: string[]; 'blocking-ha-resources'?: Array<{ sid: string }> };
}

function normalizeNotAllowedNodes(raw: unknown): MigratePrecheckResult['notAllowedNodes'] {
  if (!raw || typeof raw !== 'object') return {};
  const result: MigratePrecheckResult['notAllowedNodes'] = {};
  for (const [node, reasons] of Object.entries(raw as RawNotAllowedNodes)) {
    result[node] = {
      unavailableStorages: reasons?.unavailable_storages ?? [],
      blockingHaResources: (reasons?.['blocking-ha-resources'] ?? []).map((r) => r.sid),
    };
  }
  return result;
}

interface RawQemuMigratePrecheck {
  allowed_nodes?: string[];
  not_allowed_nodes?: unknown;
  local_disks?: Array<{ volid: string; size: number; cdrom: boolean; is_unused: boolean }>;
  local_resources?: string[];
  running: boolean;
}

interface RawLxcMigratePrecheck {
  'allowed-nodes'?: string[];
  'not-allowed-nodes'?: unknown;
  running: boolean;
}

function normalizeQemuPrecheck(raw: RawQemuMigratePrecheck): MigratePrecheckResult {
  return {
    running: raw.running,
    allowedNodes: raw.allowed_nodes ?? [],
    notAllowedNodes: normalizeNotAllowedNodes(raw.not_allowed_nodes),
    localDisks: (raw.local_disks ?? []).map((d) => ({
      volid: d.volid,
      size: d.size,
      cdrom: d.cdrom,
      isUnused: d.is_unused,
    })),
    localResources: raw.local_resources ?? [],
  };
}

function normalizeLxcPrecheck(raw: RawLxcMigratePrecheck): MigratePrecheckResult {
  return {
    running: raw.running,
    allowedNodes: raw['allowed-nodes'] ?? [],
    notAllowedNodes: normalizeNotAllowedNodes(raw['not-allowed-nodes']),
    localDisks: [],
    localResources: [],
  };
}

async function callMigratePrecheck(
  client: PveClient,
  type: 'qemu' | 'lxc',
  { node, vmid, target }: MigrateRouteParams & { target: string },
): Promise<MigratePrecheckResult> {
  if (type === 'qemu') {
    const raw = (await client.get('/nodes/{node}/qemu/{vmid}/migrate', {
      node,
      vmid,
      target,
    })) as unknown as RawQemuMigratePrecheck;
    return normalizeQemuPrecheck(raw);
  }
  const raw = (await client.get('/nodes/{node}/lxc/{vmid}/migrate', {
    node,
    vmid,
    target,
  })) as unknown as RawLxcMigratePrecheck;
  return normalizeLxcPrecheck(raw);
}

/** Maps a PVE call failure to the same `502`/`4xx` response shape every guest-action route uses
 * (mirrors `snapshotRoutes.ts`'s own `sendPveError`); returns `true` iff it sent a reply. */
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
 * Guest migrate (start + precheck) -- one more allow-listed write this server performs against
 * PVE, registered from `actionsRoutes` (`routes.ts`) so it shares its rate limiter, same
 * convention as `registerSnapshotRoutes`. See "Guest actions" in README.md for the full contract.
 */
export function registerMigrateRoutes(
  app: FastifyInstance,
  guestActionsRateLimit: ReturnType<FastifyInstance['rateLimit']>,
): void {
  app.post(
    '/api/actions/guest/:node/:type/:vmid/migrate',
    { onRequest: guestActionsRateLimit },
    async (req, reply) => {
      const params = parseGuestParams(req.params as Record<string, string>);
      if (!params) {
        reply.code(400).send({ error: 'Invalid node/type/vmid' });
        return;
      }

      const body = migrateBodySchema.safeParse(req.body ?? {});
      if (!body.success) {
        reply.code(400).send({ error: 'Invalid request body' });
        return;
      }

      if (body.data.target === params.node) {
        reply.code(400).send({ error: 'target must differ from the guest\'s current node' });
        return;
      }
      if (params.type === 'lxc' && body.data.withLocalDisks !== undefined) {
        reply.code(400).send({ error: 'withLocalDisks is only valid for qemu guests' });
        return;
      }
      if (params.type === 'qemu' && body.data.restart !== undefined) {
        reply.code(400).send({ error: 'restart is only valid for lxc guests' });
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
        allowed = await hasPrivilege(identity.client, params.vmid, 'VM.Migrate');
      } catch (error) {
        app.log.warn({ err: error }, 'Failed to check VM.Migrate permission for guest migrate');
        reply.code(502).send({ error: 'pve-unreachable' });
        return;
      }
      if (!allowed) {
        reply.code(403).send({ error: 'forbidden', missing: 'VM.Migrate' });
        return;
      }

      let upid: string;
      try {
        upid = await callMigrate(identity.client, params.type, { ...params, ...body.data });
      } catch (error) {
        if (sendPveError(reply, error)) return;
        app.log.warn({ err: error }, 'Guest migrate request failed');
        reply.code(502).send({ error: 'pve-unreachable' });
        return;
      }

      app.log.info(
        {
          username: identity.username,
          node: params.node,
          type: params.type,
          vmid: params.vmid,
          target: body.data.target,
          upid,
        },
        'Guest migrate requested',
      );
      reply.code(202).send({ upid });
    },
  );

  app.get(
    '/api/actions/guest/:node/:type/:vmid/migrate/precheck',
    { onRequest: guestActionsRateLimit },
    async (req, reply) => {
      const params = parseGuestParams(req.params as Record<string, string>);
      if (!params) {
        reply.code(400).send({ error: 'Invalid node/type/vmid' });
        return;
      }

      const query = req.query as { target?: string };
      const target = targetNodeSchema.safeParse(query.target);
      if (!target.success) {
        reply.code(400).send({ error: 'Invalid or missing target' });
        return;
      }
      if (target.data === params.node) {
        reply.code(400).send({ error: 'target must differ from the guest\'s current node' });
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
        allowed = await hasPrivilege(identity.client, params.vmid, 'VM.Migrate');
      } catch (error) {
        app.log.warn({ err: error }, 'Failed to check VM.Migrate permission for migrate precheck');
        reply.code(502).send({ error: 'pve-unreachable' });
        return;
      }
      if (!allowed) {
        reply.code(403).send({ error: 'forbidden', missing: 'VM.Migrate' });
        return;
      }

      let precheck: MigratePrecheckResult;
      try {
        precheck = await callMigratePrecheck(identity.client, params.type, { ...params, target: target.data });
      } catch (error) {
        if (sendPveError(reply, error)) return;
        app.log.warn({ err: error }, 'Migrate precheck request failed');
        reply.code(502).send({ error: 'pve-unreachable' });
        return;
      }

      reply.code(200).send(precheck);
    },
  );
}
