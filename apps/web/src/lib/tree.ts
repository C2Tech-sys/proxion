import type { ClusterResource, GuestType } from '@/api/types';
import { parseTags } from '@/lib/format';

export interface GuestNode {
  kind: 'guest';
  id: string;
  vmid: number;
  name: string;
  type: GuestType;
  node: string;
  status: string;
  template: boolean;
  tags: string[];
}

export interface NodeNode {
  kind: 'node';
  id: string;
  name: string;
  status: string;
  children: GuestNode[];
}

export interface DatacenterNode {
  kind: 'datacenter';
  id: string;
  name: string;
  children: NodeNode[];
}

/** Groups flat /cluster/resources rows into Datacenter -> Node -> Guest[]. */
export function buildInventoryTree(resources: ClusterResource[]): DatacenterNode {
  const nodeResources = resources.filter((r) => r.type === 'node');
  const guestResources = resources.filter((r) => r.type === 'qemu' || r.type === 'lxc');

  const nodes: NodeNode[] = nodeResources
    .map((n) => ({
      kind: 'node' as const,
      id: n.id,
      name: n.node,
      status: n.status,
      children: guestResources
        .filter((g) => g.node === n.node)
        .map((g) => guestResourceToNode(g))
        .sort((a, b) => a.vmid - b.vmid),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));

  return {
    kind: 'datacenter',
    id: 'datacenter',
    name: 'Datacenter',
    children: nodes,
  };
}

function guestResourceToNode(g: ClusterResource): GuestNode {
  return {
    kind: 'guest',
    id: g.id,
    vmid: g.vmid ?? 0,
    name: g.name ?? `${g.type}/${g.vmid ?? ''}`,
    type: g.type as GuestType,
    node: g.node,
    status: g.status,
    template: g.template === 1,
    tags: parseTags(g.tags),
  };
}

/** Case-insensitive match against a guest's name, VMID, or tags. */
function guestMatches(guest: GuestNode, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return (
    guest.name.toLowerCase().includes(q) ||
    String(guest.vmid).includes(q) ||
    guest.tags.some((t) => t.toLowerCase().includes(q))
  );
}

/**
 * Returns a filtered copy of the tree keeping only guests that match `query`
 * (by name, VMID or tag) and the node/datacenter ancestors of any match.
 * An empty query returns the tree unchanged.
 */
export function filterTree(tree: DatacenterNode, query: string): DatacenterNode {
  if (!query.trim()) return tree;
  const children = tree.children
    .map((node) => ({
      ...node,
      children: node.children.filter((guest) => guestMatches(guest, query)),
    }))
    .filter((node) => node.children.length > 0 || node.name.toLowerCase().includes(query.trim().toLowerCase()));

  return { ...tree, children };
}

export interface FlatSearchItem {
  id: string;
  kind: 'node' | 'guest' | 'storage';
  label: string;
  sublabel: string;
  node: string;
  vmid?: number | undefined;
  type?: GuestType | 'storage' | undefined;
}

/** Flattens cluster resources into a single searchable list for the command palette. */
export function toSearchItems(resources: ClusterResource[]): FlatSearchItem[] {
  const items: FlatSearchItem[] = [];
  for (const r of resources) {
    if (r.type === 'node') {
      items.push({ id: r.id, kind: 'node', label: r.node, sublabel: 'Node', node: r.node });
    } else if (r.type === 'qemu' || r.type === 'lxc') {
      items.push({
        id: r.id,
        kind: 'guest',
        label: r.name ?? String(r.vmid),
        sublabel: `${r.type.toUpperCase()} ${r.vmid} on ${r.node}`,
        node: r.node,
        vmid: r.vmid,
        type: r.type,
      });
    } else if (r.type === 'storage') {
      items.push({
        id: r.id,
        kind: 'storage',
        label: r.storage ?? 'storage',
        sublabel: `Storage on ${r.node}`,
        node: r.node,
        type: 'storage',
      });
    }
  }
  return items;
}
