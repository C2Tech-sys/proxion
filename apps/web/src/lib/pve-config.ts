import type { GuestConfig } from '@/api/types';

const DISK_KEY = /^(scsi|virtio|sata|ide)\d+$/;
const NET_KEY = /^net\d+$/;
const NIC_MODELS = ['virtio', 'e1000', 'e1000e', 'vmxnet3', 'rtl8139'];

export interface ParsedDisk {
  key: string;
  bus: string;
  storage: string;
  volume: string;
  size?: string | undefined;
}

export interface ParsedNic {
  key: string;
  model?: string | undefined;
  mac?: string | undefined;
  bridge?: string | undefined;
  firewall?: boolean | undefined;
  name?: string | undefined;
}

function parseKeyValueString(raw: string): Record<string, string> {
  const map: Record<string, string> = {};
  for (const part of raw.split(',')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    map[part.slice(0, eq)] = part.slice(eq + 1);
  }
  return map;
}

/** Parses a PVE disk config string, e.g. `"tank:vm-100-disk-0,size=64G"`. */
export function parseDiskString(key: string, raw: string): ParsedDisk {
  const [storagePart, ...rest] = raw.split(',');
  const [storage, volume] = (storagePart ?? '').split(':');
  const kv = parseKeyValueString(rest.join(','));
  return {
    key,
    bus: key.replace(/\d+$/, ''),
    storage: storage ?? '',
    volume: volume ?? '',
    size: kv.size,
  };
}

/** Parses a PVE net config string for both qemu (`virtio=MAC,bridge=...`) and lxc (`name=eth0,hwaddr=...`) shapes. */
export function parseNetString(key: string, raw: string): ParsedNic {
  const kv = parseKeyValueString(raw);
  const modelKey = NIC_MODELS.find((m) => m in kv);
  return {
    key,
    model: modelKey,
    mac: modelKey ? kv[modelKey] : kv.hwaddr,
    bridge: kv.bridge,
    firewall: kv.firewall === '1',
    name: kv.name,
  };
}

export function getDisks(config: GuestConfig): ParsedDisk[] {
  return Object.entries(config)
    .filter(([key]) => DISK_KEY.test(key))
    .map(([key, value]) => parseDiskString(key, String(value)));
}

export function getRootfs(config: GuestConfig): ParsedDisk | null {
  const raw = config.rootfs;
  if (typeof raw !== 'string') return null;
  return parseDiskString('rootfs', raw);
}

export function getNics(config: GuestConfig): ParsedNic[] {
  return Object.entries(config)
    .filter(([key]) => NET_KEY.test(key))
    .map(([key, value]) => parseNetString(key, String(value)));
}

const OSTYPE_LABELS: Record<string, string> = {
  l26: 'Linux (kernel 2.6+)',
  l24: 'Linux (kernel 2.4)',
  win11: 'Windows 11',
  win10: 'Windows 10',
  win2022: 'Windows Server 2022',
  win2019: 'Windows Server 2019',
  debian: 'Debian (container)',
  ubuntu: 'Ubuntu (container)',
};

export function osTypeLabel(ostype: string | undefined): string {
  if (!ostype) return 'Unknown';
  return OSTYPE_LABELS[ostype] ?? ostype;
}

// --- Richer parsing for the read-only Hardware tab (disks, EFI/TPM, NICs w/ VLAN, mount points) ---

const DRIVE_KEY = /^(scsi|virtio|sata|ide|efidisk|tpmstate|unused|mp)(\d+)$/;
const NET_SPEC_KEY = /^net(\d+)$/;

function truthy(v: string | undefined): boolean {
  return v === '1' || v === 'on' || v === 'true';
}

export interface ParsedDrive {
  key: string;
  bus: string;
  index: number;
  storage: string;
  volume: string;
  size?: string | undefined;
  media?: 'cdrom' | 'disk' | undefined;
  cache?: string | undefined;
  discard?: boolean | undefined;
  ssd?: boolean | undefined;
  iothread?: boolean | undefined;
  format?: string | undefined;
  /** The full key=value bag, for fields (efitype, version, mp, ...) callers render ad hoc. */
  options: Record<string, string>;
}

/**
 * Parses any PVE drive-like config string (`"storage:volume,opt=val,..."`), e.g. a disk,
 * CD-ROM (`media=cdrom`), EFI disk, TPM state drive, or LXC mount point (`mpN`/`rootfs`).
 */
export function parseDriveSpec(key: string, raw: string): ParsedDrive {
  const [storagePart, ...rest] = raw.split(',');
  const [storage, volume] = (storagePart ?? '').split(':');
  const options = parseKeyValueString(rest.join(','));
  const match = DRIVE_KEY.exec(key);
  const media = options.media === 'cdrom' ? 'cdrom' : options.media === 'disk' ? 'disk' : undefined;
  return {
    key,
    bus: match ? match[1]! : key.replace(/\d+$/, ''),
    index: match ? Number(match[2]) : 0,
    storage: storage ?? '',
    volume: volume ?? '',
    size: options.size,
    media,
    cache: options.cache,
    discard: 'discard' in options ? truthy(options.discard) : undefined,
    ssd: 'ssd' in options ? truthy(options.ssd) : undefined,
    iothread: 'iothread' in options ? truthy(options.iothread) : undefined,
    format: options.format,
    options,
  };
}

export interface ParsedNetSpec {
  key: string;
  index: number;
  model?: string | undefined;
  mac?: string | undefined;
  bridge?: string | undefined;
  firewall?: boolean | undefined;
  tag?: number | undefined;
  rate?: string | undefined;
  name?: string | undefined;
  ip?: string | undefined;
  gw?: string | undefined;
  hwaddr?: string | undefined;
  type?: string | undefined;
}

/**
 * Parses a PVE net config string for both the qemu shape (`virtio=MAC,bridge=...,tag=20`) and
 * the lxc shape (`name=eth0,bridge=...,hwaddr=...,ip=dhcp`), including the VLAN tag and rate
 * limit fields the Hardware tab shows that the Summary tab's lighter `parseNetString` skips.
 */
export function parseNetSpec(key: string, raw: string): ParsedNetSpec {
  const kv = parseKeyValueString(raw);
  const modelKey = NIC_MODELS.find((m) => m in kv);
  const match = NET_SPEC_KEY.exec(key);
  return {
    key,
    index: match ? Number(match[1]) : 0,
    model: modelKey,
    mac: modelKey ? kv[modelKey] : undefined,
    bridge: kv.bridge,
    firewall: 'firewall' in kv ? truthy(kv.firewall) : undefined,
    tag: kv.tag !== undefined ? Number(kv.tag) : undefined,
    rate: kv.rate,
    name: kv.name,
    ip: kv.ip,
    gw: kv.gw,
    hwaddr: kv.hwaddr,
    type: kv.type,
  };
}

/**
 * Parses a PVE `boot` config value. Modern configs are `"order=scsi0;net0"`; this returns the
 * ordered device-key list. Legacy configs (`"cdn"`, no `order=` prefix) are returned as their
 * individual single-character device codes since there's no key to look up in `config`.
 */
export function parseBootOrder(raw: string | undefined): string[] {
  if (!raw) return [];
  if (raw.startsWith('order=')) {
    return raw
      .slice('order='.length)
      .split(';')
      .map((s) => s.trim())
      .filter(Boolean);
  }
  return raw.split('');
}

/**
 * Parses a PVE `memory` config value -- an integer count of MiB (occasionally a numeric
 * string) -- into a byte count suitable for `formatBytes`. `null` when unset/unparseable.
 */
export function parseMemory(raw: string | number | undefined): number | null {
  if (raw === undefined) return null;
  const mib = typeof raw === 'number' ? raw : Number(raw);
  if (!Number.isFinite(mib)) return null;
  return mib * 1024 * 1024;
}

/** All `scsiN`/`virtioN`/`sataN`/`ideN`/`efidiskN`/`tpmstateN`/`unusedN`/`mpN` drives on a qemu or lxc config. */
export function getDrives(config: GuestConfig): ParsedDrive[] {
  return Object.entries(config)
    .filter(([key]) => DRIVE_KEY.test(key))
    .map(([key, value]) => parseDriveSpec(key, String(value)));
}

/** The lxc `rootfs` drive, parsed with the same richer shape as `getDrives`. */
export function getRootfsDrive(config: GuestConfig): ParsedDrive | null {
  const raw = config.rootfs;
  if (typeof raw !== 'string') return null;
  return parseDriveSpec('rootfs', raw);
}

/** All `netN` interfaces on a qemu or lxc config, with VLAN tag/rate limit included. */
export function getNetSpecs(config: GuestConfig): ParsedNetSpec[] {
  return Object.entries(config)
    .filter(([key]) => NET_SPEC_KEY.test(key))
    .map(([key, value]) => parseNetSpec(key, String(value)));
}
