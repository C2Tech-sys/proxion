import { describe, expect, it } from 'vitest';

import { compareStorages, sortStorages, STORAGE_SORT_KEYS } from '@/lib/storageSort';
import type { ClusterResource } from '@/api/types';

function storage(node: string, name: string, extra: Partial<ClusterResource> = {}): ClusterResource {
  return {
    id: `storage/${node}/${name}`,
    type: 'storage',
    node,
    storage: name,
    plugintype: 'dir',
    status: 'available',
    disk: 100,
    maxdisk: 1000,
    ...extra,
  };
}

const ROWS: ClusterResource[] = [
  storage('pve2', 'local', { plugintype: 'dir', disk: 300, maxdisk: 400 }), // usage .75, avail 100
  storage('pve1', 'tank', { plugintype: 'zfspool', disk: 900, maxdisk: 1000 }), // usage .9, avail 100
  storage('pve1', 'local', { plugintype: 'dir', disk: 100, maxdisk: 1000 }), // usage .1, avail 900
  storage('pve1', 'bulk', { plugintype: 'lvmthin', disk: 50, maxdisk: 0 }), // usage 0 (no capacity)
];

const names = (rows: ClusterResource[]) => rows.map((r) => r.id);

describe('storageSort', () => {
  it('exposes the six sort keys in a fixed order', () => {
    expect([...STORAGE_SORT_KEYS]).toStrictEqual(['name', 'node', 'type', 'used', 'avail', 'usage']);
  });

  it('name: localeCompare on storage, ties broken on id (node)', () => {
    expect(names(sortStorages(ROWS, 'name', 'asc'))).toStrictEqual([
      'storage/pve1/bulk',
      'storage/pve1/local',
      'storage/pve2/local',
      'storage/pve1/tank',
    ]);
  });

  it('node and type sort on node and plugintype', () => {
    expect(sortStorages(ROWS, 'node', 'asc').map((r) => r.node)).toStrictEqual(['pve1', 'pve1', 'pve1', 'pve2']);
    expect(sortStorages(ROWS, 'type', 'asc').map((r) => r.plugintype)).toStrictEqual([
      'dir',
      'dir',
      'lvmthin',
      'zfspool',
    ]);
  });

  it('used sorts on disk; avail on maxdisk - disk', () => {
    expect(sortStorages(ROWS, 'used', 'asc').map((r) => r.disk)).toStrictEqual([50, 100, 300, 900]);
    // avail: bulk is -50 (maxdisk 0), then the two 100s (tie -> id), then 900.
    expect(names(sortStorages(ROWS, 'avail', 'asc'))).toStrictEqual([
      'storage/pve1/bulk',
      'storage/pve1/tank',
      'storage/pve2/local',
      'storage/pve1/local',
    ]);
  });

  it('usage sorts on disk / maxdisk, treating maxdisk 0 as 0', () => {
    expect(names(sortStorages(ROWS, 'usage', 'asc'))).toStrictEqual([
      'storage/pve1/bulk',
      'storage/pve1/local',
      'storage/pve2/local',
      'storage/pve1/tank',
    ]);
    expect(compareStorages(storage('pve1', 'a', { disk: 5, maxdisk: 0 }), storage('pve1', 'b', { disk: 0, maxdisk: 0 }), 'usage')).toBe(0);
  });

  it('desc reverses the primary order (used and usage have no ties on this data)', () => {
    for (const key of ['used', 'usage'] as const) {
      expect(names(sortStorages(ROWS, key, 'desc'))).toStrictEqual(names(sortStorages(ROWS, key, 'asc')).reverse());
    }
    expect(sortStorages(ROWS, 'used', 'desc').map((r) => r.disk)).toStrictEqual([900, 300, 100, 50]);
    expect(sortStorages(ROWS, 'name', 'desc').map((r) => r.storage)).toStrictEqual(['tank', 'local', 'local', 'bulk']);
  });

  it('equal values break ties on id in both directions (rows never swap)', () => {
    const rows = [storage('pve2', 'x'), storage('pve1', 'x'), storage('pve3', 'x')];
    for (const key of STORAGE_SORT_KEYS) {
      for (const dir of ['asc', 'desc'] as const) {
        const ids = names(sortStorages(rows, key, dir));
        if (key === 'node') {
          expect(ids).toStrictEqual(
            dir === 'asc'
              ? ['storage/pve1/x', 'storage/pve2/x', 'storage/pve3/x']
              : ['storage/pve3/x', 'storage/pve2/x', 'storage/pve1/x'],
          );
        } else {
          expect(ids).toStrictEqual(['storage/pve1/x', 'storage/pve2/x', 'storage/pve3/x']);
        }
      }
    }
  });

  it('gives the same output for two different input orders, and never mutates the input', () => {
    const shuffled = [2, 0, 3, 1].map((i) => ROWS[i] as ClusterResource);
    const reversed = [...ROWS].reverse();
    const before = names(ROWS);
    for (const key of STORAGE_SORT_KEYS) {
      for (const dir of ['asc', 'desc'] as const) {
        const a = sortStorages(shuffled, key, dir);
        const b = sortStorages(reversed, key, dir);
        expect(names(a)).toStrictEqual(names(b));
        expect(a).not.toBe(shuffled);
      }
    }
    expect(names(ROWS)).toStrictEqual(before);
  });
});
