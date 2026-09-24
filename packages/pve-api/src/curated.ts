// Hand-written types for Proxmox VE response shapes that are either too
// dynamic (discriminated unions, RRD points) or too widely reused to leave to
// the schema generator. These are curated by hand against the PVE API docs
// and real cluster responses; update them if PVE's shape changes.

/** A single row from `GET /cluster/resources`, discriminated on `type`. */
export interface ClusterResourceNode {
  type: 'node';
  id: string;
  node: string;
  status: 'online' | 'offline' | 'unknown';
  cpu?: number;
  maxcpu?: number;
  mem?: number;
  maxmem?: number;
  disk?: number;
  maxdisk?: number;
  uptime?: number;
  level?: string;
}

export interface ClusterResourceQemu {
  type: 'qemu';
  id: string;
  vmid: number;
  node: string;
  name?: string;
  status: 'running' | 'stopped' | 'paused';
  cpu?: number;
  maxcpu?: number;
  mem?: number;
  maxmem?: number;
  disk?: number;
  maxdisk?: number;
  uptime?: number;
  template?: 0 | 1;
  tags?: string;
  pool?: string;
  hastate?: string;
  netin?: number;
  netout?: number;
  diskread?: number;
  diskwrite?: number;
}

export interface ClusterResourceLxc {
  type: 'lxc';
  id: string;
  vmid: number;
  node: string;
  name?: string;
  status: 'running' | 'stopped';
  cpu?: number;
  maxcpu?: number;
  mem?: number;
  maxmem?: number;
  disk?: number;
  maxdisk?: number;
  uptime?: number;
  template?: 0 | 1;
  tags?: string;
  pool?: string;
  hastate?: string;
}

export interface ClusterResourceStorage {
  type: 'storage';
  id: string;
  storage: string;
  node: string;
  status: 'available' | 'unknown';
  disk?: number;
  maxdisk?: number;
  content?: string;
  plugintype?: string;
  shared?: 0 | 1;
}

export interface ClusterResourceSdn {
  type: 'sdn';
  id: string;
  sdn?: string;
  node?: string;
  status: string;
}

export interface ClusterResourcePool {
  type: 'pool';
  id: string;
  pool: string;
}

export type ClusterResource =
  | ClusterResourceNode
  | ClusterResourceQemu
  | ClusterResourceLxc
  | ClusterResourceStorage
  | ClusterResourceSdn
  | ClusterResourcePool;

export function isNode(resource: ClusterResource): resource is ClusterResourceNode {
  return resource.type === 'node';
}

export function isQemu(resource: ClusterResource): resource is ClusterResourceQemu {
  return resource.type === 'qemu';
}

export function isLxc(resource: ClusterResource): resource is ClusterResourceLxc {
  return resource.type === 'lxc';
}

/** A single row from `GET /cluster/tasks` (and per-node task lists). */
export interface ClusterTask {
  upid: string;
  node: string;
  pid: number;
  pstart: number;
  starttime: number;
  type: string;
  id: string;
  user: string;
  endtime?: number;
  status?: string;
}

/** `GET /nodes/{node}/qemu/{vmid}/status/current`. */
export interface VmStatusCurrent {
  status: 'running' | 'stopped' | 'paused';
  vmid: number;
  name?: string;
  qmpstatus?: string;
  pid?: number;
  uptime?: number;
  cpu?: number;
  cpus?: number;
  mem?: number;
  maxmem?: number;
  disk?: number;
  maxdisk?: number;
  diskread?: number;
  diskwrite?: number;
  netin?: number;
  netout?: number;
  balloon?: number;
  agent?: 0 | 1;
  lock?: string;
  ha?: Record<string, unknown>;
  tags?: string;
}

/** `GET /nodes/{node}/lxc/{vmid}/status/current`. */
export interface LxcStatusCurrent {
  status: 'running' | 'stopped';
  vmid: number;
  name?: string;
  uptime?: number;
  cpu?: number;
  cpus?: number;
  mem?: number;
  maxmem?: number;
  swap?: number;
  maxswap?: number;
  disk?: number;
  maxdisk?: number;
  netin?: number;
  netout?: number;
  lock?: string;
  ha?: Record<string, unknown>;
  tags?: string;
}

/** `GET /nodes/{node}/status`. */
export interface NodeStatus {
  uptime: number;
  loadavg: [string, string, string];
  cpu: number;
  wait?: number;
  idle?: number;
  cpuinfo?: {
    cpus: number;
    sockets?: number;
    cores?: number;
    model?: string;
    mhz?: string;
    hvm?: string;
  };
  memory: { total: number; used: number; free: number };
  swap: { total: number; used: number; free: number };
  rootfs?: { total: number; used: number; free: number; avail?: number };
  kversion?: string;
  pveversion?: string;
  ksm?: { shared: number };
}

/** RRD sample granularity accepted by `.../rrddata` endpoints. */
export type Timeframe = 'hour' | 'day' | 'week' | 'month' | 'year' | 'decade';

/** One point from a `.../rrddata` response. Available fields vary by resource type. */
export interface RrdDataPoint {
  time: number;
  cpu?: number;
  maxcpu?: number;
  mem?: number;
  maxmem?: number;
  disk?: number;
  maxdisk?: number;
  netin?: number;
  netout?: number;
  diskread?: number;
  diskwrite?: number;
  loadavg?: number;
  swap?: number;
  swapmax?: number;
}

/** One entry from the QEMU guest agent's `network-get-interfaces` call. */
export interface AgentNetworkInterfaceAddress {
  'ip-address': string;
  'ip-address-type': 'ipv4' | 'ipv6';
  prefix: number;
  'mac-address'?: string;
}

export interface AgentNetworkInterfaceStatistics {
  'rx-bytes': number;
  'rx-dropped': number;
  'rx-errs': number;
  'rx-packets': number;
  'tx-bytes': number;
  'tx-dropped': number;
  'tx-errs': number;
  'tx-packets': number;
}

export interface AgentNetworkInterface {
  name: string;
  'hardware-address'?: string;
  'ip-addresses'?: AgentNetworkInterfaceAddress[];
  statistics?: AgentNetworkInterfaceStatistics;
}

/** One entry from `GET /nodes/{node}/storage/{storage}/content`. */
export interface StorageContentItem {
  volid: string;
  content: string;
  format?: string;
  size: number;
  used?: number;
  vmid?: number;
  ctime?: number;
  notes?: string;
  encrypted?: string;
  parent?: string;
}

/**
 * `GET /nodes/{node}/qemu/{vmid}/config`. Deliberately loose: PVE adds new
 * keys frequently (per-disk `scsiN`/`ideN`/`sataN`, `netN`, `hostpciN`, ...),
 * so this covers the common, stable keys and falls back to `unknown` for
 * everything else rather than rejecting valid configs.
 */
export interface QemuConfig {
  name?: string;
  cores?: number;
  sockets?: number;
  cpu?: string;
  memory?: number | string;
  balloon?: number;
  ostype?: string;
  boot?: string;
  onboot?: 0 | 1;
  agent?: string | 0 | 1;
  scsihw?: string;
  bios?: string;
  machine?: string;
  vmgenid?: string;
  digest?: string;
  description?: string;
  tags?: string;
  protection?: 0 | 1;
  template?: 0 | 1;
  [key: string]: unknown;
}
