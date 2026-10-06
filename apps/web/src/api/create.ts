import { USE_FIXTURES, api } from '@/api/client';
import { storagesWithContent, type DiskStorage, type StorageContentKind } from '@/api/disks';
import { getFixtureNextId } from '@/api/fixtures';
import type { ClusterResource } from '@/api/types';

/**
 * Shared reads for the "Create VM" / "Create CT" wizards: the next free vmid, the ISO images and
 * container templates on a storage, the storages on a node that can hold a given content type,
 * and the cluster's nodes. All are plain GETs through the read-only `/api/pve/*` proxy (PVE's
 * `{ data }` envelope is unwrapped here); fixture mode is handled inline in each function, same
 * convention as `disks.ts`/`actions.ts`.
 */

/** One ISO image or container template on a storage. */
export interface StorageMedia {
  /** Full volume id, e.g. `local:iso/debian-12.iso` -- what a create request takes. */
  volid: string;
  /** Size in bytes. */
  size: number;
  /** Creation time (unix seconds), when PVE reports one. */
  ctime?: number | undefined;
}

export interface CreateNode {
  name: string;
  /** `online` / `offline` / `unknown`, straight from the cluster resources. */
  status: string;
}

// --- pure helpers ---------------------------------------------------------------------------------

/** PVE answers `GET /cluster/nextid` with the id as a *string* (`{ data: "100" }`); a bare number is
 * accepted too. Anything that is not a positive integer is an error, never a silent `NaN`. */
export function parseNextId(data: unknown): number {
  const n = typeof data === 'number' ? data : typeof data === 'string' ? Number(data) : NaN;
  if (!Number.isInteger(n) || n < 1) throw new Error('Proxmox VE returned no usable next VM ID');
  return n;
}

/** Reads the `content=iso` / `content=vztmpl` listing: rows without a string `volid` are dropped,
 * a missing/non-numeric `size` counts as 0, a non-numeric `ctime` is left out. Rows whose own
 * `content` field disagrees with `content` are dropped too (the fixture listing is unfiltered). */
export function parseStorageMedia(data: unknown, content: 'iso' | 'vztmpl'): StorageMedia[] {
  if (!Array.isArray(data)) return [];
  const out: StorageMedia[] = [];
  for (const row of data as Array<Record<string, unknown>>) {
    if (row === null || typeof row !== 'object' || typeof row.volid !== 'string') continue;
    if (typeof row.content === 'string' && row.content !== content) continue;
    out.push({
      volid: row.volid,
      size: typeof row.size === 'number' ? row.size : 0,
      ctime: typeof row.ctime === 'number' ? row.ctime : undefined,
    });
  }
  return out;
}

/** Reads `GET /nodes/{node}/storage?content=...` rows (`storage`, `type`, `avail`) into the same
 * shape `storagesWithContent` produces from the cluster resources. */
export function parseNodeStorageRows(data: unknown): DiskStorage[] {
  if (!Array.isArray(data)) return [];
  const out: DiskStorage[] = [];
  for (const row of data as Array<Record<string, unknown>>) {
    if (row === null || typeof row !== 'object' || typeof row.storage !== 'string') continue;
    out.push({
      id: row.storage,
      plugintype: typeof row.type === 'string' ? row.type : undefined,
      freeBytes: typeof row.avail === 'number' ? Math.max(0, row.avail) : undefined,
    });
  }
  return out;
}

/** The cluster's nodes, name-sorted, from the cluster resources. */
export function nodesFromResources(resources: ClusterResource[] | undefined): CreateNode[] {
  const out: CreateNode[] = [];
  for (const r of resources ?? []) {
    if (r.type !== 'node') continue;
    out.push({ name: r.node, status: r.status });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

// --- reads ------------------------------------------------------------------------------------------

async function getPve(path: string, what: string): Promise<unknown> {
  const res = await fetch(`/api/pve/${path}`);
  if (!res.ok) throw new Error(`Failed to load ${what}: ${res.status}`);
  const envelope = (await res.json()) as { data?: unknown };
  return envelope.data;
}

/** The next free guest id (`GET /cluster/nextid`). Fixture mode: one past the highest fixture vmid. */
export async function getNextId(): Promise<number> {
  if (USE_FIXTURES) return getFixtureNextId();
  return parseNextId(await getPve('cluster/nextid', 'the next VM ID'));
}

async function listMedia(node: string, storage: string, content: 'iso' | 'vztmpl'): Promise<StorageMedia[]> {
  if (USE_FIXTURES) {
    return parseStorageMedia(await api.getStorageContent(node, storage), content);
  }
  const data = await getPve(
    `nodes/${encodeURIComponent(node)}/storage/${encodeURIComponent(storage)}/content?content=${content}`,
    `${content === 'iso' ? 'ISO images' : 'container templates'} on ${storage}`,
  );
  return parseStorageMedia(data, content);
}

/** ISO images on one storage (`.../content?content=iso`). */
export function listIsos(node: string, storage: string): Promise<StorageMedia[]> {
  return listMedia(node, storage, 'iso');
}

/** Container templates on one storage (`.../content?content=vztmpl`). */
export function listContainerTemplates(node: string, storage: string): Promise<StorageMedia[]> {
  return listMedia(node, storage, 'vztmpl');
}

/** The storages on `node` that can hold `content` (`GET /nodes/{node}/storage?content=...`). Fixture
 * mode derives them from the fixture cluster resources with `storagesWithContent`. */
export async function listStoragesWithContent(node: string, content: StorageContentKind): Promise<DiskStorage[]> {
  if (USE_FIXTURES) {
    return storagesWithContent(await api.getClusterResources(), node, content);
  }
  return parseNodeStorageRows(
    await getPve(`nodes/${encodeURIComponent(node)}/storage?content=${content}`, `storages on ${node}`),
  );
}

/** The cluster's nodes (name, status), from the cluster resources. */
export async function listNodes(): Promise<CreateNode[]> {
  return nodesFromResources(await api.getClusterResources());
}
