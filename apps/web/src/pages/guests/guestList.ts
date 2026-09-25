import { guestMatches } from '@/lib/tree';
import { parseTags } from '@/lib/format';
import type { ClusterResource, GuestType } from '@/api/types';

export type GuestStatusFilter = 'all' | 'running' | 'stopped' | 'paused' | 'template';
export type GuestTypeFilter = 'all' | GuestType;
export type GuestSortKey = 'name' | 'vmid' | 'node' | 'type' | 'status' | 'cpu' | 'mem' | 'disk' | 'uptime';
export type SortDir = 'asc' | 'desc';

export const GUEST_STATUS_FILTERS: GuestStatusFilter[] = ['all', 'running', 'stopped', 'paused', 'template'];
export const GUEST_TYPE_FILTERS: GuestTypeFilter[] = ['all', 'qemu', 'lxc'];
export const GUEST_SORT_KEYS: GuestSortKey[] = [
  'name',
  'vmid',
  'node',
  'type',
  'status',
  'cpu',
  'mem',
  'disk',
  'uptime',
];

/** One row of the Guests table -- a flattened, display-ready view of one `qemu`/`lxc`
 *  `ClusterResource`. Kept separate from `GuestNode` (`lib/tree.ts`): that shape is the
 *  inventory rail's own (nested-tree, minimal), this one carries everything the table's columns
 *  and sorts need read directly off it. */
export interface GuestRow {
  id: string;
  vmid: number;
  name: string;
  type: GuestType;
  node: string;
  status: string;
  template: boolean;
  tags: string[];
  /** 0..1, already a fraction of allocated vCPUs (PVE's own `cpu` field on `/cluster/resources`). */
  cpuFraction: number;
  memUsed: number;
  memMax: number;
  diskUsed: number;
  diskMax: number;
  uptime: number;
  /** `undefined` when the guest isn't HA-managed, or when the connected PVE version's
   *  `/cluster/resources` row doesn't carry the field at all (not modeled on `ClusterResource`
   *  yet -- read defensively so a real cluster that does send it still surfaces here). */
  hastate?: string | undefined;
}

function readHastate(resource: ClusterResource): string | undefined {
  const value = (resource as unknown as { hastate?: unknown }).hastate;
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/** Flattens cluster resources into the Guests table's row shape, dropping nodes/storage/etc. */
export function toGuestRows(resources: ClusterResource[]): GuestRow[] {
  return resources
    .filter((r) => r.type === 'qemu' || r.type === 'lxc')
    .map((r) => ({
      id: r.id,
      vmid: r.vmid ?? 0,
      name: r.name ?? `${r.type}/${r.vmid ?? ''}`,
      type: r.type as GuestType,
      node: r.node,
      status: r.status,
      template: r.template === 1,
      tags: parseTags(r.tags),
      cpuFraction: r.cpu ?? 0,
      memUsed: r.mem ?? 0,
      memMax: r.maxmem ?? 0,
      diskUsed: r.disk ?? 0,
      diskMax: r.maxdisk ?? 0,
      uptime: r.uptime ?? 0,
      hastate: readHastate(r),
    }));
}

/** PVE only ever reports real disk usage for containers (an LXC's rootfs is host-visible); a
 *  qemu guest's `disk` is always `0` whether or not the guest agent is running, so it reads as
 *  "not reported" rather than "0 bytes used". */
export function hasReportedDiskUsage(row: Pick<GuestRow, 'type'>): boolean {
  return row.type === 'lxc';
}

export interface GuestFilters {
  q: string;
  status: GuestStatusFilter;
  type: GuestTypeFilter;
  node: string;
}

export const DEFAULT_GUEST_FILTERS: GuestFilters = { q: '', status: 'all', type: 'all', node: 'all' };

/** The distinct node names present across a set of guest rows, sorted for a stable filter list. */
export function guestNodeNames(rows: GuestRow[]): string[] {
  return [...new Set(rows.map((r) => r.node))].sort((a, b) => a.localeCompare(b));
}

function matchesStatusFilter(row: GuestRow, status: GuestStatusFilter): boolean {
  if (status === 'all') return true;
  if (status === 'template') return row.template;
  return row.status === status;
}

/** Filters guest rows by the Guests page's search box + three segmented filters. `q` reuses the
 *  inventory rail's own name/VMID/tag/node matcher (`lib/tree.ts`'s `guestMatches`). */
export function filterGuestRows(rows: GuestRow[], filters: GuestFilters): GuestRow[] {
  return rows.filter(
    (row) =>
      guestMatches(row, filters.q) &&
      matchesStatusFilter(row, filters.status) &&
      (filters.type === 'all' || row.type === filters.type) &&
      (filters.node === 'all' || row.node === filters.node),
  );
}

function memFraction(row: GuestRow): number {
  return row.memMax > 0 ? row.memUsed / row.memMax : 0;
}

function diskFraction(row: GuestRow): number {
  return row.diskMax > 0 ? row.diskUsed / row.diskMax : 0;
}

/** Whether the metric-based sort keys (cpu/mem/uptime) should treat this row as "stopped" -- a
 *  guest that isn't running has no meaningful CPU/memory/uptime reading, so it always sorts after
 *  every running guest for those three keys, regardless of sort direction (see `compareGuestRows`). */
function isStoppedForMetricSort(row: GuestRow): boolean {
  return row.status !== 'running';
}

function compareByKey(a: GuestRow, b: GuestRow, key: GuestSortKey): number {
  switch (key) {
    case 'name':
      return a.name.localeCompare(b.name);
    case 'vmid':
      return a.vmid - b.vmid;
    case 'node':
      return a.node.localeCompare(b.node);
    case 'type':
      return a.type.localeCompare(b.type);
    case 'status':
      return a.status.localeCompare(b.status);
    case 'cpu':
      return a.cpuFraction - b.cpuFraction;
    case 'mem':
      return memFraction(a) - memFraction(b);
    case 'disk':
      return diskFraction(a) - diskFraction(b);
    case 'uptime':
      return a.uptime - b.uptime;
    default:
      return 0;
  }
}

const METRIC_SORT_KEYS: ReadonlySet<GuestSortKey> = new Set(['cpu', 'mem', 'uptime']);

/**
 * Sorts guest rows for the given column/direction. For `cpu`/`mem`/`uptime`, stopped guests
 * always sort after running ones (a stopped guest's 0% CPU is "not applicable", not "least
 * busy") -- direction still controls the order *within* each of those two groups.
 */
export function sortGuestRows(rows: GuestRow[], key: GuestSortKey, dir: SortDir): GuestRow[] {
  const sign = dir === 'asc' ? 1 : -1;
  const sorted = [...rows];
  sorted.sort((a, b) => {
    if (METRIC_SORT_KEYS.has(key)) {
      const aStopped = isStoppedForMetricSort(a);
      const bStopped = isStoppedForMetricSort(b);
      if (aStopped !== bStopped) return aStopped ? 1 : -1;
    }
    return sign * compareByKey(a, b, key);
  });
  return sorted;
}

/** Applies `filterGuestRows` then `sortGuestRows` in one call -- what the Guests page renders. */
export function selectGuestRows(
  rows: GuestRow[],
  filters: GuestFilters,
  sort: GuestSortKey,
  dir: SortDir,
): GuestRow[] {
  return sortGuestRows(filterGuestRows(rows, filters), sort, dir);
}

export function isGuestStatusFilter(value: unknown): value is GuestStatusFilter {
  return typeof value === 'string' && (GUEST_STATUS_FILTERS as string[]).includes(value);
}

export function isGuestTypeFilter(value: unknown): value is GuestTypeFilter {
  return typeof value === 'string' && (GUEST_TYPE_FILTERS as string[]).includes(value);
}

export function isGuestSortKey(value: unknown): value is GuestSortKey {
  return typeof value === 'string' && (GUEST_SORT_KEYS as string[]).includes(value);
}

export function isSortDir(value: unknown): value is SortDir {
  return value === 'asc' || value === 'desc';
}

/** Column ids a viewer can hide via the "Columns" dropdown (persisted in
 *  `prefs.guestList.columns`) -- name/VMID/node are always shown and have no entry here. */
export type GuestColumnId = 'type' | 'tags' | 'cpu' | 'mem' | 'disk' | 'uptime' | 'ha';

export const GUEST_COLUMNS: { id: GuestColumnId; label: string }[] = [
  { id: 'type', label: 'Type' },
  { id: 'tags', label: 'Tags' },
  { id: 'cpu', label: 'CPU' },
  { id: 'mem', label: 'Memory' },
  { id: 'disk', label: 'Disk' },
  { id: 'uptime', label: 'Uptime' },
  { id: 'ha', label: 'HA state' },
];

const ALL_COLUMN_IDS: GuestColumnId[] = GUEST_COLUMNS.map((c) => c.id);

/** The Guests page's own URL search shape -- every field optional, since `toGuestsSearch` (below)
 *  omits any value that's already at its default so the default view's URL is a bare `/guests`. */
export interface GuestsSearch {
  q?: string;
  status?: GuestStatusFilter;
  type?: GuestTypeFilter;
  node?: string;
  sort?: GuestSortKey;
  dir?: SortDir;
}

export interface GuestsSearchState {
  q: string;
  status: GuestStatusFilter;
  type: GuestTypeFilter;
  node: string;
  sort: GuestSortKey;
  dir: SortDir;
}

export const DEFAULT_GUESTS_SEARCH_STATE: GuestsSearchState = {
  q: '',
  status: 'all',
  type: 'all',
  node: 'all',
  sort: 'name',
  dir: 'asc',
};

/**
 * Normalizes a full filter/sort state down to the URL search params that actually need to be
 * there: a field at its default value is omitted entirely, so the default view's URL is a bare
 * `/guests` (per the ticket's "defaults omitted from the URL"). Shared by the route's own
 * `validateSearch` (via `parseGuestsSearch` below) and the page's navigation calls, so both
 * agree on what "default" means.
 */
export function toGuestsSearch(state: GuestsSearchState): GuestsSearch {
  return {
    ...(state.q ? { q: state.q } : {}),
    ...(state.status !== DEFAULT_GUESTS_SEARCH_STATE.status ? { status: state.status } : {}),
    ...(state.type !== DEFAULT_GUESTS_SEARCH_STATE.type ? { type: state.type } : {}),
    ...(state.node !== DEFAULT_GUESTS_SEARCH_STATE.node ? { node: state.node } : {}),
    ...(state.sort !== DEFAULT_GUESTS_SEARCH_STATE.sort ? { sort: state.sort } : {}),
    ...(state.dir !== DEFAULT_GUESTS_SEARCH_STATE.dir ? { dir: state.dir } : {}),
  };
}

/** Parses the route's untyped URL search params into `GuestsSearch`, defaulting (then
 *  re-omitting, via `toGuestsSearch`) anything missing or invalid -- the route's
 *  `validateSearch` is exactly this function. */
export function parseGuestsSearch(search: Record<string, unknown>): GuestsSearch {
  return toGuestsSearch({
    q: typeof search.q === 'string' ? search.q : DEFAULT_GUESTS_SEARCH_STATE.q,
    status: isGuestStatusFilter(search.status) ? search.status : DEFAULT_GUESTS_SEARCH_STATE.status,
    type: isGuestTypeFilter(search.type) ? search.type : DEFAULT_GUESTS_SEARCH_STATE.type,
    node:
      typeof search.node === 'string' && search.node.length > 0 ? search.node : DEFAULT_GUESTS_SEARCH_STATE.node,
    sort: isGuestSortKey(search.sort) ? search.sort : DEFAULT_GUESTS_SEARCH_STATE.sort,
    dir: isSortDir(search.dir) ? search.dir : DEFAULT_GUESTS_SEARCH_STATE.dir,
  });
}

/** Resolves the saved `prefs.guestList.columns` list to the set of optional columns to show --
 *  everything, when the preference is unset (a brand new user, or one who never opened the
 *  dropdown), otherwise exactly the saved list (filtered to ids this client still recognizes). */
export function resolveVisibleColumns(saved: string[] | undefined): Set<GuestColumnId> {
  if (!saved) return new Set(ALL_COLUMN_IDS);
  return new Set(saved.filter((id): id is GuestColumnId => (ALL_COLUMN_IDS as string[]).includes(id)));
}
