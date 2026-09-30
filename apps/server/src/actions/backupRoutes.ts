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
 * Guest backup (vzdump) start + restore-from-backup -- two more allow-listed writes this server
 * performs against PVE, plus a `GET .../restore/nextid` convenience for the restore dialog's "use
 * next free ID" button, all registered from `actionsRoutes` (`routes.ts`) so they share its rate
 * limiter, same convention as `registerSnapshotRoutes`/`registerMigrateRoutes`/`registerNodeRoutes`.
 * See "Guest actions" in README.md for the full contract (T41).
 */

/** Same shape/rationale as `STORAGE_ID_RE` in `migrateRoutes.ts`/`storageRoutes.ts` (kept local --
 * every route file that forwards a storage id to PVE validates it the same way, rather than share
 * an import just for this one regex). */
const STORAGE_ID_RE = /^[A-Za-z][A-Za-z0-9._-]*$/;
const storageIdSchema = z.string().min(1).max(100).regex(STORAGE_ID_RE);

/** A backup archive's own volid shape: `<storage>:backup/<name>` -- narrower than the generic
 * volid `storageRoutes.ts`'s own `VOLID_RE` accepts, since this route only ever restores a
 * *backup* archive, never an arbitrary volume. `..` is rejected the same defensive way every other
 * PVE-bound identifier in this app is. */
const ARCHIVE_RE = /^[A-Za-z][A-Za-z0-9._-]*:backup\/[A-Za-z0-9][A-Za-z0-9._+-]*$/;
const archiveSchema = z
  .string()
  .max(255)
  .regex(ARCHIVE_RE)
  .refine((value) => !value.includes('..'), { message: 'archive must not contain ".."' });

/** PVE's own vmid range (100-999999999). */
const targetVmidSchema = z.number().int().min(100).max(999999999);

/** PVE's max length for a `notes-template` -- not PVE-enforced as tightly as `description`, but
 * capped here so a caller can't send an unbounded string into a backup job's notes field. */
const MAX_NOTES_LENGTH = 512;

// `.strict()`: an unknown key is a 400, same rationale as every other guest-action body schema in
// this app (see `shared.ts`'s doc comment). `compress`/`prune` both default rather than requiring
// the caller to always spell them out, matching the web dialog's own defaults (zstd, no prune).
const backupBodySchema = z
  .object({
    storage: storageIdSchema,
    mode: z.enum(['snapshot', 'suspend', 'stop']),
    compress: z.enum(['zstd', 'gzip', 'lzo', '0']).default('zstd'),
    protected: z.boolean().optional(),
    notes: z.string().max(MAX_NOTES_LENGTH).optional(),
    prune: z.boolean().default(false),
  })
  .strict();

// `.strict()`, same rationale. `targetVmid` is optional here -- absent, it defaults to the guest's
// own `:vmid` (an in-place restore) once `:vmid` is known, which this object alone doesn't have
// access to; `unique` (qemu-only) and `unprivileged` (lxc-only) aren't cross-validated here for the
// same reason `withLocalDisks`/`restart` aren't in `migrateRoutes.ts`'s own body schema -- the
// route handler rejects the wrong one for the guest's type once `type` is known.
const restoreBodySchema = z
  .object({
    archive: archiveSchema,
    targetVmid: targetVmidSchema.optional(),
    storage: storageIdSchema.optional(),
    start: z.boolean().optional(),
    force: z.boolean().optional(),
    unique: z.boolean().optional(),
    unprivileged: z.boolean().optional(),
  })
  .strict();

interface GuestRouteParams {
  node: string;
  type: 'qemu' | 'lxc';
  vmid: number;
}

/** Parses/validates the common `:node/:type/:vmid` triple, same helper shape
 * `migrateRoutes.ts`'s/`snapshotRoutes.ts`'s own `parseGuestParams` (kept local, same rationale as
 * theirs). */
function parseGuestParams(rawParams: Record<string, string>): GuestRouteParams | undefined {
  const node = rawParams.node;
  const type = guestTypeSchema.safeParse(rawParams.type);
  const vmid = vmidSchema.safeParse(rawParams.vmid);
  if (!node || !type.success || !vmid.success) return undefined;
  return { node, type: type.data, vmid: vmid.data };
}

/** Maps a PVE call failure to the same `502`/`4xx` response shape every guest-action route uses
 * (mirrors `storageRoutes.ts`'s own `sendPveError`, including running PVE's per-field `errors` map
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

/**
 * Dispatches the backup start to PVE (`POST /nodes/{node}/vzdump`). `vmid` travels as a string --
 * that's the shape the generated endpoint table gives this field (vzdump's own `vmid` accepts a
 * comma-separated list or `all`; a single guest's backup is just a one-element case of that same
 * string). `remove` is PVE's own "prune old backups after this one" flag: sent as `false` (wire
 * value `0`) when the caller left pruning off (the default), and omitted entirely when the caller
 * asked for it, so PVE falls back to the storage's own configured retention instead of this route
 * hard-coding a policy.
 */
async function callVzdump(
  client: PveClient,
  {
    node,
    vmid,
    storage,
    mode,
    compress,
    isProtected,
    notes,
    prune,
  }: {
    node: string;
    vmid: number;
    storage: string;
    mode: 'snapshot' | 'suspend' | 'stop';
    compress: 'zstd' | 'gzip' | 'lzo' | '0';
    isProtected: boolean | undefined;
    notes: string | undefined;
    prune: boolean;
  },
): Promise<string> {
  return client.post('/nodes/{node}/vzdump', {
    node,
    vmid: String(vmid),
    storage,
    mode,
    compress,
    ...(isProtected !== undefined ? { protected: isProtected } : {}),
    ...(notes !== undefined ? { 'notes-template': notes } : {}),
    ...(prune ? {} : { remove: false }),
  });
}

/**
 * Dispatches the restore to PVE via one explicit, generated-endpoint-checked `client.post()` call
 * per guest type -- same rationale as `migrateRoutes.ts`'s own `callMigrate`. qemu's create/restore
 * endpoint takes `archive` directly; lxc has no `archive` field at all -- a restore is spelled as
 * `ostemplate: <the backup volid>` plus `restore: true` (see the generated endpoint table).
 */
async function callRestore(
  client: PveClient,
  type: 'qemu' | 'lxc',
  {
    node,
    targetVmid,
    archive,
    storage,
    start,
    force,
    unique,
    unprivileged,
  }: {
    node: string;
    targetVmid: number;
    archive: string;
    storage: string | undefined;
    start: boolean | undefined;
    force: boolean | undefined;
    unique: boolean | undefined;
    unprivileged: boolean | undefined;
  },
): Promise<string> {
  if (type === 'qemu') {
    return client.post('/nodes/{node}/qemu', {
      node,
      vmid: targetVmid,
      archive,
      ...(force !== undefined ? { force } : {}),
      ...(unique !== undefined ? { unique } : {}),
      ...(start !== undefined ? { start } : {}),
      ...(storage !== undefined ? { storage } : {}),
    });
  }
  return client.post('/nodes/{node}/lxc', {
    node,
    vmid: targetVmid,
    ostemplate: archive,
    restore: true,
    ...(force !== undefined ? { force } : {}),
    ...(unprivileged !== undefined ? { unprivileged } : {}),
    ...(start !== undefined ? { start } : {}),
    ...(storage !== undefined ? { storage } : {}),
  });
}

/** One cluster resource row this route cares about, from `GET /cluster/resources?type=vm` --
 * just enough to tell whether `targetVmid` already exists and, if so, whether it's running. */
interface ClusterVmResource {
  vmid?: number;
  status?: string;
}

/** Looks up `targetVmid` among the cluster's current guests (any type -- PVE itself would refuse a
 * qemu restore over an existing lxc id or vice versa, so this route doesn't need to duplicate that
 * check). Returns `undefined` when no guest has that id. */
async function findExistingGuest(client: PveClient, targetVmid: number): Promise<ClusterVmResource | undefined> {
  const resources = (await client.get('/cluster/resources', { type: 'vm' })) as ClusterVmResource[];
  return resources.find((r) => r.vmid === targetVmid);
}

/** The restore route's own privilege check: overwriting an existing guest needs `VM.Backup` *or*
 * `VM.Allocate` on it (PVE grants either its own backup operators or full allocators the right to
 * restore over their guest); claiming a brand-new id needs `VM.Allocate`. Returns the privilege
 * name(s) to report as `missing` on a 403, or `undefined` when access is allowed. */
async function checkRestoreVmPrivilege(
  client: PveClient,
  targetVmid: number,
  overwriting: boolean,
): Promise<string | undefined> {
  if (overwriting) {
    const [hasBackup, hasAllocate] = await Promise.all([
      hasPrivilege(client, targetVmid, 'VM.Backup'),
      hasPrivilege(client, targetVmid, 'VM.Allocate'),
    ]);
    return hasBackup || hasAllocate ? undefined : 'VM.Backup or VM.Allocate';
  }
  const hasAllocate = await hasPrivilege(client, targetVmid, 'VM.Allocate');
  return hasAllocate ? undefined : 'VM.Allocate';
}

export function registerBackupRoutes(
  app: FastifyInstance,
  guestActionsRateLimit: ReturnType<FastifyInstance['rateLimit']>,
): void {
  app.post(
    '/api/actions/guest/:node/:type/:vmid/backup',
    { onRequest: guestActionsRateLimit },
    async (req, reply) => {
      const params = parseGuestParams(req.params as Record<string, string>);
      if (!params) {
        reply.code(400).send({ error: 'Invalid node/type/vmid' });
        return;
      }

      const body = backupBodySchema.safeParse(req.body ?? {});
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

      let hasBackupPriv: boolean;
      let hasAllocateSpace: boolean;
      try {
        [hasBackupPriv, hasAllocateSpace] = await Promise.all([
          hasPrivilege(identity.client, params.vmid, 'VM.Backup'),
          hasStoragePrivilege(identity.client, body.data.storage, 'Datastore.AllocateSpace'),
        ]);
      } catch (error) {
        app.log.warn({ err: error }, 'Failed to check permissions for guest backup');
        reply.code(502).send({ error: 'pve-unreachable' });
        return;
      }
      if (!hasBackupPriv) {
        reply.code(403).send({ error: 'forbidden', missing: 'VM.Backup' });
        return;
      }
      if (!hasAllocateSpace) {
        reply.code(403).send({ error: 'forbidden', missing: 'Datastore.AllocateSpace' });
        return;
      }

      const notes = body.data.notes !== undefined ? sanitizeDescription(body.data.notes) : undefined;

      let upid: string;
      try {
        upid = await callVzdump(identity.client, {
          node: params.node,
          vmid: params.vmid,
          storage: body.data.storage,
          mode: body.data.mode,
          compress: body.data.compress,
          isProtected: body.data.protected,
          notes,
          prune: body.data.prune,
        });
      } catch (error) {
        if (sendPveError(reply, error)) return;
        app.log.warn({ err: error }, 'Guest backup request failed');
        reply.code(502).send({ error: 'pve-unreachable' });
        return;
      }

      app.log.info(
        {
          username: identity.username,
          node: params.node,
          type: params.type,
          vmid: params.vmid,
          storage: body.data.storage,
          mode: body.data.mode,
          upid,
        },
        'Guest backup requested',
      );
      reply.code(202).send({ upid });
    },
  );

  app.post(
    '/api/actions/guest/:node/:type/:vmid/restore',
    { onRequest: guestActionsRateLimit },
    async (req, reply) => {
      const params = parseGuestParams(req.params as Record<string, string>);
      if (!params) {
        reply.code(400).send({ error: 'Invalid node/type/vmid' });
        return;
      }

      const body = restoreBodySchema.safeParse(req.body ?? {});
      if (!body.success) {
        reply.code(400).send({ error: 'Invalid request body' });
        return;
      }
      if (params.type === 'lxc' && body.data.unique !== undefined) {
        reply.code(400).send({ error: 'unique is only valid for qemu guests' });
        return;
      }
      if (params.type === 'qemu' && body.data.unprivileged !== undefined) {
        reply.code(400).send({ error: 'unprivileged is only valid for lxc guests' });
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

      const targetVmid = body.data.targetVmid ?? params.vmid;

      let existing: ClusterVmResource | undefined;
      try {
        existing = await findExistingGuest(identity.client, targetVmid);
      } catch (error) {
        app.log.warn({ err: error }, 'Failed to look up target vmid for guest restore');
        reply.code(502).send({ error: 'pve-unreachable' });
        return;
      }

      const overwriting = existing !== undefined;
      if (overwriting) {
        if (!body.data.force) {
          reply.code(400).send({ error: 'target-exists' });
          return;
        }
        if (existing?.status === 'running') {
          reply.code(400).send({ error: 'target-running', message: 'Stop the guest before restoring over it' });
          return;
        }
      }

      let missingVmPriv: string | undefined;
      let hasAllocateSpace: boolean;
      try {
        [missingVmPriv, hasAllocateSpace] = await Promise.all([
          checkRestoreVmPrivilege(identity.client, targetVmid, overwriting),
          body.data.storage !== undefined
            ? hasStoragePrivilege(identity.client, body.data.storage, 'Datastore.AllocateSpace')
            : Promise.resolve(true),
        ]);
      } catch (error) {
        app.log.warn({ err: error }, 'Failed to check permissions for guest restore');
        reply.code(502).send({ error: 'pve-unreachable' });
        return;
      }
      if (missingVmPriv) {
        reply.code(403).send({ error: 'forbidden', missing: missingVmPriv });
        return;
      }
      if (!hasAllocateSpace) {
        reply.code(403).send({ error: 'forbidden', missing: 'Datastore.AllocateSpace' });
        return;
      }

      let upid: string;
      try {
        upid = await callRestore(identity.client, params.type, {
          node: params.node,
          targetVmid,
          archive: body.data.archive,
          storage: body.data.storage,
          start: body.data.start,
          force: body.data.force,
          unique: body.data.unique,
          unprivileged: body.data.unprivileged,
        });
      } catch (error) {
        if (sendPveError(reply, error)) return;
        app.log.warn({ err: error }, 'Guest restore request failed');
        reply.code(502).send({ error: 'pve-unreachable' });
        return;
      }

      app.log.info(
        {
          username: identity.username,
          node: params.node,
          type: params.type,
          vmid: params.vmid,
          targetVmid,
          archive: body.data.archive,
          upid,
        },
        'Guest restore requested',
      );
      reply.code(202).send({ upid });
    },
  );

  app.get(
    '/api/actions/guest/:node/:type/:vmid/restore/nextid',
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
