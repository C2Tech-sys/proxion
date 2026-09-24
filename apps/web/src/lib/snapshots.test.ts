import { describe, expect, it } from 'vitest';

import { buildSnapshotTree, flattenSnapshotTree } from '@/lib/snapshots';
import type { Snapshot } from '@/api/types';

describe('buildSnapshotTree', () => {
  it('returns just a NOW leaf when there are no real snapshots', () => {
    const tree = buildSnapshotTree([{ name: 'current' }]);
    expect(tree).toEqual([{ name: 'NOW', snapshot: null, depth: 0, children: [] }]);
  });

  it('builds a linear parent chain ending in NOW', () => {
    const snapshots: Snapshot[] = [
      { name: 'current' },
      { name: 'a', snaptime: 1 },
      { name: 'b', parent: 'a', snaptime: 2 },
      { name: 'c', parent: 'b', snaptime: 3 },
    ];
    const tree = buildSnapshotTree(snapshots);
    expect(tree).toHaveLength(1);
    expect(tree[0]!.name).toBe('a');
    expect(tree[0]!.depth).toBe(0);
    expect(tree[0]!.children[0]!.name).toBe('b');
    expect(tree[0]!.children[0]!.children[0]!.name).toBe('c');
    const leaf = tree[0]!.children[0]!.children[0]!;
    expect(leaf.children).toHaveLength(1);
    expect(leaf.children[0]).toMatchObject({ name: 'NOW', snapshot: null, depth: 3 });
  });

  it('sorts sibling branches by snaptime and attaches NOW under each leaf', () => {
    const snapshots: Snapshot[] = [
      { name: 'later', snaptime: 20 },
      { name: 'earlier', snaptime: 10 },
    ];
    const tree = buildSnapshotTree(snapshots);
    expect(tree.map((n) => n.name)).toEqual(['earlier', 'later']);
    expect(tree[0]!.children[0]!.name).toBe('NOW');
    expect(tree[1]!.children[0]!.name).toBe('NOW');
  });

  it('treats a snapshot with an unknown parent as a root', () => {
    const snapshots: Snapshot[] = [{ name: 'orphan', parent: 'ghost', snaptime: 1 }];
    const tree = buildSnapshotTree(snapshots);
    expect(tree).toHaveLength(1);
    expect(tree[0]!.name).toBe('orphan');
  });
});

describe('flattenSnapshotTree', () => {
  it('pre-order flattens nested branches', () => {
    const tree = buildSnapshotTree([
      { name: 'a', snaptime: 1 },
      { name: 'b', parent: 'a', snaptime: 2 },
    ]);
    const flat = flattenSnapshotTree(tree);
    expect(flat.map((n) => n.name)).toEqual(['a', 'b', 'NOW']);
  });
});
