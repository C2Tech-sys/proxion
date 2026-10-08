import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { PveApiError, type EndpointsTable, type PveClient } from '@proxion/pve-api';
import { resolveIdentity } from '../pve/identity.js';
import { hasPrivilege, hasStoragePrivilege, formatPveErrorMessage, sanitizeMessage } from './shared.js';

/**
 * Datacenter -> Backup jobs (T66): create, edit, enable/disable, delete and "Run now" for the
 * cluster-wide vzdump schedule (`/cluster/backup`). Four more allow-listed writes this server
 * performs against PVE, registered from `actionsRoutes` (`routes.ts`) so they share its rate
 * limiter, same convention as `registerNetworkRoutes`. The raw `/api/pve/*` proxy stays read-only
 * (the web reads the job list, the included-volumes view, storages, pools and nodes through it);
 * the PVE parameter strings (`vmid=100,102`, `prune-backups=keep-last=3,...`) are composed here
 * from a validated, typed body -- the caller never hands PVE a free-form string.
 *
 * Privilege: create/edit/delete need `Sys.Modify` on `/` (PVE's own rule for the job list). "Run
 * now" starts real backups, so it follows the guest "Backup now" rule instead: `VM.Backup` on each
 * selected guest and `Datastore.AllocateSpace` on the job's storage. See "Guest actions" in
 * README.md.
 */

const BASE = '/api/actions/datacenter/backup-jobs';

/** A PVE job id as this route accepts it in the path. */
const JOB_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
/** A PVE calendar event (`02:00`, `mon..fri 02:00`, `*-*-01 03:00`, `sat 22:30/2`). */
const SCHEDULE_RE = /^[A-Za-z0-9 ,.:*/-]{1,128}$/;
const STORAGE_RE = /^[A-Za-z0-9._-]{1,64}$/;
/** Same shape as `NODE_NAME_RE` in `migrateRoutes.ts` (kept local, same rationale). */
const NODE_NAME_RE = /^[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?$/;
const POOL_RE = /^[A-Za-z0-9._-]{1,64}$/;
/** A bare address -- no display name, no list separators, nothing PVE's mail parser could split. */
const EMAIL_RE = /^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/;

const MAX_COMMENT_LENGTH = 512;
const MAX_MAILTO = 10;
const MAX_VMIDS = 1000;
/** PVE's own vmid range (100-999999999). */
const guestVmidSchema = z.number().int().min(100).max(999999999);

const scheduleSchema = z.string().trim().regex(SCHEDULE_RE);
const storageSchema = z.string().regex(STORAGE_RE);
const modeSchema = z.enum(['snapshot', 'suspend', 'stop']);
const compressSchema = z.enum(['0', 'zstd', 'gzip', 'lzo']);
const nodeSchema = z.string().min(1).max(63).regex(NODE_NAME_RE);
const poolSchema = z.string().regex(POOL_RE);
const mailSchema = z.string().max(254).regex(EMAIL_RE);
const mailnotificationSchema = z.enum(['always', 'failure']);
const notificationModeSchema = z.enum(['auto', 'legacy-sendmail', 'notification-system']);

/** True iff `value` holds any C0 control character or DEL (a single-line field must hold none). */
function hasControlChars(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

const commentSchema = z
  .string()
  .max(MAX_COMMENT_LENGTH)
  .refine((v) => !hasControlChars(v), { message: 'comment must be a single line' });

const selectionSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('all'), exclude: z.array(guestVmidSchema).max(MAX_VMIDS).optional() }).strict(),
  z.object({ kind: z.literal('pool'), pool: poolSchema }).strict(),
  z.object({ kind: z.literal('vmids'), vmids: z.array(guestVmidSchema).min(1).max(MAX_VMIDS) }).strict(),
]);

const keepSchema = z.number().int().min(0).max(365);
const pruneSchema = z
  .object({
    keepAll: z.boolean().optional(),
    keepLast: keepSchema.optional(),
    keepHourly: keepSchema.optional(),
    keepDaily: keepSchema.optional(),
    keepWeekly: keepSchema.optional(),
    keepMonthly: keepSchema.optional(),
    keepYearly: keepSchema.optional(),
  })
  .strict()
  .refine(
    (p) =>
      !p.keepAll ||
      [p.keepLast, p.keepHourly, p.keepDaily, p.keepWeekly, p.keepMonthly, p.keepYearly].every((v) => v === undefined),
    { message: 'keepAll cannot be combined with other keep-* values' },
  );

const bwlimitSchema = z.number().int().min(0).max(1_000_000_000);
const zstdSchema = z.number().int().min(0).max(64);
const ioniceSchema = z.number().int().min(0).max(8);
const waitSchema = z.number().int().min(0).max(10080);

// `.strict()`: an unknown key is a 400, same rationale as every other action body schema. POST
// applies the documented defaults (enabled, snapshot, zstd) so a minimal create is explicit on the
// wire; PUT has no defaults (an absent key is left untouched) and lets the clearable keys be an
// explicit `null` (-> PVE's `delete` list).
const createBodySchema = z
  .object({
    schedule: scheduleSchema,
    storage: storageSchema,
    selection: selectionSchema,
    enabled: z.boolean().default(true),
    mode: modeSchema.default('snapshot'),
    compress: compressSchema.default('zstd'),
    node: nodeSchema.optional(),
    mailto: z.array(mailSchema).max(MAX_MAILTO).optional(),
    mailnotification: mailnotificationSchema.optional(),
    notificationMode: notificationModeSchema.optional(),
    pruneBackups: pruneSchema.optional(),
    comment: commentSchema.optional(),
    repeatMissed: z.boolean().optional(),
    bwlimit: bwlimitSchema.optional(),
    zstd: zstdSchema.optional(),
    ionice: ioniceSchema.optional(),
    lockwait: waitSchema.optional(),
    stopwait: waitSchema.optional(),
    protected: z.boolean().optional(),
  })
  .strict();

const updateBodySchema = z
  .object({
    schedule: scheduleSchema.optional(),
    storage: storageSchema.optional(),
    selection: selectionSchema.optional(),
    enabled: z.boolean().optional(),
    mode: modeSchema.optional(),
    compress: compressSchema.optional(),
    node: nodeSchema.nullish(),
    mailto: z.array(mailSchema).max(MAX_MAILTO).nullish(),
    mailnotification: mailnotificationSchema.nullish(),
    notificationMode: notificationModeSchema.nullish(),
    pruneBackups: pruneSchema.nullish(),
    comment: commentSchema.nullish(),
    repeatMissed: z.boolean().nullish(),
    bwlimit: bwlimitSchema.nullish(),
    zstd: zstdSchema.nullish(),
    ionice: ioniceSchema.nullish(),
    lockwait: waitSchema.nullish(),
    stopwait: waitSchema.nullish(),
    protected: z.boolean().nullish(),
  })
  .strict();

const runBodySchema = z.object({}).strict();

type CreateBody = z.infer<typeof createBodySchema>;
type UpdateBody = z.infer<typeof updateBodySchema>;
type Selection = z.infer<typeof selectionSchema>;
type PruneBody = z.infer<typeof pruneSchema>;

type CreateParams = EndpointsTable['POST /cluster/backup']['params'];
type UpdateParams = EndpointsTable['PUT /cluster/backup/{id}']['params'];
type VzdumpParams = EndpointsTable['POST /nodes/{node}/vzdump']['params'];
type BackupJob = EndpointsTable['GET /cluster/backup/{id}']['returns'];

/** Same `502`/`4xx` mapping every action route uses; `true` iff it sent a reply. */
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

/** Whether the caller's own credentials hold `privilege` on the ACL `path`, via
 * `GET /access/permissions?path=...` (real PVE nests the result under the requested path; falls
 * back to a flat map like `shared.ts`'s `hasPrivilege`). Copied from `notify/routes.ts`'s
 * `hasRootSysModify` and generalised over the path; additive and local to this file. */
async function hasPathPrivilege(client: PveClient, path: string, privilege: string): Promise<boolean> {
  const perms = (await client.get('/access/permissions', { path })) as Record<string, unknown>;
  const scoped = (perms[path] as Record<string, unknown> | undefined) ?? perms;
  return Boolean(scoped[privilege]);
}

/** The `prune-backups` property string: `keep-all=1`, or the non-zero `keep-*` values in PVE's own
 * order (`keep-last=3,keep-daily=7`). `undefined` when nothing would be set (PVE then keeps
 * everything). A `0` is treated as unset -- PVE's keep-* options start at 1. */
export function composePruneBackups(prune: PruneBody): string | undefined {
  if (prune.keepAll) return 'keep-all=1';
  const parts: string[] = [];
  const entries: Array<[string, number | undefined]> = [
    ['keep-last', prune.keepLast],
    ['keep-hourly', prune.keepHourly],
    ['keep-daily', prune.keepDaily],
    ['keep-weekly', prune.keepWeekly],
    ['keep-monthly', prune.keepMonthly],
    ['keep-yearly', prune.keepYearly],
  ];
  for (const [key, value] of entries) {
    if (value !== undefined && value > 0) parts.push(`${key}=${value}`);
  }
  return parts.length > 0 ? parts.join(',') : undefined;
}

/** The PVE selection keys for `selection`, plus the selection keys it must remove from the job
 * (every other one of `all`/`exclude`/`pool`/`vmid` the new kind does not set). */
export function composeSelection(selection: Selection): {
  set: Record<string, string | boolean>;
  remove: string[];
} {
  if (selection.kind === 'all') {
    const exclude = selection.exclude ?? [];
    return {
      set: { all: true, ...(exclude.length > 0 ? { exclude: exclude.join(',') } : {}) },
      remove: exclude.length > 0 ? ['pool', 'vmid'] : ['exclude', 'pool', 'vmid'],
    };
  }
  if (selection.kind === 'pool') {
    return { set: { pool: selection.pool }, remove: ['all', 'exclude', 'vmid'] };
  }
  return { set: { vmid: selection.vmids.join(',') }, remove: ['all', 'exclude', 'pool'] };
}

type PveFields = Record<string, string | number | boolean>;

/** Maps the typed body onto PVE's parameter names. `forUpdate` turns an explicit `null` (and an
 * emptied list/object) into an entry of the returned `remove` list; on create those are simply
 * omitted. Selection is always handled together so switching kind clears the other keys. */
function composeFields(body: CreateBody | UpdateBody, forUpdate: boolean): { fields: PveFields; remove: string[] } {
  const fields: PveFields = {};
  const remove: string[] = [];

  const put = (key: string, value: string | number | boolean | undefined) => {
    if (value !== undefined) fields[key] = value;
  };
  /** `value`: undefined = untouched, null/empty-marker = clear, else set. */
  const putOrClear = (key: string, value: string | number | boolean | null | undefined, empty = false) => {
    if (value === undefined) return;
    if (value === null || empty) {
      if (forUpdate) remove.push(key);
      return;
    }
    fields[key] = value;
  };

  put('schedule', body.schedule);
  put('enabled', body.enabled);
  put('storage', body.storage);
  put('mode', body.mode);
  put('compress', body.compress);

  if (body.selection) {
    const selection = composeSelection(body.selection);
    Object.assign(fields, selection.set);
    if (forUpdate) remove.push(...selection.remove);
  }

  putOrClear('node', body.node);
  putOrClear('mailto', body.mailto === null ? null : body.mailto?.join(','), body.mailto?.length === 0);
  putOrClear('mailnotification', body.mailnotification);
  putOrClear('notification-mode', body.notificationMode);
  if (body.pruneBackups !== undefined) {
    const prune = body.pruneBackups === null ? undefined : composePruneBackups(body.pruneBackups);
    putOrClear('prune-backups', body.pruneBackups === null ? null : (prune ?? ''), prune === undefined);
  }
  putOrClear('comment', body.comment);
  putOrClear('repeat-missed', body.repeatMissed);
  putOrClear('bwlimit', body.bwlimit);
  putOrClear('zstd', body.zstd);
  putOrClear('ionice', body.ionice);
  putOrClear('lockwait', body.lockwait);
  putOrClear('stopwait', body.stopwait);
  putOrClear('protected', body.protected);

  return { fields, remove };
}

/** Job ids in the cluster's current job list. */
async function listJobIds(client: PveClient): Promise<string[]> {
  const jobs = await client.get('/cluster/backup');
  return jobs.map((job) => job.id);
}

/** 401 / token-mode 403 gate shared by every route; returns the identity, or `undefined` after
 * replying. Runs before any PVE call. */
async function authorize(app: FastifyInstance, req: FastifyRequest, reply: FastifyReply) {
  const identity = await resolveIdentity(app, req);
  if (!identity) {
    reply.code(401).send({ error: 'Not authenticated' });
    return undefined;
  }
  if (identity.credentials.type === 'token') {
    reply.code(403).send({ error: 'writes-disabled-in-token-mode' });
    return undefined;
  }
  return identity;
}

/** `Sys.Modify` on `/` gate for create/edit/delete; `true` iff the caller may proceed (otherwise
 * it already replied 403 or 502). */
async function requireSysModify(
  app: FastifyInstance,
  reply: FastifyReply,
  client: PveClient,
  action: string,
): Promise<boolean> {
  let allowed: boolean;
  try {
    allowed = await hasPathPrivilege(client, '/', 'Sys.Modify');
  } catch (error) {
    if (sendPveError(reply, error)) return false;
    app.log.warn({ err: error }, `Failed to check permissions for ${action}`);
    reply.code(502).send({ error: 'pve-unreachable' });
    return false;
  }
  if (!allowed) {
    reply.code(403).send({ error: 'forbidden', missing: 'Sys.Modify' });
    return false;
  }
  return true;
}

function truthy(value: unknown): boolean {
  return value === true || value === 1 || value === '1';
}

/** One row of `GET /cluster/resources` this route reads. */
interface ClusterRow {
  type?: string;
  vmid?: number;
  node?: string;
  status?: string;
  pool?: string;
}

/** `job.vmid` / `job.exclude`: a comma-separated vmid list. */
function parseVmidList(value: string | undefined): number[] {
  if (!value) return [];
  return value
    .split(',')
    .map((v) => Number(v.trim()))
    .filter((v) => Number.isInteger(v) && v > 0);
}

/** `prune-backups` as a property string, whether PVE returned it as one or as a parsed object. */
function pruneToString(value: unknown): string | undefined {
  if (typeof value === 'string') return value.length > 0 ? value : undefined;
  if (!value || typeof value !== 'object') return undefined;
  const obj = value as Record<string, unknown>;
  if (truthy(obj['keep-all'])) return 'keep-all=1';
  const parts: string[] = [];
  for (const key of ['keep-last', 'keep-hourly', 'keep-daily', 'keep-weekly', 'keep-monthly', 'keep-yearly']) {
    const v = obj[key];
    if (typeof v === 'number' && v > 0) parts.push(`${key}=${v}`);
  }
  return parts.length > 0 ? parts.join(',') : undefined;
}

/** The guests (from the cluster list) a job selects, each with the node it runs on. */
function selectedGuests(job: BackupJob, rows: ClusterRow[]): Array<{ vmid: number; node: string }> {
  const guests = rows.filter(
    (r): r is ClusterRow & { vmid: number; node: string } =>
      (r.type === 'qemu' || r.type === 'lxc') && typeof r.vmid === 'number' && typeof r.node === 'string',
  );
  let chosen: typeof guests;
  if (truthy(job.all)) {
    const exclude = new Set(parseVmidList(job.exclude));
    chosen = guests.filter((g) => !exclude.has(g.vmid));
  } else if (job.pool) {
    chosen = guests.filter((g) => g.pool === job.pool);
  } else {
    const wanted = new Set(parseVmidList(job.vmid));
    chosen = guests.filter((g) => wanted.has(g.vmid));
  }
  if (job.node) chosen = chosen.filter((g) => g.node === job.node);
  return chosen.map((g) => ({ vmid: g.vmid, node: g.node }));
}

/** The vzdump parameters a job's "Run now" sends: the job's own settings minus the schedule-only
 * ones (`enabled`, `schedule`, `repeat-missed`, `comment`, `node`, `id`). */
function vzdumpParamsFor(job: BackupJob, node: string): VzdumpParams {
  const params: VzdumpParams = { node };
  if (job.storage) params.storage = job.storage;
  if (job.mode) params.mode = job.mode;
  if (job.compress) params.compress = job.compress;
  if (truthy(job.all)) {
    params.all = true;
    if (job.exclude) params.exclude = job.exclude;
  } else if (job.pool) {
    params.pool = job.pool;
  } else if (job.vmid) {
    params.vmid = job.vmid;
  }
  if (job.mailto) params.mailto = job.mailto;
  if (job.mailnotification) params.mailnotification = job.mailnotification;
  if (job['notification-mode']) params['notification-mode'] = job['notification-mode'];
  const prune = pruneToString(job['prune-backups']);
  if (prune) params['prune-backups'] = prune;
  if (job.bwlimit !== undefined) params.bwlimit = job.bwlimit;
  if (job.zstd !== undefined) params.zstd = job.zstd;
  if (job.ionice !== undefined) params.ionice = job.ionice;
  if (job.lockwait !== undefined) params.lockwait = job.lockwait;
  if (job.stopwait !== undefined) params.stopwait = job.stopwait;
  if (job.protected !== undefined) params.protected = truthy(job.protected);
  return params;
}

export function registerBackupJobRoutes(
  app: FastifyInstance,
  guestActionsRateLimit: ReturnType<FastifyInstance['rateLimit']>,
): void {
  app.post(BASE, { onRequest: guestActionsRateLimit }, async (req, reply) => {
    const identity = await authorize(app, req, reply);
    if (!identity) return;

    const parsed = createBodySchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      reply.code(400).send({ error: 'Invalid request body' });
      return;
    }

    if (!(await requireSysModify(app, reply, identity.client, 'backup job create'))) return;

    const { fields } = composeFields(parsed.data, false);

    let id: string | null;
    try {
      const before = new Set(await listJobIds(identity.client));
      // PVE answers a create with `null` and generates the job id itself, so the new id is found
      // by diffing the job list around the call.
      await identity.client.post('/cluster/backup', fields as CreateParams);
      const created = (await listJobIds(identity.client)).filter((existing) => !before.has(existing));
      id = created.length === 1 ? (created[0] ?? null) : null;
    } catch (error) {
      if (sendPveError(reply, error)) return;
      app.log.warn({ err: error }, 'Backup job create request failed');
      reply.code(502).send({ error: 'pve-unreachable' });
      return;
    }

    app.log.info({ username: identity.username, id, storage: parsed.data.storage }, 'Backup job created');
    reply.code(200).send({ ok: true, id });
  });

  app.put(`${BASE}/:id`, { onRequest: guestActionsRateLimit }, async (req, reply) => {
    const id = (req.params as Record<string, string>).id ?? '';
    if (!JOB_ID_RE.test(id)) {
      reply.code(400).send({ error: 'Invalid job id' });
      return;
    }
    const identity = await authorize(app, req, reply);
    if (!identity) return;

    const parsed = updateBodySchema.safeParse(req.body ?? {});
    if (!parsed.success || Object.keys(parsed.data).length === 0) {
      reply.code(400).send({ error: 'Invalid request body' });
      return;
    }

    if (!(await requireSysModify(app, reply, identity.client, 'backup job update'))) return;

    const { fields, remove } = composeFields(parsed.data, true);

    try {
      if (!(await listJobIds(identity.client)).includes(id)) {
        reply.code(404).send({ error: 'not-found', message: `Backup job ${id} does not exist` });
        return;
      }
      await identity.client.put('/cluster/backup/{id}', {
        id,
        ...fields,
        ...(remove.length > 0 ? { delete: remove.join(',') } : {}),
      } as UpdateParams);
    } catch (error) {
      if (sendPveError(reply, error)) return;
      app.log.warn({ err: error }, 'Backup job update request failed');
      reply.code(502).send({ error: 'pve-unreachable' });
      return;
    }

    app.log.info({ username: identity.username, id, keys: Object.keys(fields), remove }, 'Backup job updated');
    reply.code(200).send({ ok: true, id });
  });

  app.delete(`${BASE}/:id`, { onRequest: guestActionsRateLimit }, async (req, reply) => {
    const id = (req.params as Record<string, string>).id ?? '';
    if (!JOB_ID_RE.test(id)) {
      reply.code(400).send({ error: 'Invalid job id' });
      return;
    }
    const identity = await authorize(app, req, reply);
    if (!identity) return;
    if (!(await requireSysModify(app, reply, identity.client, 'backup job delete'))) return;

    try {
      if (!(await listJobIds(identity.client)).includes(id)) {
        reply.code(404).send({ error: 'not-found', message: `Backup job ${id} does not exist` });
        return;
      }
      await identity.client.delete('/cluster/backup/{id}', { id });
    } catch (error) {
      if (sendPveError(reply, error)) return;
      app.log.warn({ err: error }, 'Backup job delete request failed');
      reply.code(502).send({ error: 'pve-unreachable' });
      return;
    }

    app.log.info({ username: identity.username, id }, 'Backup job deleted');
    reply.code(200).send({ ok: true });
  });

  app.post(`${BASE}/:id/run`, { onRequest: guestActionsRateLimit }, async (req, reply) => {
    const id = (req.params as Record<string, string>).id ?? '';
    if (!JOB_ID_RE.test(id)) {
      reply.code(400).send({ error: 'Invalid job id' });
      return;
    }
    const identity = await authorize(app, req, reply);
    if (!identity) return;
    if (!runBodySchema.safeParse(req.body ?? {}).success) {
      reply.code(400).send({ error: 'Invalid request body' });
      return;
    }
    const client = identity.client;

    let job: BackupJob;
    let rows: ClusterRow[];
    try {
      if (!(await listJobIds(client)).includes(id)) {
        reply.code(404).send({ error: 'not-found', message: `Backup job ${id} does not exist` });
        return;
      }
      job = await client.get('/cluster/backup/{id}', { id });
      rows = (await client.get('/cluster/resources')) as ClusterRow[];
    } catch (error) {
      if (sendPveError(reply, error)) return;
      app.log.warn({ err: error }, 'Failed to read backup job for run-now');
      reply.code(502).send({ error: 'pve-unreachable' });
      return;
    }

    if (!job.storage) {
      reply.code(400).send({ error: 'job-has-no-storage', message: 'The job has no storage to back up to' });
      return;
    }
    if (!truthy(job.all) && !job.pool && !job.vmid) {
      reply.code(400).send({ error: 'job-has-no-selection', message: 'The job does not select any guests' });
      return;
    }

    const guests = selectedGuests(job, rows);
    if (guests.length === 0) {
      reply.code(400).send({ error: 'no-guests', message: 'The job does not currently select any guests' });
      return;
    }

    // A node-restricted job runs on its node; a cluster-wide one on every online node that holds
    // at least one selected guest (each vzdump run only backs up the guests local to its node).
    const onlineNodes = new Set(
      rows.filter((r) => r.type === 'node' && r.status === 'online' && typeof r.node === 'string').map((r) => r.node),
    );
    const targetNodes = [
      ...new Set(guests.filter((g) => job.node !== undefined || onlineNodes.has(g.node)).map((g) => g.node)),
    ];
    const dispatchedGuests = guests.filter((g) => targetNodes.includes(g.node));
    if (targetNodes.length === 0) {
      reply.code(400).send({ error: 'no-online-node', message: 'None of the selected guests are on an online node' });
      return;
    }

    // Same rule as the guest "Backup now": VM.Backup on every guest it will back up and
    // Datastore.AllocateSpace on the target storage.
    try {
      const storageOk = await hasStoragePrivilege(client, job.storage, 'Datastore.AllocateSpace');
      if (!storageOk) {
        reply.code(403).send({ error: 'forbidden', missing: 'Datastore.AllocateSpace' });
        return;
      }
      const vmids = [...new Set(dispatchedGuests.map((g) => g.vmid))];
      for (let i = 0; i < vmids.length; i += 8) {
        const chunk = vmids.slice(i, i + 8);
        const results = await Promise.all(chunk.map((vmid) => hasPrivilege(client, vmid, 'VM.Backup')));
        if (results.some((ok) => !ok)) {
          reply.code(403).send({ error: 'forbidden', missing: 'VM.Backup' });
          return;
        }
      }
    } catch (error) {
      if (sendPveError(reply, error)) return;
      app.log.warn({ err: error }, 'Failed to check permissions for backup job run-now');
      reply.code(502).send({ error: 'pve-unreachable' });
      return;
    }

    const upids: string[] = [];
    for (const node of targetNodes) {
      try {
        upids.push(await client.post('/nodes/{node}/vzdump', vzdumpParamsFor(job, node)));
      } catch (error) {
        if (error instanceof PveApiError) {
          const status = error.status >= 500 ? 502 : error.status;
          reply.code(status).send({
            error: error.status >= 500 ? 'pve-unreachable' : 'pve-rejected',
            ...(error.status >= 500 ? {} : { message: sanitizeMessage(formatPveErrorMessage(error)) }),
            ...(upids.length > 0 ? { upids } : {}),
          });
          return;
        }
        app.log.warn({ err: error }, 'Backup job run-now request failed');
        reply.code(502).send({ error: 'pve-unreachable', ...(upids.length > 0 ? { upids } : {}) });
        return;
      }
    }

    app.log.info(
      { username: identity.username, id, nodes: targetNodes, storage: job.storage, upids },
      'Backup job run requested',
    );
    reply.code(202).send({ upids });
  });
}
