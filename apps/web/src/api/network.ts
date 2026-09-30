import { USE_FIXTURES } from '@/api/client';
import { GuestActionError } from '@/api/actions';
import { getFixtureGuestByVmid, getFixtureGuestConfig, patchFixtureGuestConfig } from '@/api/fixtures';
import { nextFreeNetSlot, parseNicConfig } from '@/lib/pve-config';
import type { GuestType } from '@/api/types';

/**
 * Guest network devices (T50): the web side of `PUT/DELETE .../network/:slot` and
 * `GET .../network/next-slot` (`apps/server/src/actions/networkRoutes.ts`) plus the read-only
 * bridge lookup the NIC dialog's bridge picker needs (via the read-only `/api/pve/*` proxy).
 * Fixture mode is handled inline in each function (same convention as `hardware.ts`).
 */

/** Body for `upsertNic`: the FULL desired state of the device. Matches the server route's own
 * contract -- on an existing slot every field left out is dropped, except `mac` (qemu) which keeps
 * the device's current address when omitted. qemu-only and lxc-only fields are rejected for the
 * wrong guest type. */
export interface NicBody {
  /** qemu only. */
  model?: string;
  /** lxc only: the in-guest interface name (`eth0`). */
  name?: string;
  /** Omit to keep an existing device's MAC / let PVE generate one for a new device. */
  mac?: string;
  bridge: string;
  /** lxc only: `dhcp`, `manual` or an IPv4 CIDR. */
  ip?: string;
  /** lxc only. */
  gw?: string;
  /** lxc only: `auto`, `dhcp`, `manual` or an IPv6 CIDR. */
  ip6?: string;
  /** lxc only. */
  gw6?: string;
  vlan?: number;
  firewall?: boolean;
  rateMbps?: number;
  /** qemu only: the "disconnect" checkbox. */
  linkDown?: boolean;
  mtu?: number;
}

export interface NicSaveResult {
  ok: true;
  slot: string;
  /** `[slot]` when PVE holds the change back until the guest restarts. */
  pending: string[];
}

export interface NicRemoveResult {
  ok: true;
  pending: string[];
}

/** One bridge a NIC can be attached to. */
export interface BridgeInfo {
  iface: string;
  type: string;
  active?: boolean;
  comments?: string;
}

interface NetworkErrorBody {
  error?: string;
  message?: string;
  missing?: string;
}

/** Same short, human-readable mapping `hardware.ts` uses (its own copy is module-private, so this
 * is a deliberate duplicate rather than an edit to that file). */
function describeError(status: number, statusText: string, body: NetworkErrorBody | undefined): string {
  if (body?.message) return body.message;
  switch (body?.error) {
    case 'writes-disabled-in-token-mode':
      return 'Read-only: signed in with a service token';
    case 'forbidden':
      return body?.missing ? `You don't have ${body.missing} on this guest` : "You don't have permission for this";
    case 'not-found':
      return 'That network device no longer exists';
    case 'pve-unreachable':
      return 'Proxmox VE is unreachable';
    default:
      return body?.error ?? `Request failed: ${status} ${statusText}`;
  }
}

async function throwActionError(res: Response): Promise<never> {
  let errorBody: NetworkErrorBody | undefined;
  try {
    errorBody = (await res.json()) as NetworkErrorBody;
  } catch {
    errorBody = undefined;
  }
  throw new GuestActionError(res.status, describeError(res.status, res.statusText, errorBody));
}

// --- fixture (demo) mode ----------------------------------------------------------------------

/** The bridges the demo's nodes offer. */
export const FIXTURE_BRIDGES: BridgeInfo[] = [
  { iface: 'vmbr0', type: 'bridge', active: true, comments: 'LAN' },
  { iface: 'vmbr1', type: 'bridge', active: true, comments: 'Storage / backup network' },
];

/** A locally-administered unicast MAC in PVE's own `BC:24:11` prefix, like PVE generates. */
function generateMac(): string {
  const byte = () =>
    Math.floor(Math.random() * 256)
      .toString(16)
      .toUpperCase()
      .padStart(2, '0');
  return `BC:24:11:${byte()}:${byte()}:${byte()}`;
}

/** Composes the `net<n>` property string exactly as the server route does (keys in PVE's order,
 * unset fields omitted) -- fixture mode stores it in the in-memory config, so the Hardware tab
 * re-reads it through the same parser a real config goes through. */
export function composeNicValue(
  type: GuestType,
  slot: string,
  body: NicBody,
  mac: string | undefined,
): string {
  const parts: string[] = [];
  if (type === 'qemu') {
    const model = body.model ?? 'virtio';
    parts.push(mac !== undefined ? `${model}=${mac}` : model, `bridge=${body.bridge}`);
  } else {
    parts.push(`name=${body.name ?? `eth${slot.slice(3)}`}`, `bridge=${body.bridge}`);
    if (mac !== undefined) parts.push(`hwaddr=${mac}`);
    if (body.ip !== undefined) parts.push(`ip=${body.ip}`);
    if (body.gw !== undefined) parts.push(`gw=${body.gw}`);
    if (body.ip6 !== undefined) parts.push(`ip6=${body.ip6}`);
    if (body.gw6 !== undefined) parts.push(`gw6=${body.gw6}`);
  }
  if (body.vlan !== undefined) parts.push(`tag=${body.vlan}`);
  if (body.firewall !== undefined) parts.push(`firewall=${body.firewall ? 1 : 0}`);
  if (body.rateMbps !== undefined) parts.push(`rate=${body.rateMbps}`);
  if (type === 'qemu' && body.linkDown !== undefined) parts.push(`link_down=${body.linkDown ? 1 : 0}`);
  if (body.mtu !== undefined) parts.push(`mtu=${body.mtu}`);
  return parts.join(',');
}

function isFixtureRunning(vmid: number): boolean {
  return getFixtureGuestByVmid(vmid)?.status === 'running';
}

function fixtureUpsertNic(node: string, type: GuestType, vmid: number, slot: string, body: NicBody): NicSaveResult {
  const existing = getFixtureGuestConfig(vmid)?.[slot];
  const current = typeof existing === 'string' ? parseNicConfig(type, slot, existing) : undefined;
  const mac = body.mac ?? current?.mac ?? generateMac();
  patchFixtureGuestConfig(node, type, vmid, { [slot]: composeNicValue(type, slot, body, mac) });
  // A running qemu guest hot-plugs a new NIC; editing one (and any lxc change) waits for a restart.
  const held = isFixtureRunning(vmid) && (current !== undefined || type === 'lxc');
  return { ok: true, slot, pending: held ? [slot] : [] };
}

function fixtureRemoveNic(node: string, type: GuestType, vmid: number, slot: string): NicRemoveResult {
  if (getFixtureGuestConfig(vmid)?.[slot] === undefined) {
    throw new GuestActionError(404, `${slot} does not exist on this guest`);
  }
  patchFixtureGuestConfig(node, type, vmid, { [slot]: undefined });
  return { ok: true, pending: [] };
}

// --- public API -------------------------------------------------------------------------------

/**
 * Creates or edits one network device. Real mode: `PUT /api/actions/guest/:node/:type/:vmid/
 * network/:slot`. Fixture mode: writes the composed value into the in-memory fixture config.
 */
export async function upsertNic(
  node: string,
  type: GuestType,
  vmid: number,
  slot: string,
  body: NicBody,
): Promise<NicSaveResult> {
  if (USE_FIXTURES) {
    return fixtureUpsertNic(node, type, vmid, slot, body);
  }

  const res = await fetch(`/api/actions/guest/${node}/${type}/${vmid}/network/${slot}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (res.status === 200) {
    return (await res.json()) as NicSaveResult;
  }
  return throwActionError(res);
}

/** Removes one network device: `DELETE /api/actions/guest/:node/:type/:vmid/network/:slot`. */
export async function deleteNic(node: string, type: GuestType, vmid: number, slot: string): Promise<NicRemoveResult> {
  if (USE_FIXTURES) {
    return fixtureRemoveNic(node, type, vmid, slot);
  }

  const res = await fetch(`/api/actions/guest/${node}/${type}/${vmid}/network/${slot}`, { method: 'DELETE' });
  if (res.status === 200) {
    return (await res.json()) as NicRemoveResult;
  }
  return throwActionError(res);
}

/** The lowest unused `net<n>` on the guest: `GET .../network/next-slot` (session-only). */
export async function getNextNicSlot(node: string, type: GuestType, vmid: number): Promise<string> {
  if (USE_FIXTURES) {
    const slot = nextFreeNetSlot(getFixtureGuestConfig(vmid) ?? {});
    if (slot === undefined) throw new GuestActionError(409, 'All 32 network device slots are in use');
    return slot;
  }

  const res = await fetch(`/api/actions/guest/${node}/${type}/${vmid}/network/next-slot`);
  if (res.status === 200) {
    const json = (await res.json()) as { slot: string };
    return json.slot;
  }
  return throwActionError(res);
}

/** The bridges a NIC can attach to: `GET /nodes/{node}/network?type=any_bridge` through the
 * read-only proxy, filtered to bridge-like entries and sorted by name. */
export async function getBridges(node: string): Promise<BridgeInfo[]> {
  if (USE_FIXTURES) {
    return FIXTURE_BRIDGES;
  }

  const res = await fetch(`/api/pve/nodes/${node}/network?type=any_bridge`);
  if (!res.ok) throw new Error(`Failed to load bridges for ${node}: ${res.status}`);
  const envelope = (await res.json()) as { data?: unknown };
  if (!Array.isArray(envelope.data)) return [];
  return (envelope.data as Array<{ iface?: unknown; type?: unknown; active?: unknown; comments?: unknown }>)
    .filter(
      (b): b is { iface: string; type: string; active?: unknown; comments?: unknown } =>
        typeof b.iface === 'string' &&
        typeof b.type === 'string' &&
        ['bridge', 'OVSBridge', 'vnet'].includes(b.type),
    )
    .map((b) => ({
      iface: b.iface,
      type: b.type,
      ...(b.active === 1 || b.active === true ? { active: true } : b.active === 0 || b.active === false ? { active: false } : {}),
      ...(typeof b.comments === 'string' && b.comments !== '' ? { comments: b.comments } : {}),
    }))
    .sort((a, b) => a.iface.localeCompare(b.iface));
}
