import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  getNextId,
  listContainerTemplates,
  listIsos,
  listNodes,
  listStoragesWithContent,
  nodesFromResources,
  parseNextId,
  parseNodeStorageRows,
  parseStorageMedia,
} from '@/api/create';
import type { ClusterResource } from '@/api/types';

// Real mode: the proxy URLs and envelope handling are what these tests pin. The fixture branches
// are covered in create.fixture.test.ts.
vi.mock('@/api/client', async () => {
  const actual = await vi.importActual<typeof import('@/api/client')>('@/api/client');
  return {
    ...actual,
    USE_FIXTURES: false,
    api: { getClusterResources: () => Promise.resolve(CLUSTER) },
  };
});

const CLUSTER: ClusterResource[] = [
  { id: 'node/pve2', type: 'node', node: 'pve2', status: 'offline' },
  { id: 'node/pve1', type: 'node', node: 'pve1', status: 'online' },
  { id: 'qemu/100', type: 'qemu', node: 'pve1', status: 'running', vmid: 100 },
];

describe('parseNextId', () => {
  it('accepts the string PVE sends and a bare number', () => {
    expect(parseNextId('100')).toBe(100);
    expect(parseNextId(214)).toBe(214);
  });

  it('rejects anything that is not a positive integer', () => {
    for (const bad of [undefined, null, '', 'abc', '1.5', 0, -3, NaN, {}]) {
      expect(() => parseNextId(bad)).toThrow(/next VM ID/);
    }
  });
});

describe('parseStorageMedia', () => {
  it('keeps volid/size/ctime and drops rows without a volid or of another content type', () => {
    const rows = [
      { volid: 'local:iso/a.iso', content: 'iso', size: 10, ctime: 5 },
      { volid: 'local:iso/b.iso', size: 'big' },
      { volid: 'local:vztmpl/t.tar.zst', content: 'vztmpl', size: 7 },
      { content: 'iso', size: 1 },
      null,
    ];
    expect(parseStorageMedia(rows, 'iso')).toEqual([
      { volid: 'local:iso/a.iso', size: 10, ctime: 5 },
      { volid: 'local:iso/b.iso', size: 0, ctime: undefined },
    ]);
    expect(parseStorageMedia(rows, 'vztmpl').map((m) => m.volid)).toEqual(['local:iso/b.iso', 'local:vztmpl/t.tar.zst']);
  });

  it('is empty for a non-array payload', () => {
    expect(parseStorageMedia(undefined, 'iso')).toEqual([]);
    expect(parseStorageMedia({}, 'vztmpl')).toEqual([]);
  });
});

describe('parseNodeStorageRows', () => {
  it('maps storage/type/avail and skips rows without a storage id', () => {
    expect(
      parseNodeStorageRows([{ storage: 'local', type: 'dir', avail: 90 }, { storage: 'x' }, { type: 'dir' }, 'junk']),
    ).toEqual([
      { id: 'local', plugintype: 'dir', freeBytes: 90 },
      { id: 'x', plugintype: undefined, freeBytes: undefined },
    ]);
    expect(parseNodeStorageRows(null)).toEqual([]);
  });
});

describe('nodesFromResources', () => {
  it('lists only node rows, sorted by name', () => {
    expect(nodesFromResources(CLUSTER)).toEqual([
      { name: 'pve1', status: 'online' },
      { name: 'pve2', status: 'offline' },
    ]);
    expect(nodesFromResources(undefined)).toEqual([]);
  });
});

describe('real-mode reads', () => {
  afterEach(() => vi.unstubAllGlobals());

  function stubFetch(data: unknown, ok = true) {
    const fetchMock = vi.fn().mockResolvedValue({ ok, status: ok ? 200 : 500, json: () => Promise.resolve({ data }) });
    vi.stubGlobal('fetch', fetchMock);
    return fetchMock;
  }

  it('getNextId reads /cluster/nextid through the proxy', async () => {
    const fetchMock = stubFetch('123');
    await expect(getNextId()).resolves.toBe(123);
    expect(fetchMock).toHaveBeenCalledWith('/api/pve/cluster/nextid');
  });

  it('getNextId surfaces a failed request', async () => {
    stubFetch(null, false);
    await expect(getNextId()).rejects.toThrow(/Failed to load the next VM ID: 500/);
  });

  it('listIsos / listContainerTemplates ask for their own content type', async () => {
    const fetchMock = stubFetch([{ volid: 'local:iso/a.iso', size: 3, ctime: 9 }]);
    await expect(listIsos('pve1', 'local')).resolves.toEqual([{ volid: 'local:iso/a.iso', size: 3, ctime: 9 }]);
    expect(fetchMock).toHaveBeenLastCalledWith('/api/pve/nodes/pve1/storage/local/content?content=iso');

    await listContainerTemplates('pve1', 'local');
    expect(fetchMock).toHaveBeenLastCalledWith('/api/pve/nodes/pve1/storage/local/content?content=vztmpl');
  });

  it('listStoragesWithContent reads the node storage listing for that content', async () => {
    const fetchMock = stubFetch([{ storage: 'local-zfs', type: 'zfspool', avail: 5 }]);
    await expect(listStoragesWithContent('pve1', 'rootdir')).resolves.toEqual([
      { id: 'local-zfs', plugintype: 'zfspool', freeBytes: 5 },
    ]);
    expect(fetchMock).toHaveBeenCalledWith('/api/pve/nodes/pve1/storage?content=rootdir');
  });

  it('listNodes reads the cluster resources', async () => {
    await expect(listNodes()).resolves.toEqual([
      { name: 'pve1', status: 'online' },
      { name: 'pve2', status: 'offline' },
    ]);
  });
});
