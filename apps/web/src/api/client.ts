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
  Snapshot,
  StorageContentItem,
  TaskLogLine,
} from '@/api/types';
import type {
  ApiClient,
  AuthIdentity,
  ConsoleTermTicket,
  ConsoleVncTicket,
  NodeTaskParams,
  ThumbnailStatus,
} from '@/api/client-types';
import { fixtureClient } from '@/api/fixtures';
import { fetchLiveState } from '@/api/liveState';
import { buildThumbnailPath } from '@/lib/thumbnails';

/**
 * Thin fetch wrapper for OUR server (not Proxmox directly). Real endpoints:
 *   GET  /api/state              -> { resources: ClusterResource[], tasks: PveTask[] }
 *   GET  /api/events             -> SSE stream of resource/task diffs
 *   GET  /api/pve/*              -> passthrough to the Proxmox API (node status, config, rrd, agent)
 *   POST /api/auth/login         -> session auth
 *   *    /api/console/*          -> VNC/term ticket + websocket upgrade info
 * This app talks only to our server, never to a Proxmox host directly.
 *
 * `/api/pve/*` is a byte-for-byte passthrough of PVE's own response (see
 * `apps/server/src/proxy/pveProxy.ts` / server README's "Read-only PVE proxy" section): PVE
 * always wraps its payload as `{ data: <result> }` (and, on failure, `{ data: null, errors?,
 * message? }`), which is *not* the shape our `client-types.ts`/`types.ts` model. Every other
 * route this client calls (`/api/state`, `/api/auth/*`, `/api/console/*`) is one of OUR OWN
 * endpoints and already returns its result bare -- no envelope to unwrap there.
 */
const PVE_PROXY_PREFIX = '/api/pve/';

/**
 * Builds the `GET /nodes/{node}/tasks` query string from `NodeTaskParams`: every field is
 * omitted unless explicitly set (so an absent `limit` lets the proxy/PVE apply its own default,
 * rather than us silently pinning one), and `errors` -- the only boolean param -- is sent as
 * `1`/`0` since that's the literal string PVE's own API expects, not `true`/`false`.
 */
function nodeTasksQueryString(params?: NodeTaskParams): string {
  const search = new URLSearchParams();
  if (params?.vmid !== undefined) search.set('vmid', String(params.vmid));
  if (params?.typefilter !== undefined) search.set('typefilter', params.typefilter);
  if (params?.limit !== undefined) search.set('limit', String(params.limit));
  if (params?.start !== undefined) search.set('start', String(params.start));
  if (params?.source !== undefined) search.set('source', params.source);
  if (params?.errors !== undefined) search.set('errors', params.errors ? '1' : '0');
  if (params?.since !== undefined) search.set('since', String(params.since));
  if (params?.until !== undefined) search.set('until', String(params.until));
  const qs = search.toString();
  return qs.length > 0 ? `?${qs}` : '';
}

interface PveEnvelope<T> {
  data: T;
  errors?: unknown;
  message?: string;
}

function isPveEnvelope(value: unknown): value is PveEnvelope<unknown> {
  return typeof value === 'object' && value !== null && 'data' in value;
}

/** Best-effort human-readable detail from a non-2xx PVE envelope, for the thrown error's message. */
function pveErrorDetail(body: unknown): string | undefined {
  if (!isPveEnvelope(body)) return undefined;
  if (typeof body.message === 'string' && body.message.trim().length > 0) {
    return body.message.trim();
  }
  if (body.errors && typeof body.errors === 'object') {
    const parts = Object.entries(body.errors as Record<string, unknown>).map(
      ([field, msg]) => `${field}: ${String(msg)}`,
    );
    if (parts.length > 0) return parts.join('; ');
  }
  return undefined;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  // Only declare a JSON body when there is one: Fastify rejects an empty body that claims
  // `application/json` with a 400, which broke the body-less console POSTs.
  const res = await fetch(path, {
    ...init,
    headers: {
      ...(init?.body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...init?.headers,
    },
  });

  const isPveProxyPath = path.startsWith(PVE_PROXY_PREFIX);

  if (!res.ok) {
    if (isPveProxyPath) {
      // The proxy relays PVE's status and body verbatim, so a non-2xx here may still carry a
      // JSON envelope with PVE's own error detail (`{ data: null, message/errors }`) -- surface
      // that instead of just the transport-level status line, falling back to it when the body
      // isn't JSON or carries no usable detail (e.g. our own proxy's 401/502/400 error shapes).
      let detail: string | undefined;
      try {
        detail = pveErrorDetail(await res.clone().json());
      } catch {
        detail = undefined;
      }
      throw new Error(detail ?? `Request to ${path} failed: ${res.status} ${res.statusText}`);
    }
    throw new Error(`Request to ${path} failed: ${res.status} ${res.statusText}`);
  }

  const body = (await res.json()) as unknown;
  if (isPveProxyPath) {
    // A 2xx PVE response is always the `{ data }` envelope -- unwrap it here, once, so every
    // other client method and every caller downstream can work with the bare shape it declares.
    return (isPveEnvelope(body) ? body.data : body) as T;
  }
  return body as T;
}

export const httpClient: ApiClient = {
  getClusterResources() {
    return request<ClusterResource[]>('/api/pve/cluster/resources');
  },
  getTasks() {
    return request<PveTask[]>('/api/pve/cluster/tasks');
  },
  // The fallback path for `useAlerts()` (the live/SSE path reads the poller's own snapshot
  // straight into the query cache) -- `GET /api/state` is OUR endpoint, not a PVE passthrough,
  // so this goes through `fetchLiveState()` rather than `request()`/the PVE proxy prefix.
  async getAlerts() {
    const state = await fetchLiveState();
    return state?.alerts ?? [];
  },
  getNodeTasks(node, params) {
    return request<PveTask[]>(`/api/pve/nodes/${node}/tasks${nodeTasksQueryString(params)}`);
  },
  getNodeStatus(node) {
    return request<NodeStatusCurrent>(`/api/pve/nodes/${node}/status`);
  },
  getVmStatus(node, type, vmid) {
    return request<ClusterResource>(`/api/pve/nodes/${node}/${type}/${vmid}/status/current`);
  },
  getVmConfig(node, type, vmid) {
    return request<GuestConfig>(`/api/pve/nodes/${node}/${type}/${vmid}/config`);
  },
  getAgentInterfaces(node, type, vmid) {
    return request<AgentInterfacesResult>(
      `/api/pve/nodes/${node}/${type}/${vmid}/agent/network-get-interfaces`,
    );
  },
  getRrd(node, type, vmid, timeframe) {
    return request<RrdPoint[]>(
      `/api/pve/nodes/${node}/${type}/${vmid}/rrddata?timeframe=${timeframe}`,
    );
  },
  getNodeRrd(node, timeframe) {
    return request<RrdPoint[]>(`/api/pve/nodes/${node}/rrddata?timeframe=${timeframe}`);
  },
  getNodeNetwork(node) {
    return request<NodeNetworkInterface[]>(`/api/pve/nodes/${node}/network`);
  },
  getNodeServices(node) {
    return request<NodeService[]>(`/api/pve/nodes/${node}/services`);
  },
  getStorageContent(node, storage) {
    return request<StorageContentItem[]>(`/api/pve/nodes/${node}/storage/${storage}/content`);
  },
  getTaskLog(node, upid) {
    return request<TaskLogLine[]>(`/api/pve/nodes/${node}/tasks/${upid}/log`);
  },
  getSnapshots(node, type, vmid) {
    return request<Snapshot[]>(`/api/pve/nodes/${node}/${type}/${vmid}/snapshot`);
  },
  async login(username, password) {
    return request('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ username, password }),
    });
  },
  async getAuthMe() {
    // Bypasses `request()`: a 401 here is a normal, expected "not authenticated" answer (the
    // auth gate's job to act on), not a thrown error like every other endpoint's non-2xx.
    const res = await fetch('/api/auth/me', { headers: { 'content-type': 'application/json' } });
    if (res.status === 401) return null;
    if (!res.ok) {
      throw new Error(`Request to /api/auth/me failed: ${res.status} ${res.statusText}`);
    }
    return (await res.json()) as AuthIdentity;
  },
  async logout() {
    await request('/api/auth/logout', { method: 'POST' });
  },
  console: {
    vnc(node, type, vmid) {
      return request<ConsoleVncTicket>(`/api/console/vnc/${node}/${type}/${vmid}`, {
        method: 'POST',
      });
    },
    term(node, type, vmid) {
      const path =
        type !== undefined && vmid !== undefined
          ? `/api/console/term/${node}/${type}/${vmid}`
          : `/api/console/term/${node}`;
      return request<ConsoleTermTicket>(path, { method: 'POST' });
    },
  },
  thumbnails: {
    url(node, type, vmid, opts) {
      return buildThumbnailPath(node, type, vmid, opts);
    },
    status() {
      return request<ThumbnailStatus>('/api/console/thumbnail/status');
    },
  },
};

export const USE_FIXTURES = import.meta.env.VITE_USE_FIXTURES === '1';

export const api: ApiClient = USE_FIXTURES ? fixtureClient : httpClient;
export type { GuestType };
