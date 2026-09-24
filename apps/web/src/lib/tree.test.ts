import { describe, expect, it } from 'vitest';
import { buildInventoryTree, filterTree } from './tree';
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
    tags: 'prod;web',
  },
  {
    id: 'qemu/101',
    type: 'qemu',
    node: 'pve1',
    vmid: 101,
    name: 'db-prod-01',
    status: 'stopped',
    tags: 'prod;db',
  },
  {
    id: 'lxc/200',
    type: 'lxc',
    node: 'pve1',
    vmid: 200,
    name: 'caddy-proxy',
    status: 'running',
    tags: 'lab',
  },
  { id: 'storage/pve1/local', type: 'storage', node: 'pve1', status: 'available', storage: 'local' },
];

describe('buildInventoryTree', () => {
  it('groups guests under their node, ignoring storage rows', () => {
    const tree = buildInventoryTree(resources);
    expect(tree.children).toHaveLength(1);
    const node = tree.children[0]!;
    expect(node.name).toBe('pve1');
    expect(node.children).toHaveLength(3);
    expect(node.children.map((g) => g.vmid)).toEqual([100, 101, 200]);
  });

  it('sorts guests by vmid ascending', () => {
    const tree = buildInventoryTree(resources);
    const vmids = tree.children[0]!.children.map((g) => g.vmid);
    expect(vmids).toEqual([...vmids].sort((a, b) => a - b));
  });
});

describe('filterTree', () => {
  it('returns the tree unchanged for an empty query', () => {
    const tree = buildInventoryTree(resources);
    expect(filterTree(tree, '')).toEqual(tree);
  });

  it('filters guests by name substring, case-insensitively', () => {
    const tree = buildInventoryTree(resources);
    const filtered = filterTree(tree, 'WEB');
    expect(filtered.children[0]!.children.map((g) => g.name)).toEqual(['web-prod-01']);
  });

  it('filters guests by VMID', () => {
    const tree = buildInventoryTree(resources);
    const filtered = filterTree(tree, '200');
    expect(filtered.children[0]!.children.map((g) => g.name)).toEqual(['caddy-proxy']);
  });

  it('filters guests by tag', () => {
    const tree = buildInventoryTree(resources);
    const filtered = filterTree(tree, 'db');
    expect(filtered.children[0]!.children.map((g) => g.name)).toEqual(['db-prod-01']);
  });

  it('drops nodes with no matching guests', () => {
    const tree = buildInventoryTree(resources);
    const filtered = filterTree(tree, 'nonexistent-guest');
    expect(filtered.children).toHaveLength(0);
  });
});
