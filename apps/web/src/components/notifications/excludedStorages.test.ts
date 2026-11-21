import { describe, expect, it } from 'vitest';
import { offeredStorages, sortedStorageNames } from './excludedStorages';

describe('offeredStorages', () => {
  const rows = [
    { type: 'storage', storage: 'zfs-data', node: 'pve2' },
    { type: 'storage', storage: 'local', node: 'pve2' },
    { type: 'qemu', storage: 'not-a-storage-row' },
    { type: 'storage', storage: 'local', node: 'pve1' },
    { type: 'storage', storage: 'Backup', node: 'pve1' },
    { type: 'storage', storage: 'cloud-backup', node: 'pve1' },
    { type: 'storage', node: 'pve1' },
    { type: 'storage', storage: '', node: 'pve1' },
    { type: 'storage', storage: 'cloud-backup', node: 'pve2' },
  ];

  it('is deduplicated by storage name and sorted by name', () => {
    expect(offeredStorages(rows, [])).toEqual(['Backup', 'cloud-backup', 'local', 'zfs-data']);
  });

  it('does not depend on the order the rows arrive in', () => {
    const expected = offeredStorages(rows, []);
    expect(offeredStorages([...rows].reverse(), [])).toEqual(expected);
    expect(offeredStorages([...rows.slice(3), ...rows.slice(0, 3)], [])).toEqual(expected);
  });

  it('leaves out names that are already excluded', () => {
    expect(offeredStorages(rows, ['local', 'gone'])).toEqual(['Backup', 'cloud-backup', 'zfs-data']);
  });

  it('copes with no data yet', () => {
    expect(offeredStorages(undefined, [])).toEqual([]);
    expect(offeredStorages([], ['x'])).toEqual([]);
  });
});

describe('sortedStorageNames', () => {
  it('deduplicates and sorts', () => {
    expect(sortedStorageNames(['b', 'a', 'b', 'C'])).toEqual(['a', 'b', 'C']);
  });
});
