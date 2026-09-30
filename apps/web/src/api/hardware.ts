import { USE_FIXTURES } from '@/api/client';
import { GuestActionError } from '@/api/actions';
import { getFixtureGuestByVmid, getFixtureGuestConfig, patchFixtureGuestConfig } from '@/api/fixtures';
import { parsePveSize } from '@/lib/format';
import type { GuestType } from '@/api/types';

/**
 * Guest hardware edits (T48): the web side of `PATCH .../hardware` and `PUT .../resize`
 * (`apps/server/src/actions/hardwareRoutes.ts`) plus the two read-only lookups the editor needs
 * (PVE's pending-changes list and the node's CPU models, both via the read-only `/api/pve/*`
 * proxy). Kept in its own module next to `actions.ts` rather than inside it; fixture mode is
 * handled inline in each function (same convention as `actions.ts`).
 */

/** Body for `updateHardware`. Matches the server route's own contract: every field optional, at
 * least one required; qemu-only and lxc-only fields are rejected for the wrong guest type. */
export interface HardwarePatch {
  cores?: number;
  /** qemu only. */
  sockets?: number;
  /** qemu only. A CPU model name only (`host`, `x86-64-v3`, ...) -- PVE validates it. */
  cpu?: string;
  /** MiB. */
  memory?: number;
  /** qemu only. Balloon minimum in MiB; `0` disables ballooning. */
  balloon?: number;
  /** lxc only. MiB. */
  swap?: number;
  /** qemu only. `iso: null` ejects the media ("No media"). */
  cdrom?: { slot: string; iso: string | null };
}

export interface HardwareUpdateResult {
  ok: true;
  /** The PVE config keys that were sent (a CD-ROM is reported under its slot, e.g. `ide2`). */
  changed: string[];
  /** The subset of `changed` PVE is holding back until the guest restarts. */
  pending: string[];
}

export interface ResizeDiskBody {
  /** `scsi0`, `virtio1`, `rootfs`, `mp0`, ... */
  disk: string;
  /** Relative grow, e.g. `+10G` -- the server refuses anything without the leading `+`. */
  size: string;
}

export interface ResizeDiskResult {
  /** The PVE task UPID, when PVE resized asynchronously (modern releases). Absent when PVE
   * returned none (the server then answers `200 { ok: true }`). */
  upid?: string;
}

/** One row of `GET .../pending`. A key is "pending" when it carries `pending` (a new value) or
 * `delete` (queued removal). */
export interface PendingConfigEntry {
  key: string;
  value?: string | number;
  pending?: string | number;
  delete?: number;
}

/** One row of `GET /nodes/{node}/capabilities/qemu/cpu`. */
export interface CpuModel {
  name: string;
  /** `default` (PVE's own generic models), `AuthenticAMD` or `GenuineIntel`. */
  vendor: string;
  custom?: boolean;
}

/** The config keys PVE applies only after a restart when the guest is running. */
const RESTART_KEYS = ['cores', 'sockets', 'cpu', 'memory', 'balloon', 'swap'] as const;

/** Whether a pending-list row is actually a queued change. */
export function isPendingEntry(entry: PendingConfigEntry): boolean {
  return entry.pending !== undefined || Boolean(entry.delete);
}

/** The node-independent list the fixture (demo) mode serves, and the dialog's fallback when the
 * real lookup fails -- a representative subset of what a real PVE host reports. */
export const FALLBACK_CPU_MODELS: CpuModel[] = [
  { name: 'kvm64', vendor: 'default' },
  { name: 'qemu64', vendor: 'default' },
  { name: 'host', vendor: 'default' },
  { name: 'max', vendor: 'default' },
  { name: 'x86-64-v2', vendor: 'default' },
  { name: 'x86-64-v2-AES', vendor: 'default' },
  { name: 'x86-64-v3', vendor: 'default' },
  { name: 'x86-64-v4', vendor: 'default' },
  { name: 'Skylake-Server', vendor: 'GenuineIntel' },
  { name: 'Cascadelake-Server', vendor: 'GenuineIntel' },
  { name: 'Icelake-Server', vendor: 'GenuineIntel' },
  { name: 'SapphireRapids', vendor: 'GenuineIntel' },
  { name: 'EPYC', vendor: 'AuthenticAMD' },
  { name: 'EPYC-Rome', vendor: 'AuthenticAMD' },
  { name: 'EPYC-Milan', vendor: 'AuthenticAMD' },
  { name: 'EPYC-Genoa', vendor: 'AuthenticAMD' },
];

interface HardwareErrorBody {
  error?: string;
  message?: string;
  missing?: string;
}

/** Same short, human-readable mapping `actions.ts` uses for every guest action (its own copy is
 * module-private, so this is a deliberate duplicate rather than an edit to that file). */
function describeError(status: number, statusText: string, body: HardwareErrorBody | undefined): string {
  if (body?.message) return body.message;
  switch (body?.error) {
    case 'writes-disabled-in-token-mode':
      return 'Read-only: signed in with a service token';
    case 'forbidden':
      return body?.missing ? `You don't have ${body.missing} on this guest` : "You don't have permission for this";
    case 'pve-unreachable':
      return 'Proxmox VE is unreachable';
    default:
      return body?.error ?? `Request failed: ${status} ${statusText}`;
  }
}

async function throwActionError(res: Response): Promise<never> {
  let errorBody: HardwareErrorBody | undefined;
  try {
    errorBody = (await res.json()) as HardwareErrorBody;
  } catch {
    errorBody = undefined;
  }
  throw new GuestActionError(res.status, describeError(res.status, res.statusText, errorBody));
}

// --- fixture (demo) mode ----------------------------------------------------------------------

/** Pending changes the demo is holding for a running guest, keyed `<type>:<vmid>`. Cleared the
 * moment the guest is seen stopped (a stop/start applies them, like real PVE). */
const fixturePending = new Map<string, PendingConfigEntry[]>();

function pendingKey(type: GuestType, vmid: number): string {
  return `${type}:${vmid}`;
}

function isFixtureRunning(vmid: number): boolean {
  return getFixtureGuestByVmid(vmid)?.status === 'running';
}

function fixtureUpdateHardware(
  node: string,
  type: GuestType,
  vmid: number,
  patch: HardwarePatch,
): HardwareUpdateResult {
  const before = getFixtureGuestConfig(vmid) ?? {};
  const next: Record<string, string | number | undefined> = {};
  if (patch.cores !== undefined) next.cores = patch.cores;
  if (patch.sockets !== undefined) next.sockets = patch.sockets;
  if (patch.cpu !== undefined) next.cpu = patch.cpu;
  if (patch.memory !== undefined) next.memory = patch.memory;
  if (patch.balloon !== undefined) next.balloon = patch.balloon;
  if (patch.swap !== undefined) next.swap = patch.swap;
  if (patch.cdrom !== undefined) next[patch.cdrom.slot] = `${patch.cdrom.iso ?? 'none'},media=cdrom`;

  const changed = Object.keys(next);
  patchFixtureGuestConfig(node, type, vmid, next);

  // Only a running guest holds changes back; CD-ROM media changes apply live.
  const running = isFixtureRunning(vmid);
  const pendingKeys = running ? changed.filter((k) => (RESTART_KEYS as readonly string[]).includes(k)) : [];
  if (pendingKeys.length > 0) {
    const key = pendingKey(type, vmid);
    const held = (fixturePending.get(key) ?? []).filter((e) => !pendingKeys.includes(e.key));
    for (const k of pendingKeys) {
      const old = before[k];
      held.push({ key: k, ...(old !== undefined ? { value: old } : {}), pending: next[k] as string | number });
    }
    fixturePending.set(key, held);
  }
  return { ok: true, changed, pending: pendingKeys };
}

function fixtureResizeDisk(node: string, type: GuestType, vmid: number, body: ResizeDiskBody): ResizeDiskResult {
  const config = getFixtureGuestConfig(vmid);
  const raw = config?.[body.disk];
  if (typeof raw !== 'string') {
    throw new GuestActionError(400, `${body.disk} is not a disk on this guest`);
  }
  const current = /(?:^|,)size=([^,]+)/.exec(raw)?.[1];
  const currentBytes = parsePveSize(current);
  const delta = /^\+(\d+(?:\.\d+)?)([MGT])$/.exec(body.size);
  if (currentBytes === null || !delta) {
    throw new GuestActionError(400, 'The disk size could not be determined');
  }
  const growth = parsePveSize(`${delta[1]}${delta[2]}`) ?? 0;
  const totalMiB = Math.round((currentBytes + growth) / 1024 / 1024);
  const size = totalMiB % 1024 === 0 ? `${totalMiB / 1024}G` : `${totalMiB}M`;
  const updated = current !== undefined ? raw.replace(/(^|,)size=[^,]+/, `$1size=${size}`) : `${raw},size=${size}`;
  patchFixtureGuestConfig(node, type, vmid, { [body.disk]: updated });
  return { upid: `UPID:${node}:0000FFFF:00000000:00000000:resize:${vmid}:root@pam:` };
}

// --- public API -------------------------------------------------------------------------------

/**
 * Requests one guest hardware edit (CPU / memory / CD-ROM). Real mode:
 * `PATCH /api/actions/guest/:node/:type/:vmid/hardware`. Fixture mode: patches the in-memory
 * fixture config (and records "pending" entries while the guest is running) so the demo visibly
 * reflects the change.
 */
export async function updateHardware(
  node: string,
  type: GuestType,
  vmid: number,
  patch: HardwarePatch,
): Promise<HardwareUpdateResult> {
  if (USE_FIXTURES) {
    return fixtureUpdateHardware(node, type, vmid, patch);
  }

  const res = await fetch(`/api/actions/guest/${node}/${type}/${vmid}/hardware`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(patch),
  });
  if (res.status === 200) {
    return (await res.json()) as HardwareUpdateResult;
  }
  return throwActionError(res);
}

/**
 * Requests one disk grow. Real mode: `PUT /api/actions/guest/:node/:type/:vmid/resize` (202 with a
 * UPID, or 200 `{ ok: true }` when PVE returned none). Fixture mode: bumps the drive's `size=` in
 * the in-memory fixture config.
 */
export async function resizeDisk(
  node: string,
  type: GuestType,
  vmid: number,
  body: ResizeDiskBody,
): Promise<ResizeDiskResult> {
  if (USE_FIXTURES) {
    return fixtureResizeDisk(node, type, vmid, body);
  }

  const res = await fetch(`/api/actions/guest/${node}/${type}/${vmid}/resize`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (res.status === 202) {
    const json = (await res.json()) as { upid?: string };
    return json.upid !== undefined ? { upid: json.upid } : {};
  }
  if (res.status === 200) {
    return {};
  }
  return throwActionError(res);
}

/** The guest's pending (not yet applied) config changes: `GET .../pending` through the read-only
 * proxy. Fixture mode returns what `updateHardware` recorded while the guest is running, and
 * clears it once the guest is stopped. */
export async function getPendingConfig(node: string, type: GuestType, vmid: number): Promise<PendingConfigEntry[]> {
  if (USE_FIXTURES) {
    const key = pendingKey(type, vmid);
    if (!isFixtureRunning(vmid)) {
      fixturePending.delete(key);
      return [];
    }
    return [...(fixturePending.get(key) ?? [])];
  }

  const res = await fetch(`/api/pve/nodes/${node}/${type}/${vmid}/pending`);
  if (!res.ok) throw new Error(`Failed to load pending changes for ${type}/${vmid}: ${res.status}`);
  const envelope = (await res.json()) as { data?: unknown };
  return Array.isArray(envelope.data) ? (envelope.data as PendingConfigEntry[]) : [];
}

/** The CPU models this node's PVE offers: `GET /nodes/{node}/capabilities/qemu/cpu` through the
 * read-only proxy. Fixture mode serves a static list. */
export async function getCpuModels(node: string): Promise<CpuModel[]> {
  if (USE_FIXTURES) {
    return FALLBACK_CPU_MODELS;
  }

  const res = await fetch(`/api/pve/nodes/${node}/capabilities/qemu/cpu`);
  if (!res.ok) throw new Error(`Failed to load CPU models for ${node}: ${res.status}`);
  const envelope = (await res.json()) as { data?: unknown };
  if (!Array.isArray(envelope.data)) return [];
  return (envelope.data as Array<{ name?: unknown; vendor?: unknown; custom?: unknown }>)
    .filter((m): m is { name: string; vendor?: unknown; custom?: unknown } => typeof m.name === 'string')
    .map((m) => ({
      name: m.name,
      vendor: typeof m.vendor === 'string' ? m.vendor : 'default',
      custom: m.custom === 1 || m.custom === true,
    }));
}
