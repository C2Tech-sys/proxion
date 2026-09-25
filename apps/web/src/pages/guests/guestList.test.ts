import { describe, expect, it } from 'vitest';

import {
  DEFAULT_GUESTS_SEARCH_STATE,
  filterGuestRows,
  hasReportedDiskUsage,
  guestNodeNames,
  parseGuestsSearch,
  resolveVisibleColumns,
  sortGuestRows,
  toGuestRows,
  toGuestsSearch,
  type GuestRow,
} from './guestList';
import type { ClusterResource } from '@/api/types';

const resources: ClusterResource[] = [
  { id: 'node/pve1', type: 'node', node: 'pve1', status: 'online' },
  {
    id: 'qemu/100',
    type: 'qemu',
    node: 'pve1',
    vmid: 100,
    name: 'web-prod-01',
    status: 'running',
    template: 0,
    cpu: 0.5,
    maxcpu: 4,
    mem: 2_000_000_000,
    maxmem: 4_000_000_000,
    disk: 0,
    maxdisk: 32_000_000_000,
    uptime: 100_000,
    tags: 'prod;web',
  },
  {
    id: 'qemu/101',
    type: 'qemu',
    node: 'pve1',
    vmid: 101,
    name: 'db-prod-01',
    status: 'stopped',
    template: 0,
    cpu: 0,
    maxcpu: 8,
    mem: 0,
    maxmem: 8_000_000_000,
    disk: 0,
    maxdisk: 64_000_000_000,
    uptime: 0,
    tags: 'prod;db',
  },
  {
    id: 'lxc/200',
    type: 'lxc',
    node: 'pve2',
    vmid: 200,
    name: 'caddy-proxy',
    status: 'running',
    template: 0,
    cpu: 0.1,
    maxcpu: 2,
    mem: 500_000_000,
    maxmem: 1_000_000_000,
    disk: 2_000_000_000,
    maxdisk: 8_000_000_000,
    uptime: 50_000,
    tags: 'lab',
  },
  {
    id: 'qemu/999',
    type: 'qemu',
    node: 'pve1',
    vmid: 999,
    name: 'tpl-ubuntu-2404',
    status: 'stopped',
    template: 1,
    tags: '',
  },
  { id: 'storage/pve1/local', type: 'storage', node: 'pve1', status: 'available', storage: 'local' },
];

describe('toGuestRows', () => {
  it('keeps only qemu/lxc rows, dropping nodes and storage', () => {
    const rows = toGuestRows(resources);
    expect(rows).toHaveLength(4);
    expect(rows.map((r) => r.vmid).sort((a, b) => a - b)).toEqual([100, 101, 200, 999]);
  });

  it('marks a template guest', () => {
    const rows = toGuestRows(resources);
    expect(rows.find((r) => r.vmid === 999)?.template).toBe(true);
  });
});

describe('hasReportedDiskUsage', () => {
  it('is true for lxc, false for qemu (PVE never reports qemu disk usage)', () => {
    expect(hasReportedDiskUsage({ type: 'lxc' })).toBe(true);
    expect(hasReportedDiskUsage({ type: 'qemu' })).toBe(false);
  });
});

describe('guestNodeNames', () => {
  it('returns the distinct, sorted node names guests are on', () => {
    const rows = toGuestRows(resources);
    expect(guestNodeNames(rows)).toEqual(['pve1', 'pve2']);
  });
});

describe('filterGuestRows', () => {
  const rows = toGuestRows(resources);

  it('matches by name, VMID, tag or node (same matcher as the inventory rail)', () => {
    expect(filterGuestRows(rows, { ...DEFAULT_GUESTS_SEARCH_STATE, q: 'WEB' }).map((r) => r.name)).toEqual([
      'web-prod-01',
    ]);
    expect(filterGuestRows(rows, { ...DEFAULT_GUESTS_SEARCH_STATE, q: '200' }).map((r) => r.name)).toEqual([
      'caddy-proxy',
    ]);
    expect(filterGuestRows(rows, { ...DEFAULT_GUESTS_SEARCH_STATE, q: 'db' }).map((r) => r.name)).toEqual([
      'db-prod-01',
    ]);
    expect(filterGuestRows(rows, { ...DEFAULT_GUESTS_SEARCH_STATE, q: 'pve2' }).map((r) => r.name)).toEqual([
      'caddy-proxy',
    ]);
  });

  it('filters by status', () => {
    expect(
      filterGuestRows(rows, { ...DEFAULT_GUESTS_SEARCH_STATE, status: 'running' }).map((r) => r.name).sort(),
    ).toEqual(['caddy-proxy', 'web-prod-01']);
  });

  it('"template" status filter matches only template guests, regardless of their PVE status', () => {
    expect(filterGuestRows(rows, { ...DEFAULT_GUESTS_SEARCH_STATE, status: 'template' }).map((r) => r.name)).toEqual([
      'tpl-ubuntu-2404',
    ]);
  });

  it('filters by type', () => {
    expect(filterGuestRows(rows, { ...DEFAULT_GUESTS_SEARCH_STATE, type: 'lxc' }).map((r) => r.name)).toEqual([
      'caddy-proxy',
    ]);
  });

  it('filters by node', () => {
    expect(
      filterGuestRows(rows, { ...DEFAULT_GUESTS_SEARCH_STATE, node: 'pve1' }).map((r) => r.vmid).sort((a, b) => a - b),
    ).toEqual([100, 101, 999]);
  });

  it('combines filters', () => {
    expect(
      filterGuestRows(rows, { q: '', status: 'running', type: 'qemu', node: 'pve1' }).map((r) => r.name),
    ).toEqual(['web-prod-01']);
  });
});

describe('sortGuestRows', () => {
  const rows = toGuestRows(resources);

  it('sorts by name, locale-compared', () => {
    expect(sortGuestRows(rows, 'name', 'asc').map((r) => r.name)).toEqual([
      'caddy-proxy',
      'db-prod-01',
      'tpl-ubuntu-2404',
      'web-prod-01',
    ]);
    expect(sortGuestRows(rows, 'name', 'desc').map((r) => r.name)).toEqual([
      'web-prod-01',
      'tpl-ubuntu-2404',
      'db-prod-01',
      'caddy-proxy',
    ]);
  });

  it('sorts by vmid ascending/descending', () => {
    expect(sortGuestRows(rows, 'vmid', 'asc').map((r) => r.vmid)).toEqual([100, 101, 200, 999]);
    expect(sortGuestRows(rows, 'vmid', 'desc').map((r) => r.vmid)).toEqual([999, 200, 101, 100]);
  });

  it('sorts by memory using the used fraction, with stopped guests always after running ones', () => {
    // web-prod-01: 50% used, running. caddy-proxy: 50% used, running. db-prod-01: 0% used, but
    // STOPPED -- so it sorts after both running guests regardless of direction. tpl-ubuntu-2404
    // has no mem/maxmem at all (0/0 -> 0 fraction) and is also stopped.
    const asc = sortGuestRows(rows, 'mem', 'asc').map((r) => r.name);
    expect(asc.slice(0, 2).sort()).toEqual(['caddy-proxy', 'web-prod-01']);
    expect(asc.slice(2)).toEqual(expect.arrayContaining(['db-prod-01', 'tpl-ubuntu-2404']));

    const desc = sortGuestRows(rows, 'mem', 'desc').map((r) => r.name);
    expect(desc.slice(0, 2).sort()).toEqual(['caddy-proxy', 'web-prod-01']);
    expect(desc.slice(2)).toEqual(expect.arrayContaining(['db-prod-01', 'tpl-ubuntu-2404']));
  });

  it('sorts by cpu using the used fraction, stopped guests after running', () => {
    const desc = sortGuestRows(rows, 'cpu', 'desc').map((r) => r.name);
    // web-prod-01 (50%) then caddy-proxy (10%) -- both running -- before either stopped guest.
    expect(desc.slice(0, 2)).toEqual(['web-prod-01', 'caddy-proxy']);
  });

  it('sorts by uptime, stopped guests after running', () => {
    const desc = sortGuestRows(rows, 'uptime', 'desc').map((r) => r.name);
    expect(desc.slice(0, 2)).toEqual(['web-prod-01', 'caddy-proxy']);
  });

  it('does not mutate its input array', () => {
    const copy = [...rows];
    sortGuestRows(rows, 'name', 'desc');
    expect(rows).toEqual(copy);
  });
});

describe('toGuestsSearch / parseGuestsSearch', () => {
  it('omits every field at its default', () => {
    expect(toGuestsSearch(DEFAULT_GUESTS_SEARCH_STATE)).toEqual({});
  });

  it('keeps only the fields that differ from default', () => {
    expect(
      toGuestsSearch({ ...DEFAULT_GUESTS_SEARCH_STATE, status: 'running', type: 'qemu', sort: 'mem', dir: 'desc' }),
    ).toEqual({ status: 'running', type: 'qemu', sort: 'mem', dir: 'desc' });
  });

  it('parses raw URL search params, defaulting anything missing/invalid', () => {
    expect(parseGuestsSearch({})).toEqual({});
    expect(parseGuestsSearch({ status: 'bogus', type: 'qemu' })).toEqual({ type: 'qemu' });
    expect(parseGuestsSearch({ q: 'web', sort: 'mem', dir: 'desc' })).toEqual({
      q: 'web',
      sort: 'mem',
      dir: 'desc',
    });
  });
});

describe('resolveVisibleColumns', () => {
  it('shows every column when nothing is saved', () => {
    const visible = resolveVisibleColumns(undefined);
    expect(visible.has('cpu')).toBe(true);
    expect(visible.has('tags')).toBe(true);
    expect(visible.has('ha')).toBe(true);
  });

  it('shows exactly the saved columns otherwise', () => {
    const visible = resolveVisibleColumns(['cpu', 'mem']);
    expect(visible.has('cpu')).toBe(true);
    expect(visible.has('mem')).toBe(true);
    expect(visible.has('tags')).toBe(false);
    expect(visible.has('uptime')).toBe(false);
  });

  it('drops an id it no longer recognizes rather than throwing', () => {
    const visible = resolveVisibleColumns(['cpu', 'some-retired-column']);
    expect([...visible]).toEqual(['cpu']);
  });

  it('an empty saved list hides every optional column', () => {
    expect(resolveVisibleColumns([]).size).toBe(0);
  });
});

describe('GuestRow shape', () => {
  it('is structurally compatible with what the search matcher needs', () => {
    const [row] = toGuestRows(resources);
    const guest: GuestRow = row!;
    expect(typeof guest.name).toBe('string');
    expect(typeof guest.vmid).toBe('number');
    expect(Array.isArray(guest.tags)).toBe(true);
    expect(typeof guest.node).toBe('string');
  });
});
