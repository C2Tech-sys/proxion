import { USE_FIXTURES } from '@/api/client';
import { GuestActionError } from '@/api/actions';
import {
  areFixtureHostListsForbidden,
  fixtureHostPci,
  fixtureHostUsb,
  fixturePciMappings,
  fixtureUsbMappings,
  getFixtureGuestByVmid,
  getFixtureGuestConfig,
  patchFixtureGuestConfig,
  type HardwareMapping,
  type HostPciDevice,
  type HostUsbDevice,
} from '@/api/fixtures';
import { nextFreeDeviceSlot, unmodeledDeviceParts, type DeviceKind } from '@/lib/pve-config';

/**
 * VM USB, PCI and serial devices (T55): the web side of `PUT/DELETE .../devices/:slot` and
 * `GET .../devices/next-slot` (`apps/server/src/actions/deviceRoutes.ts`) plus the read-only host
 * device and hardware-mapping lookups the dialogs' pickers need (via the read-only `/api/pve/*`
 * proxy). qemu only. Fixture mode is handled inline in each function (same convention as
 * `network.ts`).
 */

interface PciOptions {
  /** PCI-Express (needs the q35 machine type). */
  pcie?: boolean;
  /** `false` turns the ROM BAR off (`rombar=0`); omit for PVE's default (on). */
  rombar?: boolean;
  /** Primary GPU (`x-vga=1`). */
  xVga?: boolean;
  mdev?: string;
}

/** Body for `upsertDevice`: the FULL desired state of the device (the server drops every option an
 * edit leaves out, except ones it does not model, which it keeps). Matches the server's strict
 * contract. */
export type DeviceBody =
  | { kind: 'usb'; source: 'spice'; usb3?: boolean }
  | { kind: 'usb'; source: 'vendor'; id: string; usb3?: boolean }
  | { kind: 'usb'; source: 'port'; port: string; usb3?: boolean }
  | { kind: 'usb'; source: 'mapping'; mapping: string; usb3?: boolean }
  | ({ kind: 'pci'; source: 'raw'; id: string; allFunctions?: boolean } & PciOptions)
  | ({ kind: 'pci'; source: 'mapping'; mapping: string } & PciOptions)
  | { kind: 'serial'; target: 'socket' };

export interface DeviceSaveResult {
  ok: true;
  changed: string[];
  /** `[slot]` when PVE holds the change back until the guest restarts. */
  pending: string[];
}

export interface DeviceRemoveResult {
  ok: true;
  pending: string[];
}

/** A host/mapping lookup result. `forbidden` = PVE refused the list (it needs `Sys.Modify` for the
 * host lists and `Mapping.Audit` for mappings): the dialog then falls back to manual entry. */
export interface DeviceLookup<T> {
  items: T[];
  forbidden: boolean;
}

interface DeviceErrorBody {
  error?: string;
  message?: string;
  missing?: string;
}

/** Same short, human-readable mapping `network.ts` uses (module-private there, so a deliberate
 * duplicate rather than an edit to that file). */
function describeError(status: number, statusText: string, body: DeviceErrorBody | undefined): string {
  if (body?.message) return body.message;
  switch (body?.error) {
    case 'writes-disabled-in-token-mode':
      return 'Read-only: signed in with a service token';
    case 'forbidden':
      return body?.missing ? `You don't have ${body.missing} on this guest` : "You don't have permission for this";
    case 'not-found':
      return 'That device no longer exists';
    case 'pve-unreachable':
      return 'Proxmox VE is unreachable';
    default:
      return body?.error ?? `Request failed: ${status} ${statusText}`;
  }
}

async function throwActionError(res: Response): Promise<never> {
  let errorBody: DeviceErrorBody | undefined;
  try {
    errorBody = (await res.json()) as DeviceErrorBody;
  } catch {
    errorBody = undefined;
  }
  throw new GuestActionError(res.status, describeError(res.status, res.statusText, errorBody));
}

// --- fixture (demo) mode ----------------------------------------------------------------------

function stripPciFunction(id: string): string {
  const dot = id.lastIndexOf('.');
  return dot === -1 ? id : id.slice(0, dot);
}

/** Composes the property string exactly as the server route does -- fixture mode stores it in the
 * in-memory config, so the Hardware tab re-reads it through the same parser a real config goes
 * through. */
export function composeDeviceValue(body: DeviceBody, extras: readonly string[] = []): string {
  if (body.kind === 'serial') return body.target;
  const parts: string[] = [];
  if (body.kind === 'usb') {
    if (body.source === 'spice') parts.push('host=spice');
    else if (body.source === 'vendor') parts.push(`host=${body.id}`);
    else if (body.source === 'port') parts.push(`host=${body.port}`);
    else parts.push(`mapping=${body.mapping}`);
    if (body.usb3 === true) parts.push('usb3=1');
  } else {
    if (body.source === 'raw') parts.push(body.allFunctions === true ? stripPciFunction(body.id) : body.id);
    else parts.push(`mapping=${body.mapping}`);
    if (body.pcie === true) parts.push('pcie=1');
    if (body.rombar === false) parts.push('rombar=0');
    if (body.xVga === true) parts.push('x-vga=1');
    if (body.mdev !== undefined) parts.push(`mdev=${body.mdev}`);
  }
  parts.push(...extras);
  return parts.join(',');
}

function fixtureUpsertDevice(node: string, vmid: number, slot: string, body: DeviceBody): DeviceSaveResult {
  const raw = getFixtureGuestConfig(vmid)?.[slot];
  const existing = typeof raw === 'string' ? raw : undefined;
  const extras = body.kind === 'serial' ? [] : unmodeledDeviceParts(body.kind, existing);
  patchFixtureGuestConfig(node, 'qemu', vmid, { [slot]: composeDeviceValue(body, extras) });
  // A running guest hot-plugs a new USB/PCI device; editing one, and any serial port, waits for a restart.
  const held = getFixtureGuestByVmid(vmid)?.status === 'running' && (existing !== undefined || body.kind === 'serial');
  return { ok: true, changed: [slot], pending: held ? [slot] : [] };
}

function fixtureRemoveDevice(node: string, vmid: number, slot: string): DeviceRemoveResult {
  if (getFixtureGuestConfig(vmid)?.[slot] === undefined) {
    throw new GuestActionError(404, `${slot} does not exist on this guest`);
  }
  patchFixtureGuestConfig(node, 'qemu', vmid, { [slot]: undefined });
  return { ok: true, pending: [] };
}

// --- public API -------------------------------------------------------------------------------

/**
 * Creates or edits one device. Real mode: `PUT /api/actions/guest/:node/qemu/:vmid/devices/:slot`.
 * Fixture mode: writes the composed value into the in-memory fixture config.
 */
export async function upsertDevice(
  node: string,
  vmid: number,
  slot: string,
  body: DeviceBody,
): Promise<DeviceSaveResult> {
  if (USE_FIXTURES) {
    return fixtureUpsertDevice(node, vmid, slot, body);
  }

  const res = await fetch(`/api/actions/guest/${node}/qemu/${vmid}/devices/${slot}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (res.status === 200) {
    return (await res.json()) as DeviceSaveResult;
  }
  return throwActionError(res);
}

/** Removes one device: `DELETE /api/actions/guest/:node/qemu/:vmid/devices/:slot`. */
export async function deleteDevice(node: string, vmid: number, slot: string): Promise<DeviceRemoveResult> {
  if (USE_FIXTURES) {
    return fixtureRemoveDevice(node, vmid, slot);
  }

  const res = await fetch(`/api/actions/guest/${node}/qemu/${vmid}/devices/${slot}`, { method: 'DELETE' });
  if (res.status === 200) {
    return (await res.json()) as DeviceRemoveResult;
  }
  return throwActionError(res);
}

/** The lowest unused slot of `kind`: `GET .../devices/next-slot?kind=usb|pci|serial` (session-only). */
export async function getNextDeviceSlot(node: string, vmid: number, kind: DeviceKind): Promise<string> {
  if (USE_FIXTURES) {
    const slot = nextFreeDeviceSlot(getFixtureGuestConfig(vmid) ?? {}, kind);
    if (slot === undefined) throw new GuestActionError(409, `All ${kind} device slots are in use`);
    return slot;
  }

  const res = await fetch(`/api/actions/guest/${node}/qemu/${vmid}/devices/next-slot?kind=${kind}`);
  if (res.status === 200) {
    const json = (await res.json()) as { slot: string };
    return json.slot;
  }
  return throwActionError(res);
}

/** Reads one list through the read-only proxy; a 403 (missing `Sys.Modify` / `Mapping.Audit`) is
 * `{ items: [], forbidden: true }` rather than an error, anything else non-OK throws. */
async function readList<T>(path: string, what: string, map: (raw: unknown[]) => T[]): Promise<DeviceLookup<T>> {
  const res = await fetch(path);
  if (res.status === 403) return { items: [], forbidden: true };
  if (!res.ok) throw new Error(`Failed to load ${what}: ${res.status}`);
  const envelope = (await res.json()) as { data?: unknown };
  return { items: Array.isArray(envelope.data) ? map(envelope.data) : [], forbidden: false };
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined;
}

/** The node's USB devices: `GET /nodes/{node}/hardware/usb` (needs `Sys.Modify`). */
export async function listHostUsb(node: string): Promise<DeviceLookup<HostUsbDevice>> {
  if (USE_FIXTURES) {
    return areFixtureHostListsForbidden() ? { items: [], forbidden: true } : { items: fixtureHostUsb, forbidden: false };
  }
  return readList(`/api/pve/nodes/${node}/hardware/usb`, `USB devices for ${node}`, (raw) =>
    (raw as Array<Record<string, unknown>>)
      .filter((d) => str(d.vendid) !== undefined && str(d.prodid) !== undefined)
      .map((d) => {
        const vendid = str(d.vendid)!;
        const prodid = str(d.prodid)!;
        const manufacturer = str(d.manufacturer);
        const product = str(d.product);
        const usbpath = str(d.usbpath);
        return {
          id: `${vendid}:${prodid}`,
          vendid,
          prodid,
          ...(manufacturer !== undefined ? { manufacturer } : {}),
          ...(product !== undefined ? { product } : {}),
          ...(usbpath !== undefined ? { usbpath } : {}),
          ...(typeof d.speed === 'number' ? { speed: d.speed } : {}),
        };
      }),
  );
}

/** The node's PCI devices: `GET /nodes/{node}/hardware/pci` (needs `Sys.Modify`). PVE's default
 * class blacklist (bridges and the like) applies. */
export async function listHostPci(node: string): Promise<DeviceLookup<HostPciDevice>> {
  if (USE_FIXTURES) {
    return areFixtureHostListsForbidden() ? { items: [], forbidden: true } : { items: fixtureHostPci, forbidden: false };
  }
  return readList(`/api/pve/nodes/${node}/hardware/pci`, `PCI devices for ${node}`, (raw) =>
    (raw as Array<Record<string, unknown>>)
      .filter((d) => str(d.id) !== undefined)
      .map((d) => {
        const cls = str(d.class);
        const vendor = str(d.vendor_name);
        const device = str(d.device_name);
        return {
          id: str(d.id)!,
          ...(cls !== undefined ? { class: cls } : {}),
          ...(vendor !== undefined ? { vendor_name: vendor } : {}),
          ...(device !== undefined ? { device_name: device } : {}),
          iommugroup: typeof d.iommugroup === 'number' ? d.iommugroup : -1,
        };
      })
      .sort((a, b) => a.iommugroup - b.iommugroup || a.id.localeCompare(b.id)),
  );
}

function mapMappings(raw: unknown[]): HardwareMapping[] {
  return (raw as Array<Record<string, unknown>>)
    .filter((m) => str(m.id) !== undefined)
    .map((m) => {
      const description = str(m.description);
      return { id: str(m.id)!, ...(description !== undefined ? { description } : {}) };
    })
    .sort((a, b) => a.id.localeCompare(b.id));
}

/** The cluster's USB device mappings: `GET /cluster/mapping/usb` (needs `Mapping.Audit`). */
export async function listUsbMappings(): Promise<DeviceLookup<HardwareMapping>> {
  if (USE_FIXTURES) {
    return areFixtureHostListsForbidden() ? { items: [], forbidden: true } : { items: fixtureUsbMappings, forbidden: false };
  }
  return readList('/api/pve/cluster/mapping/usb', 'USB mappings', mapMappings);
}

/** The cluster's PCI device mappings: `GET /cluster/mapping/pci` (needs `Mapping.Audit`). */
export async function listPciMappings(): Promise<DeviceLookup<HardwareMapping>> {
  if (USE_FIXTURES) {
    return areFixtureHostListsForbidden() ? { items: [], forbidden: true } : { items: fixturePciMappings, forbidden: false };
  }
  return readList('/api/pve/cluster/mapping/pci', 'PCI mappings', mapMappings);
}
