// Curated PVE response shapes come from the generated/hand-maintained package so this app
// doesn't re-derive them from the schema by hand. Only `import type` is used here -- the
// package's runtime (PveHttp/PveClient, which pull in undici) must never end up in the
// browser bundle. See scripts/screenshot.ts / the T4b ticket for the bundle-size check.
import type {
  AgentNetworkInterface,
  ClusterTask,
  QemuConfig,
  RrdDataPoint,
  StorageContentItem,
} from '@proxion/pve-api';

export type { QemuConfig };

export type ResourceType = 'node' | 'qemu' | 'lxc' | 'storage' | 'sdn' | 'pool';

export type GuestType = 'qemu' | 'lxc';

/**
 * A single row from GET /cluster/resources. Fields are a superset across resource types.
 * Deliberately a local, flat "superset" shape rather than `@proxion/pve-api`'s curated
 * discriminated union: this app (InventoryTree, the tree builder, the object-page headers,
 * this ticket's Dashboard/tab code, ...) reads fields off resources generically across types
 * without narrowing first, which the strict union actively rejects. Adopting the union here
 * would mean narrowing every one of those call sites -- several of them outside this ticket's
 * write set and being edited concurrently by other tickets -- so this type stays local.
 */
export interface ClusterResource {
  id: string;
  type: ResourceType;
  node: string;
  status: string;
  vmid?: number | undefined;
  name?: string | undefined;
  template?: 0 | 1 | undefined;
  cpu?: number | undefined;
  maxcpu?: number | undefined;
  mem?: number | undefined;
  maxmem?: number | undefined;
  disk?: number | undefined;
  maxdisk?: number | undefined;
  netin?: number | undefined;
  netout?: number | undefined;
  diskread?: number | undefined;
  diskwrite?: number | undefined;
  uptime?: number | undefined;
  tags?: string | undefined;
  storage?: string | undefined;
  plugintype?: string | undefined;
  content?: string | undefined;
  shared?: 0 | 1 | undefined;
  level?: string | undefined;
}

/** A single row from GET /cluster/tasks (and per-node task lists). Re-exported under our name. */
export type PveTask = ClusterTask;

export type TaskState = 'running' | 'ok' | 'error';

/** Meta-information about the node's boot firmware (`GET /nodes/{node}/status` -> `boot-info`). */
export interface NodeBootInfo {
  mode: 'efi' | 'legacy-bios';
  secureboot?: boolean | undefined;
}

/**
 * `GET /nodes/{node}/status`. Mirrors `@proxion/pve-api`'s curated `NodeStatus` shape but stays
 * local: `NodeStatus.loadavg` is a fixed 3-tuple, stricter than plain JSON fixture data can
 * satisfy without an `as const` rewrite, and this also picks up the real `boot-info` block
 * that curated type doesn't carry yet.
 */
export interface NodeStatusCurrent {
  cpu: number;
  cpuinfo: {
    cpus: number;
    sockets?: number | undefined;
    cores?: number | undefined;
    model?: string | undefined;
    mhz?: string | undefined;
  };
  memory: { total: number; used: number; free: number };
  swap?: { total: number; used: number; free: number } | undefined;
  rootfs?: { total: number; used: number; free: number } | undefined;
  uptime: number;
  loadavg: string[];
  pveversion?: string | undefined;
  kversion?: string | undefined;
  'boot-info'?: NodeBootInfo | undefined;
}

/**
 * GET /nodes/{node}/{qemu|lxc}/{vmid}/config (fields we surface; PVE returns many more).
 * Deliberately a local, loose, union-of-qemu-and-lxc view type -- `@proxion/pve-api`'s
 * `QemuConfig` only covers the qemu shape, and this app renders both guest types through one
 * generic config object (disks/nets keyed by `scsiN`/`netN`/`rootfs`/`mpN`, etc.).
 */
export interface GuestConfig {
  cores?: number | undefined;
  sockets?: number | undefined;
  cpu?: string | undefined;
  memory?: number | string | undefined;
  numa?: 0 | 1 | undefined;
  ostype?: string | undefined;
  boot?: string | undefined;
  agent?: string | number | undefined;
  bios?: string | undefined;
  machine?: string | undefined;
  scsihw?: string | undefined;
  efidisk0?: string | undefined;
  tpmstate0?: string | undefined;
  vga?: string | undefined;
  description?: string | undefined;
  tags?: string | undefined;
  name?: string | undefined;
  hostname?: string | undefined;
  unprivileged?: number | undefined;
  features?: string | undefined;
  swap?: number | undefined;
  rootfs?: string | undefined;
  /** Balloon target in MiB; `0` means ballooning is disabled, absent means not configured. */
  balloon?: number | undefined;
  [diskOrNetOrMp: string]: string | number | undefined;
}

export interface AgentInterfacesResult {
  result: AgentNetworkInterface[];
}
export type { AgentNetworkInterface };

export type RrdTimeframe = 'hour' | 'day' | 'week' | 'month' | 'year';
export type RrdPoint = RrdDataPoint;

export interface ClusterTotals {
  nodesOnline: number;
  nodesTotal: number;
  vmsRunning: number;
  vmsStopped: number;
  ctsRunning: number;
  ctsStopped: number;
  storageUsed: number;
  storageTotal: number;
}

/** `GET /nodes/{node}/network` row (a subset of fields; PVE returns many more per iface type). */
export interface NodeNetworkInterface {
  iface: string;
  type: string;
  method?: string | undefined;
  active?: boolean | undefined;
  autostart?: boolean | undefined;
  cidr?: string | undefined;
  gateway?: string | undefined;
  bridge_ports?: string | undefined;
  bridge_vlan_aware?: boolean | undefined;
  comments?: string | undefined;
}

/** `GET /nodes/{node}/services` row. */
export interface NodeService {
  service: string;
  name: string;
  desc: string;
  state: string;
}

/** `GET /nodes/{node}/tasks/{upid}/log` row. */
export interface TaskLogLine {
  n: number;
  t: string;
}

/**
 * `GET /nodes/{node}/{qemu|lxc}/{vmid}/snapshot` row.
 * `name: "current"` is the live-state sentinel PVE always includes; the tree builder in
 * `lib/snapshots.ts` renders it as the "NOW" leaf rather than a real snapshot.
 */
export interface Snapshot {
  name: string;
  description?: string | undefined;
  parent?: string | undefined;
  snaptime?: number | undefined;
  vmstate?: boolean | undefined;
}

export type { StorageContentItem };

/**
 * `StorageContentItem` plus the two fields real PVE returns that `@proxion/pve-api`'s
 * hand-curated type doesn't carry yet (useful for the Backups tab).
 */
export interface BackupContentItem extends StorageContentItem {
  protected?: boolean | undefined;
  verification?: { state: string; upid: string } | undefined;
}
