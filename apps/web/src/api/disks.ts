import { USE_FIXTURES } from '@/api/client';
import { GuestActionError } from '@/api/actions';
import { getFixtureGuestConfig, patchFixtureGuestConfig } from '@/api/fixtures';
import type { ClusterResource, GuestType } from '@/api/types';

/**
 * Guest disk lifecycle (T52): the web side of `POST .../disks` (add a disk / mount point),
 * `POST .../disks/:slot/detach` and `DELETE .../disks/:slot` (remove an unused volume), served by
 * `apps/server/src/actions/diskRoutes.ts`, plus the read-only storage-format lookup the add dialog
 * needs. Own module next to `hardware.ts`; fixture mode is handled inline in each function (same
 * convention as `actions.ts`/`hardware.ts`).
 */

export type DiskBus = 'scsi' | 'virtio' | 'sata' | 'ide';
export type DiskFormat = 'raw' | 'qcow2' | 'vmdk';
export type DiskCache = 'none' | 'writethrough' | 'writeback' | 'unsafe' | 'directsync';

/** Body for adding a qemu disk. Optional fields are left out entirely when not chosen (PVE then
 * uses its own defaults) -- never sent as `undefined`. */
export interface AddQemuDiskBody {
  bus: DiskBus;
  storage: string;
  sizeGiB: number;
  format?: DiskFormat;
  discard?: boolean;
  ssd?: boolean;
  iothread?: boolean;
  cache?: DiskCache;
  backup?: boolean;
}

/** Body for adding a lxc mount point. */
export interface AddMountPointBody {
  storage: string;
  sizeGiB: number;
  /** Absolute path inside the container. */
  mountPoint: string;
  backup?: boolean;
  readOnly?: boolean;
  acl?: boolean;
}

export type AddDiskBody = AddQemuDiskBody | AddMountPointBody;

export interface AddDiskResult {
  ok: true;
  /** The config key the new disk landed in (`scsi2`, `mp1`). */
  slot: string;
  /** The subset of `[slot]` PVE is holding back until the guest restarts. */
  pending: string[];
}

export interface DetachDiskResult {
  ok: true;
  /** The `unused[n]` key PVE parked the volume under, when it could be determined. */
  unusedSlot?: string;
  pending: string[];
}

/** What a storage can hold qemu disk images as. */
export interface StorageFormatInfo {
  formats: DiskFormat[];
  /** The format PVE picks when none is given. */
  default: DiskFormat;
}

/** PVE's own qemu disk-image slot counts per bus (`ide0-3`, `sata0-5`, `virtio0-15`, `scsi0-30`). */
export const BUS_SLOT_COUNTS: Record<DiskBus, number> = { ide: 4, sata: 6, virtio: 16, scsi: 31 };

/** Directory-like plugin types; lvm/lvmthin/zfspool/rbd/iscsi (and anything unknown) are raw only. */
const FILE_BASED_TYPES = new Set(['dir', 'nfs', 'cifs', 'glusterfs', 'cephfs', 'btrfs']);

/**
 * The image formats a storage of this PVE plugin type supports, for when the node's own
 * `?format=1` listing has nothing for it: directory-like storages take qcow2/raw/vmdk (qcow2 is
 * the default), block/pool storages are raw only. An unknown type is treated as raw only -- the
 * safe choice, since PVE always accepts raw where it accepts images at all.
 */
export function inferStorageFormats(plugintype: string | undefined): StorageFormatInfo {
  if (plugintype !== undefined && FILE_BASED_TYPES.has(plugintype)) {
    return { formats: ['qcow2', 'raw', 'vmdk'], default: 'qcow2' };
  }
  return { formats: ['raw'], default: 'raw' };
}

const DISK_FORMATS: readonly string[] = ['raw', 'qcow2', 'vmdk'];

function asFormats(value: unknown): DiskFormat[] {
  if (Array.isArray(value)) {
    return value.filter((v): v is DiskFormat => typeof v === 'string' && DISK_FORMATS.includes(v));
  }
  if (value !== null && typeof value === 'object') {
    return Object.keys(value).filter((k): k is DiskFormat => DISK_FORMATS.includes(k));
  }
  return [];
}

/** Reads one storage row of `GET /nodes/{node}/storage?content=images&format=1`. PVE answers
 * `format` as `[<formats>, <default>]` on real hosts; a plain `formats` list is accepted too.
 * `undefined` when the row carries no usable format information. */
function parseFormatInfo(row: Record<string, unknown>): StorageFormatInfo | undefined {
  let formats: DiskFormat[] = [];
  let defaultFormat: string | undefined;
  if (Array.isArray(row.format)) {
    formats = asFormats(row.format[0]);
    if (typeof row.format[1] === 'string') defaultFormat = row.format[1];
  }
  if (formats.length === 0) formats = asFormats(row.formats);
  if (formats.length === 0) return undefined;
  const fallback = formats[0] as DiskFormat;
  const chosen = DISK_FORMATS.includes(defaultFormat ?? '') && formats.includes(defaultFormat as DiskFormat)
    ? (defaultFormat as DiskFormat)
    : fallback;
  return { formats, default: chosen };
}

// --- error plumbing (same shape as hardware.ts; its helpers are module-private) ----------------

interface DiskErrorBody {
  error?: string;
  message?: string;
  missing?: string;
}

function describeError(status: number, statusText: string, body: DiskErrorBody | undefined): string {
  if (body?.message) return body.message;
  switch (body?.error) {
    case 'writes-disabled-in-token-mode':
      return 'Read-only: signed in with a service token';
    case 'forbidden':
      return body?.missing ? `You don't have ${body.missing} for this` : "You don't have permission for this";
    case 'pve-unreachable':
      return 'Proxmox VE is unreachable';
    case 'bus-full':
      return 'That bus has no free slot';
    default:
      return body?.error ?? `Request failed: ${status} ${statusText}`;
  }
}

async function throwActionError(res: Response): Promise<never> {
  let errorBody: DiskErrorBody | undefined;
  try {
    errorBody = (await res.json()) as DiskErrorBody;
  } catch {
    errorBody = undefined;
  }
  throw new GuestActionError(res.status, describeError(res.status, res.statusText, errorBody));
}

// --- fixture (demo) mode ------------------------------------------------------------------------

function nextFreeIndex(config: Record<string, unknown>, prefix: string, count: number): number | undefined {
  const taken = new Set<number>();
  const re = new RegExp(`^${prefix}(\\d+)$`);
  for (const key of Object.keys(config)) {
    const match = re.exec(key);
    if (match) taken.add(Number(match[1]));
  }
  for (let n = 0; n < count; n++) {
    if (!taken.has(n)) return n;
  }
  return undefined;
}

/** The next `vm-<vmid>-disk-<k>` index: one past the highest already used by any config value. */
function nextDiskIndex(config: Record<string, unknown>, vmid: number): number {
  const re = new RegExp(`(?:vm|subvol)-${vmid}-disk-(\\d+)`);
  let max = -1;
  for (const value of Object.values(config)) {
    const match = typeof value === 'string' ? re.exec(value) : null;
    if (match) max = Math.max(max, Number(match[1]));
  }
  return max + 1;
}

function isQemuBody(body: AddDiskBody): body is AddQemuDiskBody {
  return 'bus' in body;
}

function fixtureAddDisk(node: string, type: GuestType, vmid: number, body: AddDiskBody): AddDiskResult {
  const config = (getFixtureGuestConfig(vmid) ?? {}) as Record<string, unknown>;
  const disk = nextDiskIndex(config, vmid);
  let slot: string;
  let value: string;

  if (type === 'qemu' && isQemuBody(body)) {
    const index = nextFreeIndex(config, body.bus, BUS_SLOT_COUNTS[body.bus]);
    if (index === undefined) {
      throw new GuestActionError(400, `The ${body.bus} bus has no free slot; choose another bus.`);
    }
    slot = `${body.bus}${index}`;
    const parts = [`${body.storage}:vm-${vmid}-disk-${disk}`, `size=${body.sizeGiB}G`];
    if (body.format !== undefined) parts.push(`format=${body.format}`);
    if (body.discard === true) parts.push('discard=on');
    if (body.ssd === true) parts.push('ssd=1');
    if (body.iothread === true) parts.push('iothread=1');
    if (body.cache !== undefined) parts.push(`cache=${body.cache}`);
    if (body.backup === false) parts.push('backup=0');
    value = parts.join(',');
  } else if (type === 'lxc' && !isQemuBody(body)) {
    const index = nextFreeIndex(config, 'mp', 256);
    if (index === undefined) {
      throw new GuestActionError(400, 'This container has no free mount point slot.');
    }
    slot = `mp${index}`;
    const parts = [`${body.storage}:subvol-${vmid}-disk-${disk}`, `mp=${body.mountPoint}`, `size=${body.sizeGiB}G`];
    if (body.backup === false) parts.push('backup=0');
    if (body.acl === true) parts.push('acl=1');
    if (body.readOnly === true) parts.push('ro=1');
    value = parts.join(',');
  } else {
    throw new GuestActionError(400, `The request does not fit a ${type} guest.`);
  }

  patchFixtureGuestConfig(node, type, vmid, { [slot]: value });
  return { ok: true, slot, pending: [] };
}

function fixtureDetachDisk(node: string, type: GuestType, vmid: number, slot: string): DetachDiskResult {
  const config = (getFixtureGuestConfig(vmid) ?? {}) as Record<string, unknown>;
  const current = config[slot];
  if (typeof current !== 'string') {
    throw new GuestActionError(404, `${slot} is not present on this guest.`);
  }
  const index = nextFreeIndex(config, 'unused', 256) ?? 0;
  const unusedSlot = `unused${index}`;
  const volume = current.split(',')[0] ?? current;
  patchFixtureGuestConfig(node, type, vmid, { [slot]: undefined, [unusedSlot]: volume });
  return { ok: true, unusedSlot, pending: [] };
}

function fixtureRemoveUnusedDisk(node: string, type: GuestType, vmid: number, slot: string): void {
  if (!/^unused\d+$/.test(slot)) {
    throw new GuestActionError(400, `${slot} is not an unused disk; detach it first.`);
  }
  const config = (getFixtureGuestConfig(vmid) ?? {}) as Record<string, unknown>;
  if (typeof config[slot] !== 'string') {
    throw new GuestActionError(404, `${slot} is not present on this guest.`);
  }
  patchFixtureGuestConfig(node, type, vmid, { [slot]: undefined });
}

// --- public API ---------------------------------------------------------------------------------

/**
 * Adds a disk (qemu) or mount point (lxc). Real mode:
 * `POST /api/actions/guest/:node/:type/:vmid/disks`; the server picks the slot. Fixture mode:
 * appends a matching drive to the in-memory fixture config.
 */
export async function addDisk(
  node: string,
  type: GuestType,
  vmid: number,
  body: AddDiskBody,
): Promise<AddDiskResult> {
  if (USE_FIXTURES) {
    return fixtureAddDisk(node, type, vmid, body);
  }

  const res = await fetch(`/api/actions/guest/${node}/${type}/${vmid}/disks`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (res.status === 200) {
    return (await res.json()) as AddDiskResult;
  }
  return throwActionError(res);
}

/**
 * Detaches a disk: PVE keeps the volume as `unused[n]` until it is removed. Real mode:
 * `POST .../disks/:slot/detach`. Fixture mode: moves the drive to the next free `unused[n]`.
 */
export async function detachDisk(
  node: string,
  type: GuestType,
  vmid: number,
  slot: string,
): Promise<DetachDiskResult> {
  if (USE_FIXTURES) {
    return fixtureDetachDisk(node, type, vmid, slot);
  }

  const res = await fetch(`/api/actions/guest/${node}/${type}/${vmid}/disks/${encodeURIComponent(slot)}/detach`, {
    method: 'POST',
  });
  if (res.status === 200) {
    return (await res.json()) as DetachDiskResult;
  }
  return throwActionError(res);
}

/**
 * Permanently destroys an unused volume -- irreversible. Real mode:
 * `DELETE .../disks/:slot` (the server only accepts `unused[n]` slots). Fixture mode: deletes the
 * `unused[n]` key.
 */
export async function removeUnusedDisk(
  node: string,
  type: GuestType,
  vmid: number,
  slot: string,
): Promise<{ ok: true }> {
  if (USE_FIXTURES) {
    fixtureRemoveUnusedDisk(node, type, vmid, slot);
    return { ok: true };
  }

  const res = await fetch(`/api/actions/guest/${node}/${type}/${vmid}/disks/${encodeURIComponent(slot)}`, {
    method: 'DELETE',
  });
  if (res.status === 200) {
    return { ok: true };
  }
  return throwActionError(res);
}

/**
 * The image formats each image-capable storage on `node` supports:
 * `GET /nodes/{node}/storage?content=images&format=1` through the read-only proxy, mapped storage
 * id -> formats. A storage the listing carries no format data for is simply absent from the map --
 * callers fall back to `inferStorageFormats(plugintype)`. Fixture mode returns an empty map (the
 * dialog then infers everything from the fixture storages' plugin types).
 */
export async function getStorageFormats(node: string): Promise<Record<string, StorageFormatInfo>> {
  if (USE_FIXTURES) return {};

  const res = await fetch(`/api/pve/nodes/${node}/storage?content=images&format=1`);
  if (!res.ok) throw new Error(`Failed to load storage formats for ${node}: ${res.status}`);
  const envelope = (await res.json()) as { data?: unknown };
  const map: Record<string, StorageFormatInfo> = {};
  if (!Array.isArray(envelope.data)) return map;
  for (const row of envelope.data as Array<Record<string, unknown>>) {
    if (typeof row.storage !== 'string') continue;
    const info = parseFormatInfo(row);
    if (info) {
      map[row.storage] = info;
    } else if (typeof row.type === 'string') {
      map[row.storage] = inferStorageFormats(row.type);
    }
  }
  return map;
}

/** One storage a new disk / mount point can be placed on. */
export interface DiskStorage {
  id: string;
  /** PVE plugin type (`dir`, `lvmthin`, `zfspool`, ...), when the cluster resources carry it. */
  plugintype?: string | undefined;
  /** Free bytes (`maxdisk - disk`), when the cluster resources carry both. */
  freeBytes?: number | undefined;
}

/** A PVE storage content type (the comma-separated `content` list on a storage row). */
export type StorageContentKind = 'images' | 'rootdir' | 'iso' | 'vztmpl';

/**
 * The storages on `node` that list `content` among their content types, from the cluster
 * resources' storage rows. `diskCapableStorages` below is this for the disk case; the create
 * wizards (`api/create.ts`) use it for ISO / template / disk placement.
 */
export function storagesWithContent(
  resources: ClusterResource[] | undefined,
  node: string,
  content: StorageContentKind,
): DiskStorage[] {
  const out: DiskStorage[] = [];
  for (const r of resources ?? []) {
    if (r.type !== 'storage' || r.node !== node || r.storage === undefined) continue;
    if (!(r.content ?? '').split(',').includes(content)) continue;
    out.push({
      id: r.storage,
      plugintype: r.plugintype,
      freeBytes: r.maxdisk !== undefined && r.disk !== undefined ? Math.max(0, r.maxdisk - r.disk) : undefined,
    });
  }
  return out;
}

/**
 * The storages on `node` that can hold a new disk: `images` content for a qemu guest, `rootdir`
 * for a lxc mount point, from the cluster resources' storage rows.
 */
export function diskCapableStorages(
  resources: ClusterResource[] | undefined,
  node: string,
  type: GuestType,
): DiskStorage[] {
  return storagesWithContent(resources, node, type === 'qemu' ? 'images' : 'rootdir');
}
