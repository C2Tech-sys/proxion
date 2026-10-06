import { USE_FIXTURES } from '@/api/client';
import { GuestActionError } from '@/api/actions';
import { addFixtureGuest, setFixtureGuestConfigRecord } from '@/api/fixtures';
import type { ClusterResource, GuestConfig } from '@/api/types';

/**
 * Create container (T62): the web side of `POST /api/actions/guest/:node/lxc/create`
 * (`apps/server/src/actions/createCtRoutes.ts`). Fixture mode is handled inline (same convention as
 * `network.ts`): it adds the container to the in-memory fixture data, composing the config keys the
 * same way the server composes PVE's parameters -- and never storing the root password.
 */

/** The NIC of a new container. `ip`/`ip6` are PVE's own values (`dhcp`, `manual`, a CIDR; `auto`
 * for IPv6); leave one out to configure no address of that family. */
export interface CreateCtNet {
  name: string;
  bridge: string;
  ip?: string;
  gw?: string;
  ip6?: string;
  gw6?: string;
  tag?: number;
  firewall: boolean;
  hwaddr?: string;
  mtu?: number;
}

/** Body for `createCt`: matches the server route's own (strict) contract. */
export interface CreateCtBody {
  vmid: number;
  hostname: string;
  pool?: string;
  tags?: string[];
  start: boolean;
  unprivileged: boolean;
  nesting: boolean;
  /** Secret: sent to the server only, never logged, never stored, never part of a fixture. */
  password?: string;
  sshKeys?: string[];
  template: { storage: string; volid: string };
  rootfs: { storage: string; sizeGiB: number; acl?: boolean; quota?: boolean };
  cpu: { cores: number; cpulimit?: number; cpuunits?: number };
  memory: { memoryMiB: number; swapMiB: number };
  /** `null` creates the container without a network device. */
  net: CreateCtNet | null;
  dns?: { nameserver?: string[]; searchdomain?: string };
}

export interface CreateCtResult {
  upid: string;
  vmid: number;
}

interface CreateCtErrorBody {
  error?: string;
  message?: string;
  missing?: string;
}

/** Same short, human-readable mapping `network.ts` uses (its own copy is module-private). */
function describeError(status: number, statusText: string, body: CreateCtErrorBody | undefined): string {
  if (body?.message) return body.message;
  switch (body?.error) {
    case 'writes-disabled-in-token-mode':
      return 'Read-only: signed in with a service token';
    case 'forbidden':
      return body?.missing ? `You don't have ${body.missing}` : "You don't have permission for this";
    case 'vmid-taken':
      return 'That CT ID is already in use';
    case 'pve-unreachable':
      return 'Proxmox VE is unreachable';
    default:
      return body?.error ?? `Request failed: ${status} ${statusText}`;
  }
}

async function throwActionError(res: Response): Promise<never> {
  let errorBody: CreateCtErrorBody | undefined;
  try {
    errorBody = (await res.json()) as CreateCtErrorBody;
  } catch {
    errorBody = undefined;
  }
  throw new GuestActionError(res.status, describeError(res.status, res.statusText, errorBody));
}

// --- fixture (demo) mode ----------------------------------------------------------------------

/** `<storage>:<sizeGiB>[,acl=1][,quota=1]` -- the value the server sends PVE for `rootfs`. */
export function composeRootfsParam(rootfs: CreateCtBody['rootfs']): string {
  const parts = [`${rootfs.storage}:${rootfs.sizeGiB}`];
  if (rootfs.acl === true) parts.push('acl=1');
  if (rootfs.quota === true) parts.push('quota=1');
  return parts.join(',');
}

/** The `net0` value the server sends PVE: keys in the same order as its own composition. */
export function composeCtNetValue(net: CreateCtNet): string {
  const parts = [`name=${net.name}`, `bridge=${net.bridge}`];
  if (net.hwaddr !== undefined) parts.push(`hwaddr=${net.hwaddr}`);
  if (net.ip !== undefined) parts.push(`ip=${net.ip}`);
  if (net.gw !== undefined) parts.push(`gw=${net.gw}`);
  if (net.ip6 !== undefined) parts.push(`ip6=${net.ip6}`);
  if (net.gw6 !== undefined) parts.push(`gw6=${net.gw6}`);
  if (net.tag !== undefined) parts.push(`tag=${net.tag}`);
  parts.push(`firewall=${net.firewall ? 1 : 0}`);
  if (net.mtu !== undefined) parts.push(`mtu=${net.mtu}`);
  return parts.join(',');
}

/**
 * The config a freshly created container reads back with. Real PVE stores the root volume as
 * `<storage>:subvol-<vmid>-disk-0,size=<n>G`; the password is hashed by PVE and never appears in a
 * config -- and is never an input here.
 */
export function composeFixtureCtConfig(body: CreateCtBody): GuestConfig {
  const config: GuestConfig = {
    hostname: body.hostname,
    cores: body.cpu.cores,
    memory: body.memory.memoryMiB,
    swap: body.memory.swapMiB,
    unprivileged: body.unprivileged ? 1 : 0,
    rootfs: `${body.rootfs.storage}:subvol-${body.vmid}-disk-0,size=${body.rootfs.sizeGiB}G${body.rootfs.acl === true ? ',acl=1' : ''}`,
  };
  if (body.nesting) config.features = 'nesting=1';
  if (body.cpu.cpulimit !== undefined) config.cpulimit = body.cpu.cpulimit;
  if (body.cpu.cpuunits !== undefined) config.cpuunits = body.cpu.cpuunits;
  if (body.net !== null) config.net0 = composeCtNetValue(body.net);
  if (body.dns?.nameserver !== undefined && body.dns.nameserver.length > 0) {
    config.nameserver = body.dns.nameserver.join(' ');
  }
  if (body.dns?.searchdomain !== undefined) config.searchdomain = body.dns.searchdomain;
  if (body.tags !== undefined && body.tags.length > 0) config.tags = body.tags.join(';');
  return config;
}

let fixtureUpidSeq = 0;

function fixtureCreateCt(node: string, body: CreateCtBody): CreateCtResult {
  const row: ClusterResource = {
    id: `lxc/${body.vmid}`,
    type: 'lxc',
    node,
    vmid: body.vmid,
    name: body.hostname,
    status: body.start ? 'running' : 'stopped',
    template: 0,
    maxcpu: body.cpu.cores,
    maxmem: body.memory.memoryMiB * 1024 * 1024,
    maxdisk: body.rootfs.sizeGiB * 1024 * 1024 * 1024,
    ...(body.tags !== undefined && body.tags.length > 0 ? { tags: body.tags.join(';') } : {}),
  };
  addFixtureGuest(row);
  setFixtureGuestConfigRecord(body.vmid, composeFixtureCtConfig(body));
  fixtureUpidSeq += 1;
  const seq = fixtureUpidSeq.toString(16).padStart(8, '0');
  return { upid: `UPID:${node}:${seq}:00000000:00000000:vzcreate:${body.vmid}:demo@pve!fixtures:`, vmid: body.vmid };
}

// --- public API -------------------------------------------------------------------------------

/**
 * Creates a container: `POST /api/actions/guest/:node/lxc/create` (session sign-in only; the server
 * answers `202 { upid, vmid }`). Fixture mode adds the container to the in-memory fixture data.
 */
export async function createCt(node: string, body: CreateCtBody): Promise<CreateCtResult> {
  if (USE_FIXTURES) {
    return fixtureCreateCt(node, body);
  }

  const res = await fetch(`/api/actions/guest/${encodeURIComponent(node)}/lxc/create`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (res.status === 202) {
    return (await res.json()) as CreateCtResult;
  }
  return throwActionError(res);
}
