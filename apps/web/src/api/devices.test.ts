import { afterEach, describe, expect, it, vi } from 'vitest';

import { listHostPci, listHostUsb, listPciMappings, listUsbMappings } from '@/api/devices';

// Real mode: `apps/web/.env.test` turns fixtures on for the whole suite, and `USE_FIXTURES` is
// read once at module scope, so it is mocked off here (same pattern as `disks.test.ts`). The
// fixture branches are covered by the Hardware tab's render tests.
vi.mock('@/api/client', async () => {
  const actual = await vi.importActual<typeof import('@/api/client')>('@/api/client');
  return { ...actual, USE_FIXTURES: false };
});

function stubFetch(status: number, body: unknown) {
  const fetchMock = vi.fn().mockImplementation(() => Promise.resolve(new Response(JSON.stringify(body), { status })));
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

afterEach(() => vi.unstubAllGlobals());

describe('listHostUsb (real mode)', () => {
  it('calls exactly the node hardware/usb proxy path', async () => {
    const fetchMock = stubFetch(200, { data: [] });
    await listHostUsb('pve1');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith('/api/pve/nodes/pve1/hardware/usb');
  });

  it('maps PVE-shaped rows to the picker rows, dropping rows without a vendor/product id', async () => {
    stubFetch(200, {
      data: [
        {
          busnum: 1,
          devnum: 4,
          vendid: '046d',
          prodid: 'c52b',
          product: 'Unifying Receiver',
          manufacturer: 'Logitech, Inc.',
          usbpath: '1-2',
          port: 1,
          speed: 12,
          level: 1,
          class: 0,
        },
        // empty strings are treated as absent; a non-numeric speed is dropped
        { busnum: 2, devnum: 1, vendid: '1d6b', prodid: '0003', product: '', manufacturer: '', usbpath: '', port: 0, speed: '5000' },
        // no vendor id / no product id: not selectable as `host=vendid:prodid`
        { busnum: 3, devnum: 1, prodid: '0001', product: 'No vendor' },
        { busnum: 3, devnum: 2, vendid: '1234' },
      ],
    });

    await expect(listHostUsb('pve1')).resolves.toStrictEqual({
      items: [
        {
          id: '046d:c52b',
          vendid: '046d',
          prodid: 'c52b',
          manufacturer: 'Logitech, Inc.',
          product: 'Unifying Receiver',
          usbpath: '1-2',
          speed: 12,
        },
        { id: '1d6b:0003', vendid: '1d6b', prodid: '0003' },
      ],
      forbidden: false,
    });
  });

  it('returns an empty, not-forbidden list when data is not an array', async () => {
    stubFetch(200, { data: null });
    await expect(listHostUsb('pve1')).resolves.toStrictEqual({ items: [], forbidden: false });
  });

  it('turns a 403 (no Sys.Modify) into { items: [], forbidden: true }', async () => {
    stubFetch(403, { error: 'forbidden' });
    await expect(listHostUsb('pve1')).resolves.toStrictEqual({ items: [], forbidden: true });
  });

  it('throws on a 500', async () => {
    stubFetch(500, { error: 'pve-unreachable' });
    await expect(listHostUsb('pve1')).rejects.toThrow('Failed to load USB devices for pve1: 500');
  });
});

describe('listHostPci (real mode)', () => {
  it('calls exactly the node hardware/pci proxy path', async () => {
    const fetchMock = stubFetch(200, { data: [] });
    await listHostPci('pve2');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith('/api/pve/nodes/pve2/hardware/pci');
  });

  it('maps PVE-shaped rows, sorted by IOMMU group then id, with -1 for a missing group', async () => {
    stubFetch(200, {
      data: [
        { id: '0000:03:00.0', class: '0x010802', vendor_name: 'Samsung', device_name: 'NVMe SSD', iommugroup: 2, mdev: 0 },
        { id: '0000:01:00.1', class: '0x040300', vendor_name: 'NVIDIA', device_name: 'HD Audio', iommugroup: 1 },
        { id: '0000:01:00.0', class: '0x030000', vendor_name: 'NVIDIA', device_name: 'RTX 3090', iommugroup: 1 },
        { id: '0000:00:1f.0', class: '', vendor_name: '', device_name: '' },
        { class: '0x0c0330', vendor_name: 'No id' },
      ],
    });

    await expect(listHostPci('pve1')).resolves.toStrictEqual({
      items: [
        { id: '0000:00:1f.0', iommugroup: -1 },
        { id: '0000:01:00.0', class: '0x030000', vendor_name: 'NVIDIA', device_name: 'RTX 3090', iommugroup: 1 },
        { id: '0000:01:00.1', class: '0x040300', vendor_name: 'NVIDIA', device_name: 'HD Audio', iommugroup: 1 },
        { id: '0000:03:00.0', class: '0x010802', vendor_name: 'Samsung', device_name: 'NVMe SSD', iommugroup: 2 },
      ],
      forbidden: false,
    });
  });

  it('turns a 403 into forbidden and throws on a 500', async () => {
    stubFetch(403, {});
    await expect(listHostPci('pve1')).resolves.toStrictEqual({ items: [], forbidden: true });
    stubFetch(500, {});
    await expect(listHostPci('pve1')).rejects.toThrow('Failed to load PCI devices for pve1: 500');
  });
});

describe('listUsbMappings / listPciMappings (real mode)', () => {
  const rows = [
    { id: 'zeta', description: 'Last', map: [{ node: 'pve1', path: '1-2', id: '046d:c52b' }] },
    { id: 'alpha', description: '', map: [] },
    { description: 'no id', map: [] },
    { id: 'mid', map: [{ node: 'pve1', path: '0000:01:00.0', id: '10de:2204' }] },
  ];
  const expected = [{ id: 'alpha' }, { id: 'mid' }, { id: 'zeta', description: 'Last' }];

  it('listUsbMappings calls the cluster usb mapping path and maps id/description, sorted by id', async () => {
    const fetchMock = stubFetch(200, { data: rows });
    await expect(listUsbMappings()).resolves.toStrictEqual({ items: expected, forbidden: false });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith('/api/pve/cluster/mapping/usb');
  });

  it('listPciMappings calls the cluster pci mapping path and maps id/description, sorted by id', async () => {
    const fetchMock = stubFetch(200, { data: rows });
    await expect(listPciMappings()).resolves.toStrictEqual({ items: expected, forbidden: false });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith('/api/pve/cluster/mapping/pci');
  });

  it('a 403 (no Mapping.Audit) is forbidden for both and a 500 throws for both', async () => {
    stubFetch(403, {});
    await expect(listUsbMappings()).resolves.toStrictEqual({ items: [], forbidden: true });
    await expect(listPciMappings()).resolves.toStrictEqual({ items: [], forbidden: true });
    stubFetch(500, {});
    await expect(listUsbMappings()).rejects.toThrow('Failed to load USB mappings: 500');
    await expect(listPciMappings()).rejects.toThrow('Failed to load PCI mappings: 500');
  });
});
