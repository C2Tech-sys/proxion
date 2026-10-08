import { USE_FIXTURES } from '@/api/client';
import { GuestActionError } from '@/api/actions';
import {
  FIXTURE_QEMU_MACHINES,
  applyFixtureFirmware,
  getFixtureFirmwarePending,
  getFixtureGuestConfig,
} from '@/api/fixtures';

/**
 * VM firmware / platform hardware (T72): the web side of
 * `PUT /api/actions/guest/:node/qemu/:vmid/firmware` (`apps/server/src/actions/firmwareRoutes.ts`)
 * plus the node's machine-type list (`GET /nodes/{node}/capabilities/qemu/machines`, read through
 * the read-only `/api/pve/*` proxy). Fixture mode is handled inline in each function, same
 * convention as `hardware.ts`.
 */

export type FirmwareBios = 'seabios' | 'ovmf';
export type MachineFamily = 'i440fx' | 'q35';
export type ViommuKind = 'intel' | 'virtio';

export interface MachineSpec {
  type: MachineFamily;
  /** A pinned version (`8.1`, `9.0+pve1`); absent = the latest the node offers. */
  version?: string;
  viommu?: ViommuKind;
}

export interface VgaSpec {
  type: string;
  /** MiB. */
  memory?: number;
}

export interface EfiDiskSpec {
  storage: string;
  efitype?: '2m' | '4m';
  preEnrolledKeys?: boolean;
}

export interface TpmStateSpec {
  storage: string;
  version: 'v1.2' | 'v2.0';
}

/** The route's body: every field optional, at least one required. `null` machine/vga resets the
 * key to PVE's default. */
export interface FirmwareBody {
  bios?: FirmwareBios;
  machine?: MachineSpec | null;
  vga?: VgaSpec | null;
  scsihw?: string;
  efidisk?: EfiDiskSpec;
  tpmstate?: TpmStateSpec;
  digest?: string;
}

export interface FirmwareUpdateResult {
  ok: true;
  /** The PVE config keys that were sent (`efidisk0`, `tpmstate0`, `machine`, ...). */
  changed: string[];
  /** The subset of `changed` PVE is holding back until the guest restarts. */
  pending: string[];
}

/** One row of `GET /nodes/{node}/capabilities/qemu/machines`. */
export interface QemuMachine {
  id: string;
  type: MachineFamily;
  version: string;
  changes?: string;
}

/** PVE's `machine` string for a spec: `pc` / `pc-i440fx-<v>` / `q35` / `pc-q35-<v>` + `,viommu=<x>`. */
export function composeMachine(machine: MachineSpec): string {
  const base =
    machine.type === 'q35'
      ? machine.version
        ? `pc-q35-${machine.version}`
        : 'q35'
      : machine.version
        ? `pc-i440fx-${machine.version}`
        : 'pc';
  return machine.viommu ? `${base},viommu=${machine.viommu}` : base;
}

/** The inverse of `composeMachine` for a config value; an absent value is PVE's default (i440fx,
 * latest). `undefined` for a value this UI does not model (e.g. `virt` on arm). */
export function parseMachine(raw: string | number | undefined): MachineSpec | undefined {
  if (raw === undefined || raw === '') return { type: 'i440fx' };
  const [head, ...options] = String(raw).split(',');
  const viommuOption = options.find((o) => o.startsWith('viommu='))?.slice('viommu='.length);
  const viommu = viommuOption === 'intel' || viommuOption === 'virtio' ? viommuOption : undefined;
  const withViommu = (spec: MachineSpec): MachineSpec => (viommu ? { ...spec, viommu } : spec);
  if (head === 'q35') return withViommu({ type: 'q35' });
  if (head === 'pc') return withViommu({ type: 'i440fx' });
  const q35 = /^pc-q35-(.+)$/.exec(head ?? '');
  if (q35?.[1]) return withViommu({ type: 'q35', version: q35[1] });
  const i440 = /^pc-i440fx-(.+)$/.exec(head ?? '');
  if (i440?.[1]) return withViommu({ type: 'i440fx', version: i440[1] });
  // Very old releases name an i440fx machine just `pc-<version>`.
  const legacy = /^pc-(\d.*)$/.exec(head ?? '');
  if (legacy?.[1]) return withViommu({ type: 'i440fx', version: legacy[1] });
  return undefined;
}

/** PVE's `vga` string: `<type>[,memory=<MiB>]`. */
export function composeVga(vga: VgaSpec): string {
  return vga.memory !== undefined ? `${vga.type},memory=${vga.memory}` : vga.type;
}

/** The inverse of `composeVga`; an absent value is PVE's default (`std`). */
export function parseVga(raw: string | number | undefined): VgaSpec {
  if (raw === undefined || raw === '') return { type: 'std' };
  const [type, ...options] = String(raw).split(',');
  const memory = options.find((o) => o.startsWith('memory='))?.slice('memory='.length);
  const parsed = memory !== undefined && /^\d+$/.test(memory) ? Number(memory) : undefined;
  return { type: type || 'std', ...(parsed !== undefined ? { memory: parsed } : {}) };
}

/** What a request writes to the guest's config: keys to set, keys to delete. The same mapping the
 * server applies (`firmwareRoutes.ts`), used by the demo mode to patch its in-memory config. */
export function firmwareToConfig(body: FirmwareBody, vmid: number): { set: Record<string, string>; remove: string[] } {
  const set: Record<string, string> = {};
  const remove: string[] = [];
  if (body.bios !== undefined) set.bios = body.bios;
  if (body.machine === null) remove.push('machine');
  else if (body.machine !== undefined) set.machine = composeMachine(body.machine);
  if (body.vga === null) remove.push('vga');
  else if (body.vga !== undefined) set.vga = composeVga(body.vga);
  if (body.scsihw !== undefined) set.scsihw = body.scsihw;
  if (body.efidisk !== undefined) {
    set.efidisk0 = `${body.efidisk.storage}:vm-${vmid}-disk-8,efitype=${body.efidisk.efitype ?? '4m'},pre-enrolled-keys=${
      body.efidisk.preEnrolledKeys === false ? 0 : 1
    },size=4M`;
  }
  if (body.tpmstate !== undefined) {
    set.tpmstate0 = `${body.tpmstate.storage}:vm-${vmid}-disk-9,size=4M,version=${body.tpmstate.version}`;
  }
  return { set, remove };
}

interface FirmwareErrorBody {
  error?: string;
  message?: string;
  missing?: string;
}

/** Same short mapping `hardware.ts` uses for every guest action (its own copy is module-private). */
function describeError(status: number, statusText: string, body: FirmwareErrorBody | undefined): string {
  if (body?.message) return body.message;
  switch (body?.error) {
    case 'writes-disabled-in-token-mode':
      return 'Read-only: signed in with a service token';
    case 'forbidden':
      return body?.missing ? `You don't have ${body.missing} for this change` : "You don't have permission for this";
    case 'pve-unreachable':
      return 'Proxmox VE is unreachable';
    default:
      return body?.error ?? `Request failed: ${status} ${statusText}`;
  }
}

/**
 * Requests one firmware edit. Real mode: `PUT /api/actions/guest/:node/qemu/:vmid/firmware`.
 * Fixture mode: patches the in-memory fixture config and records "pending" while the guest runs.
 */
export async function updateFirmware(node: string, vmid: number, body: FirmwareBody): Promise<FirmwareUpdateResult> {
  if (USE_FIXTURES) {
    const { set, remove } = firmwareToConfig(body, vmid);
    const current = getFixtureGuestConfig(vmid) ?? {};
    if (set.efidisk0 !== undefined && current.efidisk0 !== undefined) {
      throw new GuestActionError(400, 'This VM already has an EFI disk.');
    }
    if (set.tpmstate0 !== undefined && current.tpmstate0 !== undefined) {
      throw new GuestActionError(400, 'This VM already has a TPM state disk.');
    }
    return { ok: true, ...applyFixtureFirmware(node, vmid, set, remove) };
  }

  const res = await fetch(`/api/actions/guest/${node}/qemu/${vmid}/firmware`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (res.status === 200) {
    return (await res.json()) as FirmwareUpdateResult;
  }
  let errorBody: FirmwareErrorBody | undefined;
  try {
    errorBody = (await res.json()) as FirmwareErrorBody;
  } catch {
    errorBody = undefined;
  }
  throw new GuestActionError(res.status, describeError(res.status, res.statusText, errorBody));
}

/** The machine types this node's PVE offers: `GET /nodes/{node}/capabilities/qemu/machines`
 * through the read-only proxy. Fixture mode serves a static list. */
export async function getQemuMachines(node: string): Promise<QemuMachine[]> {
  if (USE_FIXTURES) {
    return FIXTURE_QEMU_MACHINES;
  }

  const res = await fetch(`/api/pve/nodes/${node}/capabilities/qemu/machines`);
  if (!res.ok) throw new Error(`Failed to load machine types for ${node}: ${res.status}`);
  const envelope = (await res.json()) as { data?: unknown };
  if (!Array.isArray(envelope.data)) return [];
  return (envelope.data as Array<{ id?: unknown; type?: unknown; version?: unknown; changes?: unknown }>)
    .filter(
      (m): m is { id: string; type: MachineFamily; version: string; changes?: unknown } =>
        typeof m.id === 'string' && (m.type === 'q35' || m.type === 'i440fx') && typeof m.version === 'string',
    )
    .map((m) => ({
      id: m.id,
      type: m.type,
      version: m.version,
      ...(typeof m.changes === 'string' ? { changes: m.changes } : {}),
    }));
}

/** The pinned versions the node offers for one machine family, newest first (`pc-q35-8.1` -> `8.1`).
 * The unversioned aliases (`pc`, `q35`) are what "Latest (default)" means, so they are left out. */
export function machineVersions(machines: QemuMachine[], family: MachineFamily): string[] {
  const prefix = family === 'q35' ? 'pc-q35-' : 'pc-i440fx-';
  const versions = machines
    .filter((m) => m.type === family && m.id.startsWith(prefix))
    .map((m) => m.id.slice(prefix.length));
  return [...new Set(versions)].sort(compareVersionsDesc);
}

function compareVersionsDesc(a: string, b: string): number {
  const nums = (v: string) => v.split(/[.+]/).map((p) => (/^\d+$/.test(p) ? Number(p) : 0));
  const x = nums(a);
  const y = nums(b);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (y[i] ?? 0) - (x[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

/** Demo mode only: the keys the demo is holding back for a running guest. */
export function getFirmwareFixturePending(vmid: number): string[] {
  return getFixtureFirmwarePending(vmid);
}
