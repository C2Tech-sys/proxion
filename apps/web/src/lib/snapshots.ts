import type { Snapshot } from '@/api/types';

export interface SnapshotTreeNode {
  /** The snapshot name, or the literal `"NOW"` for the synthetic live-state leaf. */
  name: string;
  /** `null` for the synthetic "NOW" leaf; the real snapshot row otherwise. */
  snapshot: Snapshot | null;
  depth: number;
  children: SnapshotTreeNode[];
}

function nowNode(depth: number): SnapshotTreeNode {
  return { name: 'NOW', snapshot: null, depth, children: [] };
}

/**
 * Builds the parent-chain tree PVE's Snapshots tab shows from the flat `/snapshot` list.
 * PVE always includes a `name: "current"` row representing the live VM/CT state; that row is
 * dropped from the tree and a synthetic "NOW" leaf is attached under every branch tip instead
 * (the tip with no snapshot children), matching PVE's own "You are here!" placement. A
 * snapshot whose declared `parent` isn't in the list (e.g. it was since deleted) is treated as
 * a root rather than dropped.
 */
export function buildSnapshotTree(snapshots: Snapshot[]): SnapshotTreeNode[] {
  const real = snapshots.filter((s) => s.name !== 'current');
  const names = new Set(real.map((s) => s.name));
  const childrenByParent = new Map<string | undefined, Snapshot[]>();
  for (const s of real) {
    const parentKey = s.parent && names.has(s.parent) ? s.parent : undefined;
    const list = childrenByParent.get(parentKey) ?? [];
    list.push(s);
    childrenByParent.set(parentKey, list);
  }

  function buildChildren(parentKey: string | undefined, depth: number): SnapshotTreeNode[] {
    const kids = [...(childrenByParent.get(parentKey) ?? [])].sort(
      (a, b) => (a.snaptime ?? 0) - (b.snaptime ?? 0),
    );
    return kids.map((s) => {
      const children = buildChildren(s.name, depth + 1);
      return {
        name: s.name,
        snapshot: s,
        depth,
        children: children.length > 0 ? children : [nowNode(depth + 1)],
      };
    });
  }

  const roots = buildChildren(undefined, 0);
  return roots.length > 0 ? roots : [nowNode(0)];
}

/** Pre-order-flattens a snapshot tree into the row list a table/list view renders. */
export function flattenSnapshotTree(nodes: SnapshotTreeNode[]): SnapshotTreeNode[] {
  const out: SnapshotTreeNode[] = [];
  for (const node of nodes) {
    out.push(node);
    out.push(...flattenSnapshotTree(node.children));
  }
  return out;
}
