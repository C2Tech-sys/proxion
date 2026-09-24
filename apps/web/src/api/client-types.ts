import type { Alert } from '@proxion/core';
import type {
  AgentInterfacesResult,
  ClusterResource,
  GuestConfig,
  GuestType,
  NodeNetworkInterface,
  NodeService,
  NodeStatusCurrent,
  PveTask,
  RrdPoint,
  RrdTimeframe,
  Snapshot,
  StorageContentItem,
  TaskLogLine,
} from '@/api/types';
import type { ThumbnailStatus, ThumbnailUrlOptions } from '@/lib/thumbnails';

export type { ThumbnailCacheEntry, ThumbnailStatus, ThumbnailUrlOptions } from '@/lib/thumbnails';

/**
 * Query params for `GET /nodes/{node}/tasks` (the node's own task index/history -- unlike
 * `/cluster/tasks`, which only ever holds a short cluster-wide recent-task window, this is the
 * right source for "when did this guest last get backed up" and for the node/VM Tasks tabs'
 * deeper history). All fields are optional passthroughs to PVE's own query params.
 */
export interface NodeTaskParams {
  vmid?: number;
  typefilter?: string;
  limit?: number;
  start?: number;
  source?: 'archive' | 'active' | 'all';
  errors?: boolean;
  since?: number;
  until?: number;
}

/** POST /api/console/vnc/:node/:type/:vmid response: a one-shot ticket for the VNC websocket. */
export interface ConsoleVncTicket {
  /** Path to open the VNC websocket at, e.g. "/api/console/vnc/ws/<token>". */
  wsPath: string;
  /** Single-use VNC auth password; passed to RFB's `credentials` and never persisted. */
  password: string;
}

/** POST /api/console/term/:node[/:type/:vmid] response: a one-shot ticket for the term websocket. */
export interface ConsoleTermTicket {
  /** Path to open the term websocket at, e.g. "/api/console/term/ws/<token>". */
  wsPath: string;
}

/** `GET /api/auth/me`'s 200 shape (our own endpoint -- no PVE envelope). */
export interface AuthIdentity {
  username: string;
  realm: string;
  capabilities: unknown;
  /** `'session'` for a real logged-in user; `'token'` for the shared service-token identity
   * (`PROXION_ALLOW_TOKEN_MODE`) with no session on top of it. */
  mode: 'session' | 'token';
}

/** Shared shape implemented by both the fixture client and the real HTTP client. */
export interface ApiClient {
  getClusterResources(): Promise<ClusterResource[]>;
  getTasks(): Promise<PveTask[]>;
  /**
   * The dashboard alerts strip's contents (backup incidents, other failed tasks, storage-full
   * warnings -- see `@proxion/core`'s `computeAlerts`). In live mode this is only the fallback
   * path (`useAlerts()` reads `GET /api/state` directly here); the primary path is the live
   * snapshot's `alerts` field, kept current via SSE.
   */
  getAlerts(): Promise<Alert[]>;
  /**
   * GET /nodes/{node}/tasks -- the node's own task index/history, optionally filtered by
   * vmid/type/status/time range. See `NodeTaskParams`.
   */
  getNodeTasks(node: string, params?: NodeTaskParams): Promise<PveTask[]>;
  getNodeStatus(node: string): Promise<NodeStatusCurrent>;
  getVmStatus(node: string, type: GuestType, vmid: number): Promise<ClusterResource>;
  getVmConfig(node: string, type: GuestType, vmid: number): Promise<GuestConfig>;
  getAgentInterfaces(
    node: string,
    type: GuestType,
    vmid: number,
  ): Promise<AgentInterfacesResult>;
  getRrd(
    node: string,
    type: GuestType,
    vmid: number,
    timeframe: RrdTimeframe,
  ): Promise<RrdPoint[]>;
  getNodeRrd(node: string, timeframe: RrdTimeframe): Promise<RrdPoint[]>;
  /** GET /nodes/{node}/network -- configured interfaces (bridges, bonds, ...). */
  getNodeNetwork(node: string): Promise<NodeNetworkInterface[]>;
  /** GET /nodes/{node}/services -- systemd unit states for the core PVE/cluster services. */
  getNodeServices(node: string): Promise<NodeService[]>;
  /** GET /nodes/{node}/storage/{storage}/content -- volumes on one storage (isos, disks, backups). */
  getStorageContent(node: string, storage: string): Promise<StorageContentItem[]>;
  /** GET /nodes/{node}/tasks/{upid}/log -- the task's captured log lines. */
  getTaskLog(node: string, upid: string): Promise<TaskLogLine[]>;
  /** GET /nodes/{node}/{qemu|lxc}/{vmid}/snapshot -- the guest's snapshot list (incl. the "current" sentinel). */
  getSnapshots(node: string, type: GuestType, vmid: number): Promise<Snapshot[]>;
  login(username: string, password: string): Promise<never>;
  /** GET /api/auth/me -- the current identity, or `null` when nothing (no session, no token mode) authenticates the caller. */
  getAuthMe(): Promise<AuthIdentity | null>;
  /** POST /api/auth/logout -- ends the current session. A no-op identity (e.g. token mode) never calls this; the UI disables Logout there instead. */
  logout(): Promise<void>;
  console: {
    /** Requests a one-shot VNC ticket (websocket path + single-use password) for a guest. */
    vnc(node: string, type: GuestType, vmid: number): Promise<ConsoleVncTicket>;
    /** Requests a one-shot term ticket (websocket path) for a node shell or a guest console. */
    term(node: string, type?: GuestType, vmid?: number): Promise<ConsoleTermTicket>;
  };
  thumbnails: {
    /**
     * Builds the console-thumbnail image URL for `<img src>`/`fetch`
     * (`GET /api/console/thumbnail/:node/:type/:vmid.png?w=&refresh=`). Synchronous -- fixture
     * mode returns a generated placeholder `data:` URI instead of a real endpoint path.
     */
    url(node: string, type: GuestType, vmid: number, opts?: ThumbnailUrlOptions): string;
    /** GET /api/console/thumbnail/status -- in-flight capture count + per-VM cache freshness. */
    status(): Promise<ThumbnailStatus>;
  };
}
