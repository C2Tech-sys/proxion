/** The slice of a `/cluster/resources` row the exclusion picker reads. */
export interface StorageResourceRow {
  type?: string | undefined;
  storage?: string | undefined;
}

/** Fixed order for every storage-name list on the panel: by name, never PVE's own order. */
export function compareStorageNames(a: string, b: string): number {
  return a.localeCompare(b) || (a < b ? -1 : a > b ? 1 : 0);
}

/** `names` deduplicated and sorted by name (the server stores the list the same way). */
export function sortedStorageNames(names: readonly string[]): string[] {
  return [...new Set(names)].sort(compareStorageNames);
}

/**
 * The storages that can still be excluded: every storage the cluster reports (one entry per name,
 * however many nodes carry it), minus the ones already excluded, sorted by name regardless of the
 * order PVE returned the rows in.
 */
export function offeredStorages(
  resources: readonly StorageResourceRow[] | undefined,
  excluded: readonly string[],
): string[] {
  const taken = new Set(excluded);
  const names = new Set<string>();
  for (const row of resources ?? []) {
    if (row.type === 'storage' && typeof row.storage === 'string' && row.storage !== '' && !taken.has(row.storage)) {
      names.add(row.storage);
    }
  }
  return [...names].sort(compareStorageNames);
}
