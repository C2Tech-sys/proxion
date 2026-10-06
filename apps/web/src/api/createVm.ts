import { USE_FIXTURES } from '@/api/client';
import { GuestActionError } from '@/api/actions';
import { addFixtureGuest, addFixtureGuestConfig, getFixtureGuestByVmid } from '@/api/fixtures';
import type { DiskBus, DiskCache, DiskFormat } from '@/api/disks';
import type { GuestConfig } from '@/api/types';

/**
 * The web side of `POST /api/actions/guest/:node/qemu/create` (`apps/server/src/actions/
 * createVmRoutes.ts`, T61): the typed body the Create VM wizard builds, the request, and the
 * fixture (demo) implementation, which adds the guest to the in-memory fixtures.
 */

export type CreateVmMachine = 'q35' | 'pc';
export type CreateVmBios = 'seabios' | 'ovmf';
export type CreateVmScsiHw = 'virtio-scsi-single' | 'virtio-scsi-pci' | 'lsi';
export type CreateVmVga = 'std' | 'virtio' | 'qxl' | 'serial0' | 'none';
export type CreateVmNicModel = 'virtio' | 'e1000' | 'e1000e' | 'vmxnet3' | 'rtl8139';

export interface CreateVmDisk {
  bus: DiskBus;
  storage: string;
  sizeGiB: number;
  format?: DiskFormat;
  discard?: boolean;
  ssd?: boolean;
  iothread?: boolean;
  cache?: DiskCache;
}

export interface CreateVmNet {
  model: CreateVmNicModel;
  bridge: string;
  tag?: number;
  firewall: boolean;
  macaddr?: string;
  mtu?: number;
}

/** The request body, field for field what the server route's strict schema accepts. */
export interface CreateVmBody {
  vmid: number;
  name: string;
  pool?: string;
  tags?: string[];
  start: boolean;
  os: { media: 'iso'; storage: string; volid: string } | { media: 'none' };
  ostype: string;
  agent: boolean;
  system: {
    machine: CreateVmMachine;
    bios: CreateVmBios;
    efiStorage?: string;
    tpm?: boolean;
    tpmStorage?: string;
    scsihw: CreateVmScsiHw;
    vga?: CreateVmVga;
  };
  /** `null`: create the VM without a disk. */
  disk: CreateVmDisk | null;
  cpu: { sockets: number; cores: number; type: string; numa?: boolean };
  memory: { memoryMiB: number; balloonMiB?: number };
  /** `null`: create the VM without a network device. */
  net: CreateVmNet | null;
}

export interface CreateVmResult {
  upid: string;
  vmid: number;
}

interface CreateErrorBody {
  error?: string;
  message?: string;
  missing?: string;
  storage?: string;
}

function describeError(status: number, statusText: string, body: CreateErrorBody | undefined): string {
  if (body?.message) return body.message;
  switch (body?.error) {
    case 'writes-disabled-in-token-mode':
      return 'Read-only: signed in with a service token';
    case 'forbidden':
      if (body.missing && body.storage) return `You don't have ${body.missing} on storage ${body.storage}`;
      return body.missing ? `You don't have ${body.missing} for this VM` : "You don't have permission for this";
    case 'vmid-taken':
      return 'That VM ID is already in use';
    case 'pve-unreachable':
      return 'Proxmox VE is unreachable';
    default:
      return body?.error ?? `Request failed: ${status} ${statusText}`;
  }
}

async function throwActionError(res: Response): Promise<never> {
  let errorBody: CreateErrorBody | undefined;
  try {
    errorBody = (await res.json()) as CreateErrorBody;
  } catch {
    errorBody = undefined;
  }
  throw new GuestActionError(res.status, describeError(res.status, res.statusText, errorBody));
}

// --- fixture (demo) mode ----------------------------------------------------------------------

/** A locally-administered unicast MAC in PVE's own `BC:24:11` prefix, like PVE generates. */
function generateMac(): string {
  const byte = () =>
    Math.floor(Math.random() * 256)
      .toString(16)
      .toUpperCase()
      .padStart(2, '0');
  return `BC:24:11:${byte()}:${byte()}:${byte()}`;
}

/**
 * The guest config PVE ends up with, composed like the server route composes the create request
 * (same keys, same property strings, plus the volume names PVE allocates): fixture mode stores it
 * so the new VM's Hardware / Options tabs read it through the same parsers a real config goes
 * through. `mac` is the address PVE would generate for a NIC the body gave none.
 *
 * KEEP IN STEP WITH `composeCreateParams` in `apps/server/src/actions/createVmRoutes.ts`.
 */
export function composeCreateVmConfig(body: CreateVmBody, mac: string = generateMac()): GuestConfig {
  const config: GuestConfig = {
    name: body.name,
    ostype: body.ostype,
    bios: body.system.bios,
    scsihw: body.system.scsihw,
    cores: body.cpu.cores,
    sockets: body.cpu.sockets,
    cpu: body.cpu.type,
    memory: body.memory.memoryMiB,
  };
  if (body.system.machine === 'q35') config.machine = 'q35';
  if (body.agent) config.agent = 'enabled=1';
  if (body.cpu.numa === true) config.numa = 1;
  if (body.memory.balloonMiB !== undefined) config.balloon = body.memory.balloonMiB;
  if (body.system.vga !== undefined) config.vga = body.system.vga;
  if (body.tags !== undefined && body.tags.length > 0) config.tags = body.tags.join(';');
  if (body.system.bios === 'ovmf' && body.system.efiStorage !== undefined) {
    config.efidisk0 = `${body.system.efiStorage}:vm-${body.vmid}-disk-0,efitype=4m,pre-enrolled-keys=1,size=4M`;
  }
  if (body.system.tpm === true && body.system.tpmStorage !== undefined) {
    config.tpmstate0 = `${body.system.tpmStorage}:vm-${body.vmid}-disk-1,size=4M,version=v2.0`;
  }

  const bootOrder: string[] = [];
  if (body.disk !== null) {
    const slot = `${body.disk.bus}0`;
    const parts = [`${body.disk.storage}:vm-${body.vmid}-disk-2`];
    if (body.disk.format !== undefined) parts.push(`format=${body.disk.format}`);
    if (body.disk.discard === true) parts.push('discard=on');
    if (body.disk.ssd === true) parts.push('ssd=1');
    if (body.disk.iothread === true) parts.push('iothread=1');
    if (body.disk.cache !== undefined) parts.push(`cache=${body.disk.cache}`);
    parts.push(`size=${body.disk.sizeGiB}G`);
    config[slot] = parts.join(',');
    bootOrder.push(slot);
  }
  if (body.os.media === 'iso') {
    config.ide2 = `${body.os.volid},media=cdrom`;
    bootOrder.push('ide2');
  }
  if (body.net !== null) {
    const parts = [`${body.net.model}=${body.net.macaddr ?? mac}`, `bridge=${body.net.bridge}`];
    if (body.net.tag !== undefined) parts.push(`tag=${body.net.tag}`);
    if (body.net.firewall) parts.push('firewall=1');
    if (body.net.mtu !== undefined) parts.push(`mtu=${body.net.mtu}`);
    config.net0 = parts.join(',');
    bootOrder.push('net0');
  }
  if (bootOrder.length > 0) config.boot = `order=${bootOrder.join(';')}`;
  return config;
}

let fixtureUpidSeq = 0;

async function fixtureCreateVm(node: string, body: CreateVmBody): Promise<CreateVmResult> {
  if (getFixtureGuestByVmid(body.vmid)) {
    throw new GuestActionError(409, `VM ID ${body.vmid} is already in use`);
  }
  addFixtureGuestConfig(body.vmid, composeCreateVmConfig(body));
  addFixtureGuest({
    id: `qemu/${body.vmid}`,
    type: 'qemu',
    node,
    vmid: body.vmid,
    name: body.name,
    status: body.start ? 'running' : 'stopped',
    template: 0,
    maxcpu: body.cpu.sockets * body.cpu.cores,
    maxmem: body.memory.memoryMiB * 1024 ** 2,
    ...(body.disk !== null ? { maxdisk: body.disk.sizeGiB * 1024 ** 3 } : {}),
    ...(body.tags !== undefined && body.tags.length > 0 ? { tags: body.tags.join(';') } : {}),
  });
  fixtureUpidSeq += 1;
  const seq = fixtureUpidSeq.toString(16).padStart(8, '0');
  return { upid: `UPID:${node}:${seq}:00000000:00000000:qmcreate:${body.vmid}:demo@pve!fixtures:`, vmid: body.vmid };
}

// --- public API -------------------------------------------------------------------------------

/**
 * Creates a VM: `POST /api/actions/guest/:node/qemu/create` (session sign-in only; answers
 * `202 { upid, vmid }`). Fixture mode adds the guest to the in-memory fixtures instead.
 */
export async function createVm(node: string, body: CreateVmBody): Promise<CreateVmResult> {
  if (USE_FIXTURES) {
    return fixtureCreateVm(node, body);
  }

  const res = await fetch(`/api/actions/guest/${encodeURIComponent(node)}/qemu/create`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (res.status === 202) {
    return (await res.json()) as CreateVmResult;
  }
  return throwActionError(res);
}
