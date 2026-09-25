import { describe, expect, it } from 'vitest';

import {
  buildVmidIndex,
  contentTypeCounts,
  DEFAULT_STORAGE_BROWSER_STATE,
  filterStorageContent,
  isSortDir,
  isStorageContentFilter,
  isStorageContentType,
  isStorageSortKey,
  parseStorageSearch,
  selectStorageContent,
  sortStorageContent,
  stripStoragePrefix,
  toStorageSearch,
} from './storageList';
import type { ClusterResource, StorageContentItem } from '@/api/types';

const items: StorageContentItem[] = [
  { volid: 'local:iso/debian-12.7.0-amd64-netinst.iso', content: 'iso', format: 'iso', size: 663748608, ctime: 1780000000 },
  {
    volid: 'local:iso/virtio-win-0.1.240.iso',
    content: 'iso',
    format: 'iso',
    size: 707788800,
    ctime: 1779000000,
    notes: 'VirtIO drivers for Windows guests',
  },
  { volid: 'local:vztmpl/debian-12-standard.tar.zst', content: 'vztmpl', format: 'tzst', size: 123456, ctime: 1770000000 },
  {
    volid: 'tank-backups:backup/vzdump-qemu-100-2026_09_16-02_12_35.vma.zst',
    content: 'backup',
    format: 'vma.zst',
    size: 12884901888,
    ctime: 1789574000,
    vmid: 100,
    notes: 'nightly, auto',
  },
  {
    volid: 'tank-backups:backup/vzdump-qemu-102-2026_09_16-01_45_10.vma.zst',
    content: 'backup',
    format: 'vma.zst',
    size: 46170898432,
    ctime: 1789562783,
    vmid: 102,
  },
];

describe('stripStoragePrefix', () => {
  it('drops the storage-id prefix up to the first colon', () => {
    expect(stripStoragePrefix('local:iso/debian-12.7.0-amd64-netinst.iso')).toBe('iso/debian-12.7.0-amd64-netinst.iso');
  });

  it('returns the raw volid unchanged when there is no colon', () => {
    expect(stripStoragePrefix('no-colon-here')).toBe('no-colon-here');
  });
});

describe('contentTypeCounts', () => {
  it('counts each recognized content type', () => {
    expect(contentTypeCounts(items)).toEqual({ iso: 2, vztmpl: 1, backup: 2 });
  });

  it('returns an empty object for an empty list', () => {
    expect(contentTypeCounts([])).toEqual({});
  });
});

describe('filterStorageContent', () => {
  it('narrows by content type', () => {
    const result = filterStorageContent(items, { type: 'backup', q: '' });
    expect(result).toHaveLength(2);
    expect(result.every((i) => i.content === 'backup')).toBe(true);
  });

  it('"all" keeps every item', () => {
    expect(filterStorageContent(items, { type: 'all', q: '' })).toHaveLength(items.length);
  });

  it('matches the search box against the volume id', () => {
    const result = filterStorageContent(items, { type: 'all', q: 'virtio' });
    expect(result).toHaveLength(1);
    expect(result[0]?.volid).toContain('virtio-win');
  });

  it('matches the search box against notes', () => {
    const result = filterStorageContent(items, { type: 'all', q: 'nightly' });
    expect(result).toHaveLength(1);
    expect(result[0]?.vmid).toBe(100);
  });

  it('combines type and search', () => {
    const result = filterStorageContent(items, { type: 'iso', q: 'debian' });
    expect(result).toHaveLength(1);
    expect(result[0]?.format).toBe('iso');
  });
});

describe('sortStorageContent', () => {
  it('sorts by name (the stripped volid), ascending', () => {
    const result = sortStorageContent(items, 'name', 'asc');
    const expected = [...items].sort((a, b) => stripStoragePrefix(a.volid).localeCompare(stripStoragePrefix(b.volid)));
    expect(result.map((i) => i.volid)).toEqual(expected.map((i) => i.volid));
    // The stripped name ("backup/..." < "iso/..." < "vztmpl/...") sorts differently from the raw
    // volid ("local:..." < "tank-backups:...") -- this pins that the comparison is on the
    // stripped name, not the raw volid.
    expect(result[0]?.content).toBe('backup');
  });

  it('sorts by size, descending', () => {
    const result = sortStorageContent(items, 'size', 'desc');
    expect(result[0]?.size).toBe(46170898432);
    expect(result.at(-1)?.size).toBe(123456);
  });

  it('sorts by ctime, ascending', () => {
    const result = sortStorageContent(items, 'ctime', 'asc');
    expect(result[0]?.ctime).toBe(1770000000);
  });

  it('sorts by vmid, with items lacking a vmid sorting first ascending', () => {
    const result = sortStorageContent(items, 'vmid', 'asc');
    expect(result[0]?.vmid).toBeUndefined();
    expect(result.at(-1)?.vmid).toBe(102);
  });
});

describe('selectStorageContent', () => {
  it('filters then sorts in one call', () => {
    const result = selectStorageContent(items, { type: 'backup', q: '' }, 'size', 'asc');
    expect(result.map((i) => i.vmid)).toEqual([100, 102]);
  });
});

describe('buildVmidIndex', () => {
  const resources: ClusterResource[] = [
    { id: 'node/pve1', type: 'node', node: 'pve1', status: 'online' },
    { id: 'qemu/100', type: 'qemu', node: 'pve1', vmid: 100, status: 'running' },
    { id: 'lxc/200', type: 'lxc', node: 'pve2', vmid: 200, status: 'stopped' },
  ];

  it('indexes qemu/lxc resources by vmid', () => {
    const index = buildVmidIndex(resources);
    expect(index.get(100)).toEqual({ node: 'pve1', type: 'qemu' });
    expect(index.get(200)).toEqual({ node: 'pve2', type: 'lxc' });
  });

  it('has no entry for a vmid with no matching guest resource', () => {
    expect(buildVmidIndex(resources).get(999)).toBeUndefined();
  });
});

describe('type guards', () => {
  it('isStorageContentType accepts known types and rejects others', () => {
    expect(isStorageContentType('iso')).toBe(true);
    expect(isStorageContentType('bogus')).toBe(false);
  });

  it('isStorageContentFilter accepts "all" plus known types', () => {
    expect(isStorageContentFilter('all')).toBe(true);
    expect(isStorageContentFilter('backup')).toBe(true);
    expect(isStorageContentFilter('bogus')).toBe(false);
  });

  it('isStorageSortKey / isSortDir', () => {
    expect(isStorageSortKey('size')).toBe(true);
    expect(isStorageSortKey('bogus')).toBe(false);
    expect(isSortDir('asc')).toBe(true);
    expect(isSortDir('bogus')).toBe(false);
  });
});

describe('toStorageSearch / parseStorageSearch', () => {
  it('omits every field at its default', () => {
    expect(toStorageSearch(DEFAULT_STORAGE_BROWSER_STATE)).toEqual({});
  });

  it('keeps non-default fields', () => {
    expect(toStorageSearch({ type: 'backup', q: 'nightly', sort: 'size', dir: 'desc' })).toEqual({
      type: 'backup',
      q: 'nightly',
      sort: 'size',
      dir: 'desc',
    });
  });

  it('parses a full valid search', () => {
    expect(parseStorageSearch({ type: 'iso', q: 'debian', sort: 'ctime', dir: 'desc' })).toEqual({
      type: 'iso',
      q: 'debian',
      sort: 'ctime',
      dir: 'desc',
    });
  });

  it('drops invalid values instead of throwing, falling back to defaults', () => {
    expect(parseStorageSearch({ type: 'not-a-type', sort: 'nope', dir: 'sideways', q: 42 })).toEqual({});
  });

  it('parses an empty search as the bare default (no params)', () => {
    expect(parseStorageSearch({})).toEqual({});
  });
});
