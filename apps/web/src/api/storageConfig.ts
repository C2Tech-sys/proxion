import { USE_FIXTURES } from '@/api/client';
import { GuestActionError } from '@/api/actions';
import {
  FIXTURE_STORAGE_SCAN,
  addFixtureStorageConfig,
  getFixtureStorageConfigs,
  patchFixtureStorageConfig,
  removeFixtureStorageConfig,
  type FixtureStorageConfig,
} from '@/api/fixtures';

/**
 * Datacenter -> Storage (T70): the web side of `POST /api/actions/datacenter/storage`,
 * `PUT|DELETE .../storage/:storage` (`apps/server/src/actions/storageConfigRoutes.ts`) plus the
 * read-only lookups the panel needs through the `/api/pve/*` proxy (the storage list and the
 * `scan/*` helpers). Fixture mode is handled inline in each function (same convention as
 * `network.ts`). CIFS/PBS passwords travel only in the add/edit request body: they are never
 * stored in the fixture record, never put in a URL and never logged.
 */

export const STORAGE_TYPES = ['dir', 'nfs', 'cifs', 'lvm', 'lvmthin', 'zfspool', 'pbs'] as const;
export type StorageType = (typeof STORAGE_TYPES)[number];

export const STORAGE_TYPE_LABELS: Record<StorageType, string> = {
  dir: 'Directory',
  nfs: 'NFS',
  cifs: 'SMB/CIFS',
  lvm: 'LVM',
  lvmthin: 'LVM-Thin',
  zfspool: 'ZFS',
  pbs: 'Proxmox Backup Server',
};

export const CONTENT_TYPES = ['images', 'rootdir', 'vztmpl', 'backup', 'iso', 'snippets', 'import'] as const;
export type ContentType = (typeof CONTENT_TYPES)[number];

export const CONTENT_LABELS: Record<ContentType, string> = {
  images: 'Disk image',
  rootdir: 'Container',
  vztmpl: 'Container template',
  backup: 'VZDump backup file',
  iso: 'ISO image',
  snippets: 'Snippets',
  import: 'Import',
};

/** What each storage type can hold (PVE's own matrix; the server enforces the same). */
export const CONTENT_BY_TYPE: Record<StorageType, readonly ContentType[]> = {
  dir: CONTENT_TYPES,
  nfs: CONTENT_TYPES,
  cifs: CONTENT_TYPES,
  lvm: ['images', 'rootdir'],
  lvmthin: ['images', 'rootdir'],
  zfspool: ['images', 'rootdir'],
  pbs: ['backup'],
};

export const DEFAULT_CONTENT_BY_TYPE: Record<StorageType, readonly ContentType[]> = {
  dir: ['iso', 'vztmpl', 'backup'],
  nfs: ['iso', 'vztmpl', 'backup'],
  cifs: ['iso', 'vztmpl', 'backup'],
  lvm: ['images', 'rootdir'],
  lvmthin: ['images', 'rootdir'],
  zfspool: ['images', 'rootdir'],
  pbs: ['backup'],
};

/** The types whose definition carries a `prune-backups` retention policy. */
export const PRUNE_CAPABLE: readonly StorageType[] = ['dir', 'nfs', 'cifs', 'pbs'];

export const SMB_VERSIONS = ['default', '2.0', '2.1', '3', '3.0', '3.11'] as const;

/** The keep-* retention policy; `keepAll` excludes the others. */
export interface PruneKeep {
  keepAll?: boolean;
  keepLast?: number;
  keepHourly?: number;
  keepDaily?: number;
  keepWeekly?: number;
  keepMonthly?: number;
  keepYearly?: number;
}

export const PRUNE_FIELDS = [
  ['keepLast', 'keep-last', 'Keep last'],
  ['keepHourly', 'keep-hourly', 'Keep hourly'],
  ['keepDaily', 'keep-daily', 'Keep daily'],
  ['keepWeekly', 'keep-weekly', 'Keep weekly'],
  ['keepMonthly', 'keep-monthly', 'Keep monthly'],
  ['keepYearly', 'keep-yearly', 'Keep yearly'],
] as const satisfies ReadonlyArray<readonly [keyof PruneKeep, string, string]>;

/** `keep-last=3,keep-daily=7` / `keep-all=1` -> a `PruneKeep` (unknown keys ignored). */
export function parsePruneBackups(raw: unknown): PruneKeep | undefined {
  if (typeof raw !== 'string' || raw === '') return undefined;
  const result: PruneKeep = {};
  for (const part of raw.split(',')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    const key = part.slice(0, eq);
    const value = Number(part.slice(eq + 1));
    if (key === 'keep-all') {
      if (value === 1) result.keepAll = true;
      continue;
    }
    const field = PRUNE_FIELDS.find(([, pveKey]) => pveKey === key);
    if (field && Number.isInteger(value) && value >= 0) result[field[0]] = value;
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

/** A short human summary of a retention policy ("keep all", "last 3, daily 7"). */
export function summarizePrune(prune: PruneKeep | undefined): string {
  if (!prune) return '';
  if (prune.keepAll) return 'keep all';
  return PRUNE_FIELDS.filter(([key]) => prune[key] !== undefined)
    .map(([key, , label]) => `${label.replace('Keep ', '').toLowerCase()} ${prune[key]}`)
    .join(', ');
}

/** A storage definition, normalised from a `GET /storage` row. */
export interface StorageConfig {
  storage: string;
  type: string;
  content: string[];
  /** Empty = every node. */
  nodes: string[];
  shared: boolean;
  disabled: boolean;
  /** Path / server:export / //server/share / vg / pool ... -- what the storage points at. */
  target: string;
  prune: PruneKeep | undefined;
  /** The row as PVE returned it (no secrets are ever in it). */
  raw: Record<string, unknown>;
}

function flag(value: unknown): boolean {
  return value === 1 || value === true || value === '1';
}

function listOf(value: unknown): string[] {
  return typeof value === 'string' && value !== '' ? value.split(',').map((s) => s.trim()).filter(Boolean) : [];
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

export function targetOf(raw: Record<string, unknown>): string {
  switch (raw.type) {
    case 'dir':
      return str(raw.path);
    case 'nfs':
      return `${str(raw.server)}:${str(raw.export)}`;
    case 'cifs':
      return `//${str(raw.server)}/${str(raw.share)}`;
    case 'lvm':
      return str(raw.vgname);
    case 'lvmthin':
      return `${str(raw.vgname)}/${str(raw.thinpool)}`;
    case 'zfspool':
      return str(raw.pool);
    case 'pbs':
      return `${str(raw.server)}:${str(raw.datastore)}`;
    default:
      return str(raw.path) || str(raw.server) || str(raw.pool) || str(raw.vgname);
  }
}

export function normalizeStorageConfig(raw: Record<string, unknown>): StorageConfig {
  const prune = parsePruneBackups(raw['prune-backups']);
  return {
    storage: str(raw.storage),
    type: str(raw.type),
    content: listOf(raw.content),
    nodes: listOf(raw.nodes),
    shared: flag(raw.shared),
    disabled: flag(raw.disable),
    target: targetOf(raw),
    prune,
    raw,
  };
}

// --- request bodies (mirror the server's strict schemas) ---------------------------------------

interface AddCommon {
  storage: string;
  content: ContentType[];
  /** Omit for "all nodes". */
  nodes?: string[];
  disable?: boolean;
}

export type StorageAddBody =
  | (AddCommon & {
      type: 'dir';
      path: string;
      shared?: boolean;
      preallocation?: 'off' | 'metadata' | 'falloc' | 'full';
      prune?: PruneKeep;
    })
  | (AddCommon & { type: 'nfs'; server: string; export: string; options?: string; prune?: PruneKeep })
  | (AddCommon & {
      type: 'cifs';
      server: string;
      share: string;
      username?: string;
      password?: string;
      domain?: string;
      subdir?: string;
      smbversion?: (typeof SMB_VERSIONS)[number];
      prune?: PruneKeep;
    })
  | (AddCommon & { type: 'lvm'; vgname: string; base?: string; shared?: boolean })
  | (AddCommon & { type: 'lvmthin'; vgname: string; thinpool: string })
  | (AddCommon & { type: 'zfspool'; pool: string; sparse?: boolean; blocksize?: string; mountpoint?: string })
  | (AddCommon & {
      type: 'pbs';
      server: string;
      datastore: string;
      username: string;
      password: string;
      fingerprint?: string;
      namespace?: string;
      prune?: PruneKeep;
    });

/** The edit body: every field optional; `null` clears a property. `password: { keep: true }`
 * leaves the stored secret alone. */
export interface StorageEditBody {
  content?: ContentType[];
  nodes?: string[] | null;
  disable?: boolean;
  shared?: boolean;
  options?: string | null;
  prune?: PruneKeep | null;
  preallocation?: 'off' | 'metadata' | 'falloc' | 'full' | null;
  bwlimit?: number | null;
  username?: string | null;
  password?: string | { keep: true } | null;
  domain?: string | null;
  smbversion?: (typeof SMB_VERSIONS)[number] | null;
  fingerprint?: string | null;
  namespace?: string | null;
  sparse?: boolean;
}

export interface StorageSaveResult {
  ok: true;
  storage: string;
}

export interface StorageEditResult {
  ok: true;
  storage: string;
  changed: string[];
}

interface StorageErrorBody {
  error?: string;
  message?: string;
  missing?: string;
}

function describeError(status: number, statusText: string, body: StorageErrorBody | undefined): string {
  if (body?.message) return body.message;
  switch (body?.error) {
    case 'writes-disabled-in-token-mode':
      return 'Read-only: signed in with a service token';
    case 'forbidden':
      return body?.missing ? `You don't have ${body.missing} on this storage` : "You don't have permission for this";
    case 'pve-unreachable':
      return 'Proxmox VE is unreachable';
    default:
      return body?.error ?? `Request failed: ${status} ${statusText}`;
  }
}

async function throwActionError(res: Response): Promise<never> {
  let errorBody: StorageErrorBody | undefined;
  try {
    errorBody = (await res.json()) as StorageErrorBody;
  } catch {
    errorBody = undefined;
  }
  throw new GuestActionError(res.status, describeError(res.status, res.statusText, errorBody));
}

// --- fixture (demo) mode ----------------------------------------------------------------------

/** `PruneKeep` -> PVE's `keep-last=3,keep-daily=7` / `keep-all=1`; `undefined` for nothing set. */
export function composePruneBackups(prune: PruneKeep | undefined): string | undefined {
  if (!prune) return undefined;
  if (prune.keepAll) return 'keep-all=1';
  const parts = PRUNE_FIELDS.filter(([key]) => prune[key] !== undefined).map(([key, pveKey]) => `${pveKey}=${prune[key]}`);
  return parts.length > 0 ? parts.join(',') : undefined;
}

/** The fixture record for an add body: PVE's own property names, and NEVER the password. */
function fixtureRecordFromAdd(body: StorageAddBody): FixtureStorageConfig {
  const record: FixtureStorageConfig = { storage: body.storage, type: body.type };
  const copy = (key: string, value: string | number | boolean | undefined) => {
    if (value !== undefined && value !== '') record[key] = typeof value === 'boolean' ? (value ? 1 : 0) : value;
  };
  switch (body.type) {
    case 'dir':
      copy('path', body.path);
      copy('shared', body.shared === true ? true : undefined);
      copy('preallocation', body.preallocation);
      break;
    case 'nfs':
      copy('server', body.server);
      copy('export', body.export);
      copy('options', body.options);
      break;
    case 'cifs':
      copy('server', body.server);
      copy('share', body.share);
      copy('username', body.username);
      copy('domain', body.domain);
      copy('subdir', body.subdir);
      copy('smbversion', body.smbversion);
      break;
    case 'lvm':
      copy('vgname', body.vgname);
      copy('base', body.base);
      copy('shared', body.shared === true ? true : undefined);
      break;
    case 'lvmthin':
      copy('vgname', body.vgname);
      copy('thinpool', body.thinpool);
      break;
    case 'zfspool':
      copy('pool', body.pool);
      copy('sparse', body.sparse === true ? true : undefined);
      copy('blocksize', body.blocksize);
      copy('mountpoint', body.mountpoint);
      break;
    case 'pbs':
      copy('server', body.server);
      copy('datastore', body.datastore);
      copy('username', body.username);
      copy('fingerprint', body.fingerprint);
      copy('namespace', body.namespace);
      break;
  }
  record.content = body.content.join(',');
  if (body.nodes !== undefined && body.nodes.length > 0) record.nodes = body.nodes.join(',');
  if (body.disable === true) record.disable = 1;
  if ('prune' in body) copy('prune-backups', composePruneBackups(body.prune));
  return record;
}

function fixtureEdit(storage: string, body: StorageEditBody): StorageEditResult {
  const set: Record<string, string | number | boolean> = {};
  const remove: string[] = [];
  const changed: string[] = [];
  const put = (key: string, value: string | number | boolean) => {
    set[key] = typeof value === 'boolean' ? (value ? 1 : 0) : value;
    changed.push(key);
  };
  const clear = (key: string) => {
    remove.push(key);
    changed.push(key);
  };

  if (body.content !== undefined) put('content', body.content.join(','));
  if (body.nodes !== undefined) {
    if (body.nodes === null || body.nodes.length === 0) clear('nodes');
    else put('nodes', body.nodes.join(','));
  }
  if (body.disable !== undefined) put('disable', body.disable);
  if (body.shared !== undefined) put('shared', body.shared);
  if (body.sparse !== undefined) put('sparse', body.sparse);
  for (const key of ['options', 'preallocation', 'bwlimit', 'username', 'domain', 'smbversion', 'fingerprint', 'namespace'] as const) {
    const value = body[key];
    if (value === undefined) continue;
    if (value === null) clear(key);
    else put(key, value);
  }
  if (body.prune !== undefined) {
    const prune = composePruneBackups(body.prune ?? undefined);
    if (prune === undefined) clear('prune-backups');
    else put('prune-backups', prune);
  }
  // A new password would be sent to PVE and never kept; `{ keep: true }` changes nothing.
  if (body.password === null) clear('password');
  else if (typeof body.password === 'string') changed.push('password');

  patchFixtureStorageConfig(storage, set, remove);
  return { ok: true, storage, changed };
}

/** Runs a fixture mutator, surfacing its message the way a PVE 4xx would arrive. */
function fixtureCall<T>(fn: () => T): T {
  try {
    return fn();
  } catch (error) {
    throw new GuestActionError(400, error instanceof Error ? error.message : 'Request failed');
  }
}

// --- public API -------------------------------------------------------------------------------

/** The storage definitions: `GET /storage` through the read-only proxy (fixtures: in memory). */
export async function getStorageConfigs(): Promise<StorageConfig[]> {
  if (USE_FIXTURES) {
    return getFixtureStorageConfigs().map((c) => normalizeStorageConfig(c));
  }
  const res = await fetch('/api/pve/storage');
  if (!res.ok) throw new Error(`Failed to load storage definitions: ${res.status}`);
  const envelope = (await res.json()) as { data?: unknown };
  if (!Array.isArray(envelope.data)) return [];
  return (envelope.data as unknown[])
    .filter((row): row is Record<string, unknown> => typeof row === 'object' && row !== null)
    .map(normalizeStorageConfig)
    .filter((c) => c.storage !== '')
    .sort((a, b) => a.storage.localeCompare(b.storage));
}

/** Adds a storage: `POST /api/actions/datacenter/storage`. */
export async function addStorage(body: StorageAddBody): Promise<StorageSaveResult> {
  if (USE_FIXTURES) {
    return fixtureCall(() => {
      addFixtureStorageConfig(fixtureRecordFromAdd(body));
      return { ok: true as const, storage: body.storage };
    });
  }
  const res = await fetch('/api/actions/datacenter/storage', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (res.status === 200) return (await res.json()) as StorageSaveResult;
  return throwActionError(res);
}

/** Edits a storage: `PUT /api/actions/datacenter/storage/:storage`. */
export async function editStorage(storage: string, body: StorageEditBody): Promise<StorageEditResult> {
  if (USE_FIXTURES) {
    return fixtureCall(() => fixtureEdit(storage, body));
  }
  const res = await fetch(`/api/actions/datacenter/storage/${encodeURIComponent(storage)}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (res.status === 200) return (await res.json()) as StorageEditResult;
  return throwActionError(res);
}

/** Removes the storage DEFINITION (PVE never deletes the data): `DELETE .../storage/:storage`. */
export async function removeStorage(storage: string): Promise<{ ok: true }> {
  if (USE_FIXTURES) {
    return fixtureCall(() => {
      if (storage === 'local') throw new Error('The built-in "local" storage cannot be removed.');
      removeFixtureStorageConfig(storage);
      return { ok: true as const };
    });
  }
  const res = await fetch(`/api/actions/datacenter/storage/${encodeURIComponent(storage)}`, { method: 'DELETE' });
  if (res.status === 200) return (await res.json()) as { ok: true };
  return throwActionError(res);
}

export type ScanRequest =
  | { kind: 'nfs'; node: string; server: string }
  | { kind: 'cifs'; node: string; server: string }
  | { kind: 'zfs'; node: string }
  | { kind: 'lvm'; node: string }
  | { kind: 'lvmthin'; node: string; vg: string };

/**
 * The scan helpers (`GET /nodes/{node}/scan/*` through the read-only proxy), reduced to the one
 * string each picker needs: NFS export paths, CIFS share names, ZFS pools, LVM volume groups and
 * thin pools. CIFS is scanned anonymously on purpose and PBS is not scanned at all: PVE takes the
 * credentials as GET query parameters, and a password in a URL is logged by every hop.
 */
export async function scanStorage(request: ScanRequest): Promise<string[]> {
  if (USE_FIXTURES) {
    switch (request.kind) {
      case 'nfs':
        return FIXTURE_STORAGE_SCAN.nfs.map((row) => row.path);
      case 'cifs':
        return FIXTURE_STORAGE_SCAN.cifs.map((row) => row.share);
      case 'zfs':
        return FIXTURE_STORAGE_SCAN.zfs.map((row) => row.pool);
      case 'lvm':
        return FIXTURE_STORAGE_SCAN.lvm.map((row) => row.vg);
      case 'lvmthin':
        return (FIXTURE_STORAGE_SCAN.lvmthin[request.vg] ?? []).map((row) => row.lv);
    }
  }

  const base = `/api/pve/nodes/${encodeURIComponent(request.node)}/scan/${request.kind}`;
  const query =
    request.kind === 'nfs' || request.kind === 'cifs'
      ? `?server=${encodeURIComponent(request.server)}`
      : request.kind === 'lvmthin'
        ? `?vg=${encodeURIComponent(request.vg)}`
        : '';
  const res = await fetch(`${base}${query}`);
  if (!res.ok) throw new GuestActionError(res.status, `The scan failed (${res.status}). Enter the value by hand.`);
  const envelope = (await res.json()) as { data?: unknown };
  if (!Array.isArray(envelope.data)) return [];
  const key = { nfs: 'path', cifs: 'share', zfs: 'pool', lvm: 'vg', lvmthin: 'lv' }[request.kind];
  return (envelope.data as Array<Record<string, unknown>>)
    .map((row) => row[key])
    .filter((value): value is string => typeof value === 'string' && value !== '');
}
