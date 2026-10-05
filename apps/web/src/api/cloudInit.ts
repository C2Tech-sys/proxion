import { USE_FIXTURES } from '@/api/client';
import { GuestActionError } from '@/api/actions';
import {
  getFixtureCloudInitPending,
  getFixtureGuestByVmid,
  getFixtureGuestConfig,
  patchFixtureGuestConfig,
  regenerateFixtureCloudInit,
  setFixtureCloudInitPending,
} from '@/api/fixtures';
import { composeIpConfig, encodeSshKeys, type IpConfigFields } from '@/lib/pve-config';

/**
 * VM Cloud-Init (T54): the web side of `PATCH .../cloud-init` and `POST .../cloud-init/regenerate`
 * (`apps/server/src/actions/cloudInitRoutes.ts`), plus the read of PVE's per-key cloud-init list
 * (current + pending values) through the read-only `/api/pve/*` proxy. Fixture mode is handled
 * inline in each function (same convention as `network.ts`).
 *
 * The password is secret: it is sent in the request body and nowhere else -- never put in a URL,
 * a toast, an error message, a query key or a log line, and fixture mode never stores it.
 */

export type CloudInitType = 'nocloud' | 'configdrive2' | 'opennebula';

/** Body for `updateCloudInit`: every field optional, `null` (or `[]` for the lists) removes the
 * setting, an absent field leaves it alone. Matches the server route's own contract. */
export interface CloudInitUpdate {
  user?: string | null;
  /** Sent as `cipassword` for PVE to hash. */
  password?: string | null;
  /** One OpenSSH public key per entry; `[]` removes them all. */
  sshKeys?: string[];
  /** Up to three IP addresses; `[]` removes them. */
  nameserver?: string[];
  searchdomain?: string | null;
  upgrade?: boolean;
  type?: CloudInitType | null;
  /** `net0` -> its address settings, or `null` to remove that NIC's `ipconfig`. */
  ipconfig?: Record<string, IpConfigFields | null>;
}

export interface CloudInitSaveResult {
  ok: true;
  /** The cloud-init keys PVE reports with a pending value or delete. */
  pending: string[];
}

/** One row of PVE's `GET /nodes/{node}/qemu/{vmid}/cloudinit`. */
export interface CloudInitEntry {
  key: string;
  value?: string;
  pending?: string;
  delete?: number;
}

/** Whether PVE is holding this key back (a pending value or a pending delete). */
export function isCloudInitPending(entry: CloudInitEntry): boolean {
  return entry.pending !== undefined || Boolean(entry.delete);
}

interface CloudInitErrorBody {
  error?: string;
  message?: string;
  missing?: string;
}

/** Same short, human-readable mapping `network.ts` uses (its own copy is module-private). */
function describeError(status: number, statusText: string, body: CloudInitErrorBody | undefined): string {
  if (body?.message) return body.message;
  switch (body?.error) {
    case 'writes-disabled-in-token-mode':
      return 'Read-only: signed in with a service token';
    case 'forbidden':
      return body?.missing ? `You don't have ${body.missing} on this guest` : "You don't have permission for this";
    case 'not-applicable':
      return 'Cloud-Init is only available on VMs';
    case 'pve-unreachable':
      return 'Proxmox VE is unreachable';
    default:
      return body?.error ?? `Request failed: ${status} ${statusText}`;
  }
}

async function throwActionError(res: Response): Promise<never> {
  let errorBody: CloudInitErrorBody | undefined;
  try {
    errorBody = (await res.json()) as CloudInitErrorBody;
  } catch {
    errorBody = undefined;
  }
  throw new GuestActionError(res.status, describeError(res.status, res.statusText, errorBody));
}

/** The config keys an update touches: what to set and what to delete, composed exactly as the
 * server route does (so fixture mode shows what a real save would store). */
export function composeCloudInitPatch(body: CloudInitUpdate): {
  set: Record<string, string>;
  remove: string[];
} {
  const set: Record<string, string> = {};
  const remove: string[] = [];

  if (body.user === null) remove.push('ciuser');
  else if (body.user !== undefined) set.ciuser = body.user;

  // Fixture mode keeps PVE's own mask, never the typed password.
  if (body.password === null) remove.push('cipassword');
  else if (body.password !== undefined) set.cipassword = '********';

  if (body.sshKeys !== undefined) {
    if (body.sshKeys.length === 0) remove.push('sshkeys');
    else set.sshkeys = encodeSshKeys(body.sshKeys);
  }
  if (body.nameserver !== undefined) {
    if (body.nameserver.length === 0) remove.push('nameserver');
    else set.nameserver = body.nameserver.join(' ');
  }
  if (body.searchdomain === null) remove.push('searchdomain');
  else if (body.searchdomain !== undefined) set.searchdomain = body.searchdomain;

  if (body.upgrade !== undefined) set.ciupgrade = body.upgrade ? '1' : '0';

  if (body.type === null) remove.push('citype');
  else if (body.type !== undefined) set.citype = body.type;

  for (const [slot, value] of Object.entries(body.ipconfig ?? {})) {
    const key = `ipconfig${slot.slice(3)}`;
    if (value === null) remove.push(key);
    else set[key] = composeIpConfig(value);
  }
  return { set, remove };
}

// --- fixture (demo) mode ----------------------------------------------------------------------

function fixtureUpdate(node: string, vmid: number, body: CloudInitUpdate): CloudInitSaveResult {
  const config = getFixtureGuestConfig(vmid);
  const unknown = Object.entries(body.ipconfig ?? {}).find(
    ([slot, value]) => value !== null && config?.[slot] === undefined,
  );
  if (unknown) throw new GuestActionError(400, `${unknown[0]} does not exist on this guest`);

  const { set, remove } = composeCloudInitPatch(body);
  const patch: Record<string, string | undefined> = { ...set };
  for (const key of remove) patch[key] = undefined;
  patchFixtureGuestConfig(node, 'qemu', vmid, patch);

  // A running guest holds the change back until the image is regenerated.
  if (getFixtureGuestByVmid(vmid)?.status === 'running') {
    setFixtureCloudInitPending(vmid, [...getFixtureCloudInitPending(vmid), ...Object.keys(patch)]);
  }
  return { ok: true, pending: getFixtureCloudInitPending(vmid) };
}

function fixtureEntries(vmid: number): CloudInitEntry[] {
  return getFixtureCloudInitPending(vmid).map((key) => ({ key, pending: '(pending)' }));
}

// --- public API -------------------------------------------------------------------------------

/** The guest's cloud-init values and what is pending: `GET /api/pve/nodes/:node/qemu/:vmid/
 * cloudinit` through the read-only proxy. */
export async function getCloudInitPending(node: string, vmid: number): Promise<CloudInitEntry[]> {
  if (USE_FIXTURES) {
    return fixtureEntries(vmid);
  }

  const res = await fetch(`/api/pve/nodes/${node}/qemu/${vmid}/cloudinit`);
  if (!res.ok) throw new Error(`Failed to load cloud-init values for qemu/${vmid}: ${res.status}`);
  const envelope = (await res.json()) as { data?: unknown };
  return Array.isArray(envelope.data) ? (envelope.data as CloudInitEntry[]) : [];
}

/** Changes cloud-init settings: `PATCH /api/actions/guest/:node/qemu/:vmid/cloud-init`. */
export async function updateCloudInit(node: string, vmid: number, body: CloudInitUpdate): Promise<CloudInitSaveResult> {
  if (USE_FIXTURES) {
    return fixtureUpdate(node, vmid, body);
  }

  const res = await fetch(`/api/actions/guest/${node}/qemu/${vmid}/cloud-init`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (res.status === 200) {
    return (await res.json()) as CloudInitSaveResult;
  }
  return throwActionError(res);
}

/** Regenerates the cloud-init image: `POST /api/actions/guest/:node/qemu/:vmid/cloud-init/
 * regenerate`. */
export async function regenerateCloudInit(node: string, vmid: number): Promise<{ ok: true }> {
  if (USE_FIXTURES) {
    regenerateFixtureCloudInit(vmid);
    return { ok: true };
  }

  const res = await fetch(`/api/actions/guest/${node}/qemu/${vmid}/cloud-init/regenerate`, { method: 'POST' });
  if (res.status === 200) {
    return (await res.json()) as { ok: true };
  }
  return throwActionError(res);
}
