import type { ClusterResource, GuestType, StorageContentItem } from '@/api/types';

/**
 * The PVE `content` values this app knows a label/chip for (T28's storage content browser).
 * `import` is a real PVE content type (import-from-ova/ovf staging) that shows up in the URL
 * search schema but has no dedicated chip in the ticket's chip strip -- it still gets a fallback
 * label so an item of that type never renders a blank "Type" cell.
 */
export type StorageContentType = 'iso' | 'vztmpl' | 'backup' | 'images' | 'rootdir' | 'snippets' | 'import';

export type StorageContentFilter = 'all' | StorageContentType;
export type StorageSortKey = 'name' | 'size' | 'ctime' | 'vmid';
export type SortDir = 'asc' | 'desc';

/** Chip order (T28: "All · ISO images · CT templates · Backups · Disk images · CT volumes ·
 *  Snippets") -- only types actually present on the storage get a chip; "All" is always shown. */
export const CONTENT_TYPE_ORDER: StorageContentType[] = [
  'iso',
  'vztmpl',
  'backup',
  'images',
  'rootdir',
  'snippets',
  'import',
];

export const CONTENT_TYPE_LABELS: Record<StorageContentType, string> = {
  iso: 'ISO images',
  vztmpl: 'CT templates',
  backup: 'Backups',
  images: 'Disk images',
  rootdir: 'CT volumes',
  snippets: 'Snippets',
  import: 'Import',
};

const STORAGE_CONTENT_TYPES: readonly string[] = CONTENT_TYPE_ORDER;
const STORAGE_SORT_KEYS: readonly StorageSortKey[] = ['name', 'size', 'ctime', 'vmid'];

export function isStorageContentType(value: unknown): value is StorageContentType {
  return typeof value === 'string' && STORAGE_CONTENT_TYPES.includes(value);
}

export function isStorageContentFilter(value: unknown): value is StorageContentFilter {
  return value === 'all' || isStorageContentType(value);
}

export function isStorageSortKey(value: unknown): value is StorageSortKey {
  return typeof value === 'string' && (STORAGE_SORT_KEYS as readonly string[]).includes(value);
}

export function isSortDir(value: unknown): value is SortDir {
  return value === 'asc' || value === 'desc';
}

/** A volid's display name -- the `storage:` prefix stripped, e.g.
 *  `"local:iso/debian-12.7.0-amd64-netinst.iso"` -> `"iso/debian-12.7.0-amd64-netinst.iso"`.
 *  The full volid is kept available separately (callers put it in a `title`) so nothing is lost,
 *  this is purely what the Name column *displays*. Falls back to the raw volid when there's no
 *  `:` to split on (shouldn't happen for a real PVE volid, but keeps this total). */
export function stripStoragePrefix(volid: string): string {
  const i = volid.indexOf(':');
  return i === -1 ? volid : volid.slice(i + 1);
}

/** Counts of each content type present in a storage's content list, keyed by the exact `content`
 *  string PVE returned (only entries this app recognizes get a chip -- see `CONTENT_TYPE_ORDER`). */
export function contentTypeCounts(items: StorageContentItem[]): Partial<Record<StorageContentType, number>> {
  const counts: Partial<Record<StorageContentType, number>> = {};
  for (const item of items) {
    if (!isStorageContentType(item.content)) continue;
    counts[item.content] = (counts[item.content] ?? 0) + 1;
  }
  return counts;
}

export interface StorageContentFilters {
  type: StorageContentFilter;
  q: string;
}

/** Filters a storage's content by type chip and the free-text search box (matches volume id or
 *  notes, case-insensitively -- same "type the same thing, get the same rows" contract the
 *  Guests page's search box follows). */
export function filterStorageContent(items: StorageContentItem[], filters: StorageContentFilters): StorageContentItem[] {
  const byType = filters.type === 'all' ? items : items.filter((item) => item.content === filters.type);
  const needle = filters.q.trim().toLowerCase();
  if (!needle) return byType;
  return byType.filter(
    (item) => item.volid.toLowerCase().includes(needle) || (item.notes ?? '').toLowerCase().includes(needle),
  );
}

function compareByKey(a: StorageContentItem, b: StorageContentItem, key: StorageSortKey): number {
  switch (key) {
    case 'name':
      return stripStoragePrefix(a.volid).localeCompare(stripStoragePrefix(b.volid));
    case 'size':
      return (a.size ?? 0) - (b.size ?? 0);
    case 'ctime':
      return (a.ctime ?? 0) - (b.ctime ?? 0);
    case 'vmid':
      return (a.vmid ?? -1) - (b.vmid ?? -1);
    default:
      return 0;
  }
}

export function sortStorageContent(items: StorageContentItem[], key: StorageSortKey, dir: SortDir): StorageContentItem[] {
  const sign = dir === 'asc' ? 1 : -1;
  const sorted = [...items];
  sorted.sort((a, b) => sign * compareByKey(a, b, key));
  return sorted;
}

/** Applies `filterStorageContent` then `sortStorageContent` in one call -- what the content
 *  browser table renders. */
export function selectStorageContent(
  items: StorageContentItem[],
  filters: StorageContentFilters,
  sort: StorageSortKey,
  dir: SortDir,
): StorageContentItem[] {
  return sortStorageContent(filterStorageContent(items, filters), sort, dir);
}

export interface OwnerRef {
  node: string;
  type: GuestType;
}

/** A `vmid -> {node, type}` index built from cluster resources, used to resolve a content item's
 *  owner VMID to a link at `/vm/$node/$type/$vmid`. A vmid with no matching guest resource (a
 *  stale/orphaned volume) simply has no entry, which callers render as plain text. */
export function buildVmidIndex(resources: ClusterResource[]): Map<number, OwnerRef> {
  const map = new Map<number, OwnerRef>();
  for (const r of resources) {
    if ((r.type === 'qemu' || r.type === 'lxc') && r.vmid !== undefined) {
      map.set(r.vmid, { node: r.node, type: r.type });
    }
  }
  return map;
}

/** The storage content browser's own state (T28) -- shared by the URL-backed `page` mode
 *  (`StoragePage`) and the locally-stated `compact` mode (the node Storage tab's expanded row). */
export interface StorageBrowserState {
  type: StorageContentFilter;
  q: string;
  sort: StorageSortKey;
  dir: SortDir;
}

export const DEFAULT_STORAGE_BROWSER_STATE: StorageBrowserState = {
  type: 'all',
  q: '',
  sort: 'name',
  dir: 'asc',
};

/** The storage page route's own URL search shape -- every field optional, since `toStorageSearch`
 *  omits any value already at its default so the default view's URL is a bare
 *  `/storage/$node/$storage` (same convention as `pages/guests/guestList.ts`'s `GuestsSearch`). */
export interface StorageSearch {
  type?: StorageContentType;
  q?: string;
  sort?: StorageSortKey;
  dir?: SortDir;
}

/**
 * Normalizes a full browser state down to the URL search params that actually need to be there:
 * a field at its default value is omitted entirely. Shared by the route's own `validateSearch`
 * (via `parseStorageSearch` below) and the page's navigation calls, so both agree on "default".
 */
export function toStorageSearch(state: StorageBrowserState): StorageSearch {
  return {
    ...(state.type !== 'all' ? { type: state.type } : {}),
    ...(state.q ? { q: state.q } : {}),
    ...(state.sort !== DEFAULT_STORAGE_BROWSER_STATE.sort ? { sort: state.sort } : {}),
    ...(state.dir !== DEFAULT_STORAGE_BROWSER_STATE.dir ? { dir: state.dir } : {}),
  };
}

/** Parses the route's untyped URL search params into `StorageSearch`, defaulting (then
 *  re-omitting, via `toStorageSearch`) anything missing or invalid rather than throwing --
 *  the route's `validateSearch` is exactly this function. */
export function parseStorageSearch(search: Record<string, unknown>): StorageSearch {
  return toStorageSearch({
    type: isStorageContentType(search.type) ? search.type : DEFAULT_STORAGE_BROWSER_STATE.type,
    q: typeof search.q === 'string' ? search.q : DEFAULT_STORAGE_BROWSER_STATE.q,
    sort: isStorageSortKey(search.sort) ? search.sort : DEFAULT_STORAGE_BROWSER_STATE.sort,
    dir: isSortDir(search.dir) ? search.dir : DEFAULT_STORAGE_BROWSER_STATE.dir,
  });
}
