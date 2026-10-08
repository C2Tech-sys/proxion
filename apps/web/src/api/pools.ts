import { USE_FIXTURES } from '@/api/client';
import { GuestActionError } from '@/api/actions';
import {
  addFixturePool,
  getFixturePools,
  removeFixturePool,
  updateFixturePool,
} from '@/api/fixtures';

/**
 * Datacenter -> Pools (T70): the web side of `POST /api/actions/datacenter/pools`,
 * `PUT|DELETE .../pools/:poolid` (`apps/server/src/actions/poolRoutes.ts`) plus the pool list and
 * members through the read-only `/api/pve/*` proxy. Fixture mode is handled inline in each
 * function (same convention as `network.ts`).
 */

export interface PoolMember {
  type: 'qemu' | 'lxc' | 'storage';
  /** `qemu/100`, `lxc/200` or `storage/<node>/<storage>`. */
  id: string;
  node: string;
  vmid?: number | undefined;
  storage?: string | undefined;
}

export interface Pool {
  poolid: string;
  comment?: string | undefined;
  members: PoolMember[];
}

/** The `PUT` body: matches the server route's strict schema. `remove` takes the listed members
 * out instead of adding them; `allow-move` adds guests that already belong to another pool. */
export interface PoolUpdateBody {
  comment?: string;
  vms?: number[];
  storage?: string[];
  remove?: boolean;
  'allow-move'?: boolean;
}

interface PoolErrorBody {
  error?: string;
  message?: string;
  missing?: string;
}

function describeError(status: number, statusText: string, body: PoolErrorBody | undefined): string {
  if (body?.message) return body.message;
  switch (body?.error) {
    case 'writes-disabled-in-token-mode':
      return 'Read-only: signed in with a service token';
    case 'forbidden':
      return body?.missing ? `You don't have ${body.missing} on this pool` : "You don't have permission for this";
    case 'pve-unreachable':
      return 'Proxmox VE is unreachable';
    default:
      return body?.error ?? `Request failed: ${status} ${statusText}`;
  }
}

async function throwActionError(res: Response): Promise<never> {
  let errorBody: PoolErrorBody | undefined;
  try {
    errorBody = (await res.json()) as PoolErrorBody;
  } catch {
    errorBody = undefined;
  }
  throw new GuestActionError(res.status, describeError(res.status, res.statusText, errorBody));
}

function fixtureCall<T>(fn: () => T): T {
  try {
    return fn();
  } catch (error) {
    throw new GuestActionError(400, error instanceof Error ? error.message : 'Request failed');
  }
}

function normalizeMembers(raw: unknown): PoolMember[] {
  if (!Array.isArray(raw)) return [];
  const members: PoolMember[] = [];
  for (const row of raw as Array<Record<string, unknown>>) {
    const type = row.type === 'openvz' ? 'lxc' : row.type;
    if ((type !== 'qemu' && type !== 'lxc' && type !== 'storage') || typeof row.id !== 'string') continue;
    members.push({
      type,
      id: row.id,
      node: typeof row.node === 'string' ? row.node : '',
      ...(typeof row.vmid === 'number' ? { vmid: row.vmid } : {}),
      ...(typeof row.storage === 'string' ? { storage: row.storage } : {}),
    });
  }
  return members;
}

/**
 * The pools with their members. `GET /pools` through the read-only proxy; PVE 8.1+ includes the
 * members in the list only when asked per pool, so a row without them is completed from
 * `GET /pools/{poolid}`.
 */
export async function getPools(): Promise<Pool[]> {
  if (USE_FIXTURES) {
    return getFixturePools().map((p) => ({ poolid: p.poolid, comment: p.comment, members: p.members }));
  }
  const res = await fetch('/api/pve/pools');
  if (!res.ok) throw new Error(`Failed to load pools: ${res.status}`);
  const envelope = (await res.json()) as { data?: unknown };
  if (!Array.isArray(envelope.data)) return [];
  const rows = (envelope.data as Array<Record<string, unknown>>).filter((r) => typeof r.poolid === 'string');
  const pools = await Promise.all(
    rows.map(async (row): Promise<Pool> => {
      const poolid = row.poolid as string;
      const comment = typeof row.comment === 'string' && row.comment !== '' ? row.comment : undefined;
      if (Array.isArray(row.members)) return { poolid, comment, members: normalizeMembers(row.members) };
      const detail = await fetch(`/api/pve/pools/${encodeURIComponent(poolid)}`);
      if (!detail.ok) throw new Error(`Failed to load pool ${poolid}: ${detail.status}`);
      const detailEnvelope = (await detail.json()) as { data?: { members?: unknown } };
      return { poolid, comment, members: normalizeMembers(detailEnvelope.data?.members) };
    }),
  );
  return pools.sort((a, b) => a.poolid.localeCompare(b.poolid));
}

/** Creates a pool: `POST /api/actions/datacenter/pools`. */
export async function createPool(poolid: string, comment?: string): Promise<{ ok: true; poolid: string }> {
  if (USE_FIXTURES) {
    return fixtureCall(() => {
      addFixturePool(poolid, comment);
      return { ok: true as const, poolid };
    });
  }
  const res = await fetch('/api/actions/datacenter/pools', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ poolid, ...(comment !== undefined && comment !== '' ? { comment } : {}) }),
  });
  if (res.status === 200) return (await res.json()) as { ok: true; poolid: string };
  return throwActionError(res);
}

/** Changes the comment and/or the members: `PUT /api/actions/datacenter/pools/:poolid`. */
export async function updatePool(poolid: string, body: PoolUpdateBody): Promise<{ ok: true; poolid: string }> {
  if (USE_FIXTURES) {
    return fixtureCall(() => {
      updateFixturePool(poolid, {
        comment: body.comment,
        vms: body.vms,
        storage: body.storage,
        remove: body.remove,
        allowMove: body['allow-move'],
      });
      return { ok: true as const, poolid };
    });
  }
  const res = await fetch(`/api/actions/datacenter/pools/${encodeURIComponent(poolid)}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (res.status === 200) return (await res.json()) as { ok: true; poolid: string };
  return throwActionError(res);
}

/** Deletes an (empty) pool: `DELETE /api/actions/datacenter/pools/:poolid`. */
export async function deletePool(poolid: string): Promise<{ ok: true }> {
  if (USE_FIXTURES) {
    return fixtureCall(() => {
      removeFixturePool(poolid);
      return { ok: true as const };
    });
  }
  const res = await fetch(`/api/actions/datacenter/pools/${encodeURIComponent(poolid)}`, { method: 'DELETE' });
  if (res.status === 200) return (await res.json()) as { ok: true };
  return throwActionError(res);
}
