import { USE_FIXTURES, api } from '@/api/client';
import { GuestActionError } from '@/api/actions';
import {
  FIXTURE_BACKUP_STORAGES,
  FIXTURE_POOLS,
  FIXTURE_POOL_MEMBERS,
  addFixtureBackupJob,
  fixtureBackupJobs,
  getFixtureBackupJobVolumes,
  removeFixtureBackupJob,
  replaceFixtureBackupJob,
} from '@/api/fixtures';

/**
 * Datacenter -> Backup jobs (T66): the web side of `POST/PUT/DELETE
 * /api/actions/datacenter/backup-jobs[/:id]` and `POST .../:id/run`
 * (`apps/server/src/actions/backupJobRoutes.ts`), plus the reads the tab needs through the
 * read-only `/api/pve/*` proxy (the job list, a job's included volumes, the backup-capable storages
 * and the pools). PVE's property strings are parsed here into one plain `BackupJob` model.
 * Fixture mode is handled inline in each function (same convention as `network.ts`).
 */

export type BackupMode = 'snapshot' | 'suspend' | 'stop';
export type BackupCompress = '0' | 'zstd' | 'gzip' | 'lzo';
export type BackupMailWhen = 'always' | 'failure';
export type BackupNotificationMode = 'auto' | 'legacy-sendmail' | 'notification-system';

/** Which guests a job covers. */
export type BackupSelection =
  | { kind: 'all'; exclude: number[] }
  | { kind: 'pool'; pool: string }
  | { kind: 'vmids'; vmids: number[] };

/** The `prune-backups` policy; nothing set means PVE keeps every backup. */
export interface BackupRetention {
  keepAll: boolean;
  keepLast?: number | undefined;
  keepHourly?: number | undefined;
  keepDaily?: number | undefined;
  keepWeekly?: number | undefined;
  keepMonthly?: number | undefined;
  keepYearly?: number | undefined;
}

/** One vzdump job from `GET /cluster/backup`, normalised. */
export interface BackupJob {
  id: string;
  enabled: boolean;
  schedule: string;
  storage: string;
  mode: BackupMode;
  /** PVE's legacy `1` (= gzip) is kept as the raw string. */
  compress: string;
  /** `null` when the job selects nothing (PVE normally refuses that). */
  selection: BackupSelection | null;
  node?: string | undefined;
  mailto: string[];
  mailnotification?: BackupMailWhen | undefined;
  notificationMode?: BackupNotificationMode | undefined;
  retention: BackupRetention;
  comment?: string | undefined;
  /** Unix seconds of the next scheduled run; absent for a disabled job. */
  nextRun?: number | undefined;
  repeatMissed: boolean;
  bwlimit?: number | undefined;
  zstd?: number | undefined;
  ionice?: number | undefined;
  lockwait?: number | undefined;
  stopwait?: number | undefined;
  protected: boolean;
}

/** The selection as the server's body schema takes it (`exclude` is optional on `all`). */
export type BackupSelectionBody =
  | { kind: 'all'; exclude?: number[] }
  | { kind: 'pool'; pool: string }
  | { kind: 'vmids'; vmids: number[] };

/** Retention fields as the server's `pruneBackups` body object. */
export interface PruneBody {
  keepAll?: boolean;
  keepLast?: number;
  keepHourly?: number;
  keepDaily?: number;
  keepWeekly?: number;
  keepMonthly?: number;
  keepYearly?: number;
}

/** Body for `createBackupJob` -- matches the server route's strict create schema. */
export interface BackupJobCreateBody {
  schedule: string;
  storage: string;
  selection: BackupSelectionBody;
  enabled?: boolean;
  mode?: BackupMode;
  compress?: BackupCompress;
  node?: string;
  mailto?: string[];
  mailnotification?: BackupMailWhen;
  notificationMode?: BackupNotificationMode;
  pruneBackups?: PruneBody;
  comment?: string;
  repeatMissed?: boolean;
  bwlimit?: number;
  zstd?: number;
  ionice?: number;
  lockwait?: number;
  stopwait?: number;
  protected?: boolean;
}

/** Body for `updateBackupJob`: only the keys to change; an explicit `null` clears an optional key. */
export interface BackupJobUpdateBody {
  schedule?: string;
  storage?: string;
  selection?: BackupSelectionBody;
  enabled?: boolean;
  mode?: BackupMode;
  compress?: BackupCompress;
  node?: string | null;
  mailto?: string[] | null;
  mailnotification?: BackupMailWhen | null;
  notificationMode?: BackupNotificationMode | null;
  pruneBackups?: PruneBody | null;
  comment?: string | null;
  repeatMissed?: boolean | null;
  bwlimit?: number | null;
  zstd?: number | null;
  ionice?: number | null;
  lockwait?: number | null;
  stopwait?: number | null;
  protected?: boolean | null;
}

/** One volume of a guest the job covers, from `GET /cluster/backup/{id}/included_volumes`. */
export interface IncludedVolume {
  id: string;
  name: string;
  included: boolean;
  reason: string;
}

export interface IncludedGuest {
  vmid: number;
  name?: string | undefined;
  type: string;
  volumes: IncludedVolume[];
}

export interface BackupStorage {
  id: string;
  type?: string | undefined;
}

// --- pure helpers -------------------------------------------------------------------------------

function isTruthyFlag(value: unknown): boolean {
  return value === true || value === 1 || value === '1';
}

function intOrUndefined(value: unknown): number | undefined {
  const n = typeof value === 'string' ? Number(value) : value;
  return typeof n === 'number' && Number.isInteger(n) ? n : undefined;
}

function parseVmidList(value: unknown): number[] {
  if (typeof value !== 'string') return [];
  return value
    .split(',')
    .map((v) => Number(v.trim()))
    .filter((v) => Number.isInteger(v) && v > 0);
}

/** `prune-backups` as PVE returns it: a parsed object (current) or the property string. */
export function parseRetention(value: unknown): BackupRetention {
  const keys: Array<[string, keyof BackupRetention]> = [
    ['keep-last', 'keepLast'],
    ['keep-hourly', 'keepHourly'],
    ['keep-daily', 'keepDaily'],
    ['keep-weekly', 'keepWeekly'],
    ['keep-monthly', 'keepMonthly'],
    ['keep-yearly', 'keepYearly'],
  ];
  let record: Record<string, unknown> = {};
  if (typeof value === 'string') {
    for (const part of value.split(',')) {
      const eq = part.indexOf('=');
      if (eq > 0) record[part.slice(0, eq).trim()] = part.slice(eq + 1).trim();
    }
  } else if (value && typeof value === 'object') {
    record = value as Record<string, unknown>;
  }
  const out: BackupRetention = { keepAll: isTruthyFlag(record['keep-all']) };
  for (const [wire, field] of keys) {
    const n = intOrUndefined(record[wire]);
    if (n !== undefined && n > 0) (out as unknown as Record<string, unknown>)[field] = n;
  }
  return out;
}

/** Reads the `GET /cluster/backup` list into the normalised model; rows without an id are dropped. */
export function parseBackupJobs(data: unknown): BackupJob[] {
  if (!Array.isArray(data)) return [];
  const out: BackupJob[] = [];
  for (const row of data as Array<Record<string, unknown>>) {
    if (row === null || typeof row !== 'object' || typeof row.id !== 'string') continue;
    let selection: BackupSelection | null = null;
    if (isTruthyFlag(row.all)) selection = { kind: 'all', exclude: parseVmidList(row.exclude) };
    else if (typeof row.pool === 'string' && row.pool !== '') selection = { kind: 'pool', pool: row.pool };
    else if (typeof row.vmid === 'string' && row.vmid !== '') selection = { kind: 'vmids', vmids: parseVmidList(row.vmid) };
    const str = (v: unknown): string | undefined => (typeof v === 'string' && v !== '' ? v : undefined);
    out.push({
      id: row.id,
      enabled: row.enabled === undefined ? true : isTruthyFlag(row.enabled),
      schedule: str(row.schedule) ?? '',
      storage: str(row.storage) ?? '',
      mode: (str(row.mode) as BackupMode | undefined) ?? 'snapshot',
      compress: str(row.compress) ?? (typeof row.compress === 'number' ? String(row.compress) : '0'),
      selection,
      node: str(row.node),
      mailto: typeof row.mailto === 'string' ? row.mailto.split(/[\s,;]+/).filter(Boolean) : [],
      mailnotification: str(row.mailnotification) as BackupMailWhen | undefined,
      notificationMode: str(row['notification-mode']) as BackupNotificationMode | undefined,
      retention: parseRetention(row['prune-backups']),
      comment: str(row.comment),
      nextRun: typeof row['next-run'] === 'number' ? row['next-run'] : undefined,
      repeatMissed: isTruthyFlag(row['repeat-missed']),
      bwlimit: intOrUndefined(row.bwlimit),
      zstd: intOrUndefined(row.zstd),
      ionice: intOrUndefined(row.ionice),
      lockwait: intOrUndefined(row.lockwait),
      stopwait: intOrUndefined(row.stopwait),
      protected: isTruthyFlag(row.protected),
    });
  }
  return out;
}

/** Reads `GET /cluster/backup/{id}/included_volumes` (`{ children: [guest -> volumes] }`). */
export function parseIncludedVolumes(data: unknown): IncludedGuest[] {
  const children = (data as { children?: unknown } | null | undefined)?.children;
  if (!Array.isArray(children)) return [];
  const out: IncludedGuest[] = [];
  for (const guest of children as Array<Record<string, unknown>>) {
    const vmid = intOrUndefined(guest?.id);
    if (vmid === undefined) continue;
    const volumes: IncludedVolume[] = [];
    if (Array.isArray(guest.children)) {
      for (const vol of guest.children as Array<Record<string, unknown>>) {
        if (typeof vol?.id !== 'string') continue;
        volumes.push({
          id: vol.id,
          name: typeof vol.name === 'string' ? vol.name : vol.id,
          included: isTruthyFlag(vol.included),
          reason: typeof vol.reason === 'string' ? vol.reason : '',
        });
      }
    }
    out.push({
      vmid,
      name: typeof guest.name === 'string' ? guest.name : undefined,
      type: typeof guest.type === 'string' ? guest.type : 'unknown',
      volumes,
    });
  }
  return out.sort((a, b) => a.vmid - b.vmid);
}

/** "All guests", "All guests (except 2)", "Pool prod", "3 guests". */
export function summarizeSelection(selection: BackupSelection | null): string {
  if (selection === null) return 'No guests selected';
  if (selection.kind === 'all') {
    return selection.exclude.length > 0 ? `All guests (except ${selection.exclude.length})` : 'All guests';
  }
  if (selection.kind === 'pool') return `Pool ${selection.pool}`;
  return `${selection.vmids.length} ${selection.vmids.length === 1 ? 'guest' : 'guests'}`;
}

/** "Keep all", "Keep last 3, daily 7"; nothing set reads as PVE's default ("Keep all"). */
export function summarizeRetention(retention: BackupRetention): string {
  if (retention.keepAll) return 'Keep all';
  const parts: string[] = [];
  const entries: Array<[string, number | undefined]> = [
    ['last', retention.keepLast],
    ['hourly', retention.keepHourly],
    ['daily', retention.keepDaily],
    ['weekly', retention.keepWeekly],
    ['monthly', retention.keepMonthly],
    ['yearly', retention.keepYearly],
  ];
  for (const [label, value] of entries) {
    if (value !== undefined && value > 0) parts.push(`${label} ${value}`);
  }
  return parts.length > 0 ? `Keep ${parts.join(', ')}` : 'Keep all';
}

/** Retention fields in the server's body shape; `undefined` when nothing is set. */
export function retentionToBody(retention: BackupRetention): PruneBody | undefined {
  if (retention.keepAll) return { keepAll: true };
  const body: PruneBody = {};
  if (retention.keepLast) body.keepLast = retention.keepLast;
  if (retention.keepHourly) body.keepHourly = retention.keepHourly;
  if (retention.keepDaily) body.keepDaily = retention.keepDaily;
  if (retention.keepWeekly) body.keepWeekly = retention.keepWeekly;
  if (retention.keepMonthly) body.keepMonthly = retention.keepMonthly;
  if (retention.keepYearly) body.keepYearly = retention.keepYearly;
  return Object.keys(body).length > 0 ? body : undefined;
}

function retentionFromBody(body: PruneBody): BackupRetention {
  return {
    keepAll: body.keepAll === true,
    ...(body.keepLast ? { keepLast: body.keepLast } : {}),
    ...(body.keepHourly ? { keepHourly: body.keepHourly } : {}),
    ...(body.keepDaily ? { keepDaily: body.keepDaily } : {}),
    ...(body.keepWeekly ? { keepWeekly: body.keepWeekly } : {}),
    ...(body.keepMonthly ? { keepMonthly: body.keepMonthly } : {}),
    ...(body.keepYearly ? { keepYearly: body.keepYearly } : {}),
  };
}

// --- errors --------------------------------------------------------------------------------------

interface BackupJobErrorBody {
  error?: string;
  message?: string;
  missing?: string;
}

/** Same short, human-readable mapping `network.ts` uses (its copy is module-private). */
function describeError(status: number, statusText: string, body: BackupJobErrorBody | undefined): string {
  if (body?.message) return body.message;
  switch (body?.error) {
    case 'writes-disabled-in-token-mode':
      return 'Read-only: signed in with a service token';
    case 'forbidden':
      return body.missing ? `You don't have ${body.missing}` : "You don't have permission for this";
    case 'not-found':
      return 'That backup job no longer exists';
    case 'pve-unreachable':
      return 'Proxmox VE is unreachable';
    default:
      return body?.error ?? `Request failed: ${status} ${statusText}`;
  }
}

async function throwActionError(res: Response): Promise<never> {
  let errorBody: BackupJobErrorBody | undefined;
  try {
    errorBody = (await res.json()) as BackupJobErrorBody;
  } catch {
    errorBody = undefined;
  }
  throw new GuestActionError(res.status, describeError(res.status, res.statusText, errorBody));
}

// --- reads ---------------------------------------------------------------------------------------

async function getPve(path: string, what: string): Promise<unknown> {
  const res = await fetch(`/api/pve/${path}`);
  if (!res.ok) throw new Error(`Failed to load ${what}: ${res.status}`);
  const envelope = (await res.json()) as { data?: unknown };
  return envelope.data;
}

/** The cluster's vzdump jobs: `GET /cluster/backup` through the read-only proxy. */
export async function getBackupJobs(): Promise<BackupJob[]> {
  if (USE_FIXTURES) return structuredClone(fixtureBackupJobs);
  return parseBackupJobs(await getPve('cluster/backup', 'the backup jobs'));
}

/** The guests (and volumes) a job covers: `GET /cluster/backup/{id}/included_volumes`. */
export async function getIncludedVolumes(id: string): Promise<IncludedGuest[]> {
  if (USE_FIXTURES) return parseIncludedVolumes(getFixtureBackupJobVolumes(id));
  return parseIncludedVolumes(
    await getPve(`cluster/backup/${encodeURIComponent(id)}/included_volumes`, `the guests of ${id}`),
  );
}

/** The storages that can hold backups (`content` includes `backup`): `GET /storage`. */
export async function getBackupStorages(): Promise<BackupStorage[]> {
  if (USE_FIXTURES) return FIXTURE_BACKUP_STORAGES;
  const data = await getPve('storage', 'the storages');
  if (!Array.isArray(data)) return [];
  const out: BackupStorage[] = [];
  for (const row of data as Array<Record<string, unknown>>) {
    if (typeof row?.storage !== 'string') continue;
    const content = typeof row.content === 'string' ? row.content.split(',') : [];
    if (!content.includes('backup')) continue;
    out.push({ id: row.storage, type: typeof row.type === 'string' ? row.type : undefined });
  }
  return out.sort((a, b) => a.id.localeCompare(b.id));
}

/** The resource pools: `GET /pools`. */
export async function getPools(): Promise<string[]> {
  if (USE_FIXTURES) return FIXTURE_POOLS;
  const data = await getPve('pools', 'the pools');
  if (!Array.isArray(data)) return [];
  return (data as Array<{ poolid?: unknown }>)
    .map((p) => p.poolid)
    .filter((p): p is string => typeof p === 'string')
    .sort((a, b) => a.localeCompare(b));
}

// --- fixture (demo) mode -------------------------------------------------------------------------

const SCHEDULE_RE = /^[A-Za-z0-9 ,.:*/-]{1,128}$/;

function fixtureJob(id: string): BackupJob {
  const job = fixtureBackupJobs.find((j) => j.id === id);
  if (!job) throw new GuestActionError(404, 'That backup job no longer exists');
  return job;
}

function selectionFromBody(selection: BackupSelectionBody): BackupSelection {
  if (selection.kind === 'all') return { kind: 'all', exclude: [...(selection.exclude ?? [])] };
  return selection.kind === 'pool' ? { kind: 'pool', pool: selection.pool } : { kind: 'vmids', vmids: [...selection.vmids] };
}

function fixtureCreate(body: BackupJobCreateBody): { ok: true; id: string | null } {
  if (!SCHEDULE_RE.test(body.schedule)) throw new GuestActionError(400, 'Invalid request body');
  const job = addFixtureBackupJob({
    enabled: body.enabled ?? true,
    schedule: body.schedule,
    storage: body.storage,
    mode: body.mode ?? 'snapshot',
    compress: body.compress ?? 'zstd',
    selection: selectionFromBody(body.selection),
    node: body.node,
    mailto: body.mailto ?? [],
    mailnotification: body.mailnotification,
    notificationMode: body.notificationMode,
    retention: body.pruneBackups ? retentionFromBody(body.pruneBackups) : { keepAll: false },
    comment: body.comment,
    nextRun: (body.enabled ?? true) ? Math.floor(Date.now() / 1000) + 3600 : undefined,
    repeatMissed: body.repeatMissed ?? false,
    bwlimit: body.bwlimit,
    zstd: body.zstd,
    ionice: body.ionice,
    lockwait: body.lockwait,
    stopwait: body.stopwait,
    protected: body.protected ?? false,
  });
  return { ok: true, id: job.id };
}

function fixtureUpdate(id: string, body: BackupJobUpdateBody): { ok: true; id: string } {
  const job = { ...fixtureJob(id) };
  if (Object.keys(body).length === 0) throw new GuestActionError(400, 'Invalid request body');
  if (body.schedule !== undefined) {
    if (!SCHEDULE_RE.test(body.schedule)) throw new GuestActionError(400, 'Invalid request body');
    job.schedule = body.schedule;
  }
  if (body.storage !== undefined) job.storage = body.storage;
  if (body.selection !== undefined) job.selection = selectionFromBody(body.selection);
  if (body.enabled !== undefined) {
    job.enabled = body.enabled;
    job.nextRun = body.enabled ? Math.floor(Date.now() / 1000) + 3600 : undefined;
  }
  if (body.mode !== undefined) job.mode = body.mode;
  if (body.compress !== undefined) job.compress = body.compress;
  if (body.node !== undefined) job.node = body.node ?? undefined;
  if (body.mailto !== undefined) job.mailto = body.mailto ?? [];
  if (body.mailnotification !== undefined) job.mailnotification = body.mailnotification ?? undefined;
  if (body.notificationMode !== undefined) job.notificationMode = body.notificationMode ?? undefined;
  if (body.pruneBackups !== undefined) {
    job.retention = body.pruneBackups ? retentionFromBody(body.pruneBackups) : { keepAll: false };
  }
  if (body.comment !== undefined) job.comment = body.comment ?? undefined;
  if (body.repeatMissed !== undefined) job.repeatMissed = body.repeatMissed === true;
  if (body.bwlimit !== undefined) job.bwlimit = body.bwlimit ?? undefined;
  if (body.zstd !== undefined) job.zstd = body.zstd ?? undefined;
  if (body.ionice !== undefined) job.ionice = body.ionice ?? undefined;
  if (body.lockwait !== undefined) job.lockwait = body.lockwait ?? undefined;
  if (body.stopwait !== undefined) job.stopwait = body.stopwait ?? undefined;
  if (body.protected !== undefined) job.protected = body.protected === true;
  replaceFixtureBackupJob(job);
  return { ok: true, id };
}

/** Demo "Run now": one task per node that holds a guest the job selects. */
async function fixtureRun(id: string): Promise<{ upids: string[] }> {
  const job = fixtureJob(id);
  const resources = await api.getClusterResources();
  const guests = resources.filter((r) => (r.type === 'qemu' || r.type === 'lxc') && r.vmid !== undefined);
  const selection = job.selection;
  const chosen = guests.filter((g) => {
    if (selection === null) return false;
    if (selection.kind === 'all') return !selection.exclude.includes(g.vmid as number);
    if (selection.kind === 'vmids') return selection.vmids.includes(g.vmid as number);
    return (FIXTURE_POOL_MEMBERS[selection.pool] ?? []).includes(g.vmid as number);
  });
  const nodes = [...new Set(chosen.map((g) => g.node))];
  if (nodes.length === 0) throw new GuestActionError(400, 'The job does not currently select any guests');
  return {
    upids: nodes.map((node, i) => `UPID:${node}:0000${i}A1B:00000000:00000000:vzdump::root@pam:`),
  };
}

// --- writes --------------------------------------------------------------------------------------

const BASE = '/api/actions/datacenter/backup-jobs';

/** Creates a job: `POST /api/actions/datacenter/backup-jobs`. `id` is `null` when the server could
 * not tell which job PVE generated (PVE answers a create with no body). */
export async function createBackupJob(body: BackupJobCreateBody): Promise<{ ok: true; id: string | null }> {
  if (USE_FIXTURES) return fixtureCreate(body);

  const res = await fetch(BASE, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (res.status === 200) return (await res.json()) as { ok: true; id: string | null };
  return throwActionError(res);
}

/** Edits a job: `PUT /api/actions/datacenter/backup-jobs/:id` with only the changed keys. */
export async function updateBackupJob(id: string, body: BackupJobUpdateBody): Promise<{ ok: true; id: string }> {
  if (USE_FIXTURES) return fixtureUpdate(id, body);

  const res = await fetch(`${BASE}/${encodeURIComponent(id)}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (res.status === 200) return (await res.json()) as { ok: true; id: string };
  return throwActionError(res);
}

/** Deletes a job: `DELETE /api/actions/datacenter/backup-jobs/:id`. */
export async function deleteBackupJob(id: string): Promise<{ ok: true }> {
  if (USE_FIXTURES) {
    fixtureJob(id);
    removeFixtureBackupJob(id);
    return { ok: true };
  }

  const res = await fetch(`${BASE}/${encodeURIComponent(id)}`, { method: 'DELETE' });
  if (res.status === 200) return (await res.json()) as { ok: true };
  return throwActionError(res);
}

/** "Run now": `POST /api/actions/datacenter/backup-jobs/:id/run` -> `202 { upids }`. */
export async function runBackupJob(id: string): Promise<{ upids: string[] }> {
  if (USE_FIXTURES) return fixtureRun(id);

  const res = await fetch(`${BASE}/${encodeURIComponent(id)}/run`, { method: 'POST' });
  if (res.status === 202) return (await res.json()) as { upids: string[] };
  return throwActionError(res);
}
