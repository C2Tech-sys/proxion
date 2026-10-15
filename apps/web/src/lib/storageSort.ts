import type { ClusterResource } from '@/api/types';

/**
 * Stable, sortable ordering for the storage rows (`/cluster/resources` entries of
 * `type === 'storage'`) shown on the dashboard, the node Storage tab and the inventory tree.
 * PVE returns those rows in an order that is not stable between polls (and live mode replaces
 * the whole array on every `/api/events` push), so every list sorts at render time with these
 * pure helpers instead of trusting arrival order.
 */
export const STORAGE_SORT_KEYS = ['name', 'node', 'type', 'used', 'avail', 'usage'] as const;
export type StorageSortKey = (typeof STORAGE_SORT_KEYS)[number];
export type SortDir = 'asc' | 'desc';

/** What an absent `storageSort` preference means. */
export const DEFAULT_STORAGE_SORT: { key: StorageSortKey; dir: SortDir } = { key: 'name', dir: 'asc' };

function usedBytes(row: ClusterResource): number {
  return row.disk ?? 0;
}

function availBytes(row: ClusterResource): number {
  return (row.maxdisk ?? 0) - (row.disk ?? 0);
}

function usageFraction(row: ClusterResource): number {
  const total = row.maxdisk ?? 0;
  return total > 0 ? (row.disk ?? 0) / total : 0;
}

/** Ascending comparison of two storage rows on one key (no tiebreak, no direction). */
export function compareStorages(a: ClusterResource, b: ClusterResource, key: StorageSortKey): number {
  switch (key) {
    case 'name':
      return (a.storage ?? '').localeCompare(b.storage ?? '');
    case 'node':
      return a.node.localeCompare(b.node);
    case 'type':
      return (a.plugintype ?? '').localeCompare(b.plugintype ?? '');
    case 'used':
      return usedBytes(a) - usedBytes(b);
    case 'avail':
      return availBytes(a) - availBytes(b);
    case 'usage':
      return usageFraction(a) - usageFraction(b);
  }
}

/** Total order for rows that are equal on the sort key -- always ascending, whatever the
 *  direction, so two rows with equal values never swap between renders. */
function tiebreak(a: ClusterResource, b: ClusterResource): number {
  return a.id.localeCompare(b.id) || (a.storage ?? '').localeCompare(b.storage ?? '') || a.node.localeCompare(b.node);
}

/** A NEW array sorted by `key`/`dir`; ties always fall back to `id`, then `storage`, then `node`. */
export function sortStorages(rows: readonly ClusterResource[], key: StorageSortKey, dir: SortDir): ClusterResource[] {
  const sign = dir === 'asc' ? 1 : -1;
  return [...rows].sort((a, b) => sign * compareStorages(a, b, key) || tiebreak(a, b));
}
