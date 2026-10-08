import { USE_FIXTURES } from '@/api/client';
import { GuestActionError } from '@/api/actions';
import {
  applyFixtureNodeNetwork,
  createFixtureNetIface,
  deleteFixtureNetIface,
  getFixtureNodeNetwork,
  revertFixtureNodeNetwork,
  updateFixtureNetIface,
} from '@/api/fixtures';

/**
 * Node network editor (T69): the web side of `POST/PUT/DELETE /api/actions/node/:node/network[/:iface]`
 * and `POST .../apply|revert` (`apps/server/src/actions/nodeNetworkRoutes.ts`), plus the read of
 * `GET /nodes/{node}/network` through the read-only `/api/pve/*` proxy -- PVE puts the pending
 * diff in a top-level `changes` string beside `data`, and the proxy forwards the whole body.
 * Fixture mode is handled inline in each function (same convention as `network.ts`).
 */

export type NodeNetType = 'eth' | 'bridge' | 'bond' | 'vlan' | 'alias' | 'other';

/** One interface row, normalised from PVE's wire shape (booleans arrive as 1/0). */
export interface NodeNetIface {
  iface: string;
  type: NodeNetType;
  /** PVE's raw type string, for anything outside the four types this editor models. */
  rawType: string;
  method?: string;
  method6?: string;
  cidr?: string;
  gateway?: string;
  cidr6?: string;
  gateway6?: string;
  mtu?: number;
  comments?: string;
  autostart: boolean;
  active: boolean;
  vlanAware: boolean;
  bridgePorts?: string;
  slaves?: string;
  bondMode?: string;
  bondXmitHashPolicy?: string;
  bondPrimary?: string;
  vlanId?: number;
  vlanRawDevice?: string;
}

export interface NodeNetwork {
  ifaces: NodeNetIface[];
  /** PVE's pending-changes diff; empty when nothing is staged. */
  changes: string;
}

/** Fields shared by create and edit. */
export interface NetFieldsBody {
  autostart?: boolean;
  cidr?: string;
  gateway?: string;
  cidr6?: string;
  gateway6?: string;
  mtu?: number;
  comments?: string;
  bridge_ports?: string;
  bridge_vlan_aware?: boolean;
  slaves?: string;
  bond_mode?: string;
  bond_xmit_hash_policy?: string;
  'bond-primary'?: string;
  'vlan-id'?: number;
  'vlan-raw-device'?: string;
}

export interface CreateNetBody extends NetFieldsBody {
  type: 'bridge' | 'bond' | 'vlan';
  iface: string;
}

/** An edit sends only what changed; an explicit `null` clears the field (the server turns it into
 * PVE's `delete` list). */
export type UpdateNetBody = {
  [K in keyof NetFieldsBody]?: NetFieldsBody[K] | null;
};

export interface ApplyNetworkResult {
  upid: string;
}

interface NodeNetErrorBody {
  error?: string;
  message?: string;
  missing?: string;
}

function describeError(status: number, statusText: string, body: NodeNetErrorBody | undefined): string {
  if (body?.message) return body.message;
  switch (body?.error) {
    case 'writes-disabled-in-token-mode':
      return 'Read-only: signed in with a service token';
    case 'forbidden':
      return body?.missing ? `You don't have ${body.missing} on this node` : "You don't have permission for this";
    case 'not-found':
      return 'That interface no longer exists';
    case 'pve-unreachable':
      return 'Proxmox VE is unreachable';
    default:
      return body?.error ?? `Request failed: ${status} ${statusText}`;
  }
}

async function throwActionError(res: Response): Promise<never> {
  let errorBody: NodeNetErrorBody | undefined;
  try {
    errorBody = (await res.json()) as NodeNetErrorBody;
  } catch {
    errorBody = undefined;
  }
  throw new GuestActionError(res.status, describeError(res.status, res.statusText, errorBody));
}

/** Runs a fixture mutator, turning its plain `Error` into the same error the real client throws. */
function fixtureCall<T>(run: () => T): T {
  try {
    return run();
  } catch (error) {
    throw new GuestActionError(400, error instanceof Error ? error.message : 'The change was rejected');
  }
}

// --- parsing -----------------------------------------------------------------------------------

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && /^\d+$/.test(value)) return Number(value);
  return undefined;
}

function asFlag(value: unknown): boolean {
  return value === 1 || value === true || value === '1';
}

function normalizeType(raw: string): NodeNetType {
  switch (raw) {
    case 'eth':
    case 'bridge':
    case 'bond':
    case 'vlan':
    case 'alias':
      return raw;
    default:
      return 'other';
  }
}

/** One wire row -> `NodeNetIface`; `undefined` for a row with no interface name. */
export function parseNodeNetIface(raw: unknown): NodeNetIface | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const row = raw as Record<string, unknown>;
  const iface = asString(row.iface);
  if (iface === undefined) return undefined;
  const rawType = asString(row.type) ?? 'unknown';
  const out: NodeNetIface = {
    iface,
    type: normalizeType(rawType),
    rawType,
    autostart: asFlag(row.autostart),
    active: asFlag(row.active),
    vlanAware: asFlag(row.bridge_vlan_aware),
  };
  const optionalStrings = {
    method: row.method,
    method6: row.method6,
    cidr: row.cidr,
    gateway: row.gateway,
    cidr6: row.cidr6,
    gateway6: row.gateway6,
    comments: row.comments,
    bridgePorts: row.bridge_ports,
    slaves: row.slaves,
    bondMode: row.bond_mode,
    bondXmitHashPolicy: row.bond_xmit_hash_policy,
    bondPrimary: row['bond-primary'],
    vlanRawDevice: row['vlan-raw-device'],
  } as const;
  for (const [key, value] of Object.entries(optionalStrings)) {
    const text = asString(value);
    if (text !== undefined) (out as unknown as Record<string, unknown>)[key] = text;
  }
  const mtu = asNumber(row.mtu);
  if (mtu !== undefined) out.mtu = mtu;
  const vlanId = asNumber(row['vlan-id']);
  if (vlanId !== undefined) out.vlanId = vlanId;
  return out;
}

/** PVE's envelope (`{ data: [...], changes?: string }`) -> `NodeNetwork`. */
export function parseNodeNetwork(envelope: unknown): NodeNetwork {
  const body = (typeof envelope === 'object' && envelope !== null ? envelope : {}) as {
    data?: unknown;
    changes?: unknown;
  };
  const rows = Array.isArray(body.data) ? body.data : [];
  const ifaces = rows.map(parseNodeNetIface).filter((row): row is NodeNetIface => row !== undefined);
  return { ifaces, changes: typeof body.changes === 'string' ? body.changes : '' };
}

const TYPE_RANK: Record<NodeNetType, number> = { eth: 0, bridge: 1, bond: 2, vlan: 3, alias: 4, other: 5 };

/** The table order: physical interfaces first, then bridges (`vmbr*`), bonds, VLANs, the rest --
 * each group by name, numbers compared as numbers (`vmbr2` before `vmbr10`). */
export function sortNodeNetIfaces(ifaces: readonly NodeNetIface[]): NodeNetIface[] {
  return [...ifaces].sort(
    (a, b) =>
      TYPE_RANK[a.type] - TYPE_RANK[b.type] || a.iface.localeCompare(b.iface, undefined, { numeric: true }),
  );
}

// --- public API --------------------------------------------------------------------------------

/** `GET /nodes/{node}/network` through the read-only proxy (rows plus the pending `changes` diff). */
export async function getNodeNetwork(node: string): Promise<NodeNetwork> {
  if (USE_FIXTURES) {
    return parseNodeNetwork(getFixtureNodeNetwork(node));
  }

  const res = await fetch(`/api/pve/nodes/${encodeURIComponent(node)}/network`);
  if (!res.ok) throw new Error(`Failed to load the network configuration of ${node}: ${res.status}`);
  return parseNodeNetwork(await res.json());
}

/** Stages a new bridge/bond/VLAN: `POST /api/actions/node/:node/network`. */
export async function createNodeNetIface(node: string, body: CreateNetBody): Promise<void> {
  if (USE_FIXTURES) {
    fixtureCall(() => createFixtureNetIface(node, { autostart: true, ...body }));
    return;
  }

  const res = await fetch(`/api/actions/node/${encodeURIComponent(node)}/network`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (res.status === 200) return;
  return throwActionError(res);
}

/** Stages an edit: `PUT /api/actions/node/:node/network/:iface`. */
export async function updateNodeNetIface(node: string, iface: string, body: UpdateNetBody): Promise<void> {
  if (USE_FIXTURES) {
    fixtureCall(() => updateFixtureNetIface(node, iface, body));
    return;
  }

  const res = await fetch(`/api/actions/node/${encodeURIComponent(node)}/network/${encodeURIComponent(iface)}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (res.status === 200) return;
  return throwActionError(res);
}

/** Stages a deletion: `DELETE /api/actions/node/:node/network/:iface`. */
export async function deleteNodeNetIface(node: string, iface: string): Promise<void> {
  if (USE_FIXTURES) {
    fixtureCall(() => deleteFixtureNetIface(node, iface));
    return;
  }

  const res = await fetch(`/api/actions/node/${encodeURIComponent(node)}/network/${encodeURIComponent(iface)}`, {
    method: 'DELETE',
  });
  if (res.status === 200) return;
  return throwActionError(res);
}

/** Applies the staged configuration (can cut the node off): `POST .../network/apply` -> a task. */
export async function applyNodeNetwork(node: string): Promise<ApplyNetworkResult> {
  if (USE_FIXTURES) {
    applyFixtureNodeNetwork(node);
    return { upid: `UPID:${node}:0000A11E:00000000:00000000:srvreload:networking:root@pam:` };
  }

  const res = await fetch(`/api/actions/node/${encodeURIComponent(node)}/network/apply`, { method: 'POST' });
  if (res.status === 202) {
    return (await res.json()) as ApplyNetworkResult;
  }
  return throwActionError(res);
}

/** Discards the staged configuration: `POST .../network/revert`. */
export async function revertNodeNetwork(node: string): Promise<void> {
  if (USE_FIXTURES) {
    revertFixtureNodeNetwork(node);
    return;
  }

  const res = await fetch(`/api/actions/node/${encodeURIComponent(node)}/network/revert`, { method: 'POST' });
  if (res.status === 200) return;
  return throwActionError(res);
}
