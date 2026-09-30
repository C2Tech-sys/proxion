import { afterEach, describe, expect, it, vi } from 'vitest';

import { diskCapableStorages, getStorageFormats, inferStorageFormats } from '@/api/disks';
import type { ClusterResource } from '@/api/types';

// Real mode: the fixture branch of each function is covered by the Hardware tab's render tests.
vi.mock('@/api/client', async () => {
  const actual = await vi.importActual<typeof import('@/api/client')>('@/api/client');
  return { ...actual, USE_FIXTURES: false };
});

describe('inferStorageFormats', () => {
  it('directory-like storages take qcow2/raw/vmdk with qcow2 the default', () => {
    for (const type of ['dir', 'nfs', 'cifs']) {
      expect(inferStorageFormats(type)).toEqual({ formats: ['qcow2', 'raw', 'vmdk'], default: 'qcow2' });
    }
  });

  it('block and pool storages (and anything unknown) are raw only', () => {
    for (const type of ['lvm', 'lvmthin', 'zfspool', 'rbd', 'iscsi', 'mystery', undefined]) {
      expect(inferStorageFormats(type)).toEqual({ formats: ['raw'], default: 'raw' });
    }
  });
});

describe('getStorageFormats', () => {
  afterEach(() => vi.unstubAllGlobals());

  function stubFetch(data: unknown, ok = true) {
    const fetchMock = vi.fn().mockResolvedValue({ ok, status: ok ? 200 : 500, json: () => Promise.resolve({ data }) });
    vi.stubGlobal('fetch', fetchMock);
    return fetchMock;
  }

  it('reads the per-storage formats from the read-only storage listing', async () => {
    const fetchMock = stubFetch([
      { storage: 'local', type: 'dir', format: [{ raw: 1, qcow2: 1, vmdk: 1 }, 'qcow2'] },
      { storage: 'fast', type: 'dir', formats: ['raw', 'qcow2'] },
      { storage: 'lvm1', type: 'lvmthin' },
      { storage: 'weird', type: 'dir', format: [{ iso: 1 }, 'iso'] },
      { type: 'dir' },
    ]);
    const map = await getStorageFormats('pve1');

    expect(fetchMock).toHaveBeenCalledWith('/api/pve/nodes/pve1/storage?content=images&format=1');
    expect(map.local).toEqual({ formats: ['raw', 'qcow2', 'vmdk'], default: 'qcow2' });
    expect(map.fast).toEqual({ formats: ['raw', 'qcow2'], default: 'raw' });
    // No format data: inferred from the storage type.
    expect(map.lvm1).toEqual({ formats: ['raw'], default: 'raw' });
    expect(map.weird).toEqual({ formats: ['qcow2', 'raw', 'vmdk'], default: 'qcow2' });
    expect(Object.keys(map)).toHaveLength(4);
  });

  it('throws on a failed lookup so callers fall back to inference', async () => {
    stubFetch(null, false);
    await expect(getStorageFormats('pve1')).rejects.toThrow(/Failed to load storage formats/);
  });
});

describe('diskCapableStorages', () => {
  const rows: ClusterResource[] = [
    { id: 'a', type: 'storage', node: 'pve1', status: 'available', storage: 'a', content: 'images,iso', disk: 10, maxdisk: 100 },
    { id: 'b', type: 'storage', node: 'pve1', status: 'available', storage: 'b', content: 'rootdir' },
    { id: 'c', type: 'storage', node: 'pve2', status: 'available', storage: 'c', content: 'images' },
    { id: 'd', type: 'storage', node: 'pve1', status: 'available', storage: 'd', content: 'backup,imagesx' },
    { id: 'e', type: 'qemu', node: 'pve1', status: 'running', vmid: 100 },
  ];

  it('qemu needs images content on this node; lxc needs rootdir', () => {
    expect(diskCapableStorages(rows, 'pve1', 'qemu').map((s) => s.id)).toEqual(['a']);
    expect(diskCapableStorages(rows, 'pve1', 'lxc').map((s) => s.id)).toEqual(['b']);
    expect(diskCapableStorages(rows, 'pve2', 'qemu').map((s) => s.id)).toEqual(['c']);
    expect(diskCapableStorages(undefined, 'pve1', 'qemu')).toEqual([]);
  });

  it('reports free bytes as maxdisk - disk when both are known', () => {
    expect(diskCapableStorages(rows, 'pve1', 'qemu')[0]?.freeBytes).toBe(90);
    expect(diskCapableStorages(rows, 'pve1', 'lxc')[0]?.freeBytes).toBeUndefined();
  });
});
