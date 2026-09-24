import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api, USE_FIXTURES } from '@/api/client';
import {
  ALERTS_QUERY_KEY,
  CLUSTER_RESOURCES_QUERY_KEY,
  TASKS_QUERY_KEY,
  fetchLiveState,
  subscribeLiveEvents,
} from '@/api/liveState';
import type { NodeTaskParams } from '@/api/client-types';
import type { GuestType, RrdTimeframe } from '@/api/types';
import type { NodeRrdTimeframe } from '@/lib/rrd';

/** In fixture mode we simulate a live poll so gauges/sparklines visibly move. */
const FIXTURE_REFETCH_MS = 2000;

export const AUTH_ME_QUERY_KEY = ['auth-me'] as const;

/**
 * The current identity: `data === null` is a definitive "not authenticated" answer (a 401), not
 * a transient failure, so it's never retried (matching `shouldRetryQuery`'s `NotFoundError`
 * treatment) -- the auth gate (`routes/_shell.tsx`) can act on `data === null` as soon as the
 * first fetch settles instead of waiting through a retry backoff.
 */
export function useAuthMe() {
  return useQuery({
    queryKey: AUTH_ME_QUERY_KEY,
    queryFn: () => api.getAuthMe(),
    retry: false,
    staleTime: 30_000,
  });
}

/** Per-user proxy poll interval, used only once `/api/state` has confirmed the shared poller is unavailable (no service token configured). */
const FALLBACK_POLL_MS = 5000;

type LiveMode = 'checking' | 'live' | 'fallback';

/**
 * Shared "prefer the poller" wiring for `useClusterResources`/`useTasks`: on mount, checks
 * `/api/state` once. When it's available, this hook's own react-query cache entry is populated
 * from it and kept live via `/api/events` (SSE) -- no polling of `/api/pve/*` at all. When
 * `/api/state` 503s (no service token configured), falls back to polling the read-only proxy
 * per-user every `FALLBACK_POLL_MS`, exactly as before this feature existed.
 *
 * In fixture mode this never runs (there is no server to check) -- callers fall straight
 * through to the fixture-mode poll they always used.
 */
function useLiveMode(): LiveMode {
  const queryClient = useQueryClient();
  const [mode, setMode] = useState<LiveMode>(USE_FIXTURES ? 'fallback' : 'checking');

  useEffect(() => {
    if (USE_FIXTURES) return;
    let cancelled = false;
    fetchLiveState()
      .then((state) => {
        if (cancelled) return;
        if (state) {
          queryClient.setQueryData(CLUSTER_RESOURCES_QUERY_KEY, state.resources);
          queryClient.setQueryData(TASKS_QUERY_KEY, state.tasks);
          queryClient.setQueryData(ALERTS_QUERY_KEY, state.alerts);
          setMode('live');
        } else {
          setMode('fallback');
        }
      })
      .catch(() => {
        // `/api/state` erroring (not the documented 503) is treated the same as "unavailable":
        // fall back to the per-user proxy poll rather than leaving the page stuck loading.
        if (!cancelled) setMode('fallback');
      });
    return () => {
      cancelled = true;
    };
  }, [queryClient]);

  useEffect(() => {
    if (mode !== 'live') return;
    return subscribeLiveEvents(queryClient);
  }, [mode, queryClient]);

  return mode;
}

export function useClusterResources() {
  const mode = useLiveMode();
  return useQuery({
    queryKey: CLUSTER_RESOURCES_QUERY_KEY,
    queryFn: () => api.getClusterResources(),
    // While `mode` is 'checking', wait for that check rather than also hitting the proxy --
    // 'live' relies entirely on `/api/events` pushing cache updates (see `useLiveMode`).
    enabled: mode === 'fallback',
    refetchInterval: mode === 'fallback' ? (USE_FIXTURES ? FIXTURE_REFETCH_MS : FALLBACK_POLL_MS) : false,
  });
}

export function useTasks() {
  const mode = useLiveMode();
  return useQuery({
    queryKey: TASKS_QUERY_KEY,
    queryFn: () => api.getTasks(),
    enabled: mode === 'fallback',
    refetchInterval: mode === 'fallback' ? (USE_FIXTURES ? FIXTURE_REFETCH_MS : FALLBACK_POLL_MS) : false,
  });
}

/**
 * The dashboard alerts strip's contents (backup incidents, other failed tasks, storage-full
 * warnings). In 'live' mode this reads the poller's own snapshot, kept current in the cache by
 * `subscribeLiveEvents`'s `snapshot`/`alerts` SSE handlers -- no query of its own runs. In
 * 'fallback' mode (no live poller: fixture mode, or a real server with no service token
 * configured) it polls `api.getAlerts()` directly, same cadence as `useClusterResources`/
 * `useTasks()`.
 */
export function useAlerts() {
  const mode = useLiveMode();
  return useQuery({
    queryKey: ALERTS_QUERY_KEY,
    queryFn: () => api.getAlerts(),
    enabled: mode === 'fallback',
    refetchInterval: mode === 'fallback' ? (USE_FIXTURES ? FIXTURE_REFETCH_MS : FALLBACK_POLL_MS) : false,
  });
}

/**
 * The node's own task index/history (GET /nodes/{node}/tasks), optionally scoped to one guest
 * and/or task type -- unlike `useTasks()` (the cluster's short recent-task list), this is real
 * per-guest history (e.g. "when did this VM last get backed up"). Polls like every other
 * frequently-changing query here; `liveState.ts` also invalidates `['node-tasks']` queries
 * (debounced) whenever the live SSE feed's task list changes, so a task that just finished shows
 * up here without waiting out the full interval.
 */
export function useNodeTasks(node: string, params?: NodeTaskParams) {
  return useQuery({
    queryKey: ['node-tasks', node, params],
    queryFn: () => api.getNodeTasks(node, params),
    refetchInterval: USE_FIXTURES ? FIXTURE_REFETCH_MS : 15000,
    enabled: Boolean(node),
  });
}

export function useNodeStatus(node: string) {
  return useQuery({
    queryKey: ['node-status', node],
    queryFn: () => api.getNodeStatus(node),
    refetchInterval: USE_FIXTURES ? FIXTURE_REFETCH_MS : 5000,
    enabled: Boolean(node),
  });
}

export function useVmStatus(node: string, type: GuestType, vmid: number) {
  return useQuery({
    queryKey: ['vm-status', node, type, vmid],
    queryFn: () => api.getVmStatus(node, type, vmid),
    refetchInterval: USE_FIXTURES ? FIXTURE_REFETCH_MS : 5000,
    enabled: Boolean(node && type && vmid),
  });
}

export function useVmConfig(node: string, type: GuestType, vmid: number) {
  return useQuery({
    queryKey: ['vm-config', node, type, vmid],
    queryFn: () => api.getVmConfig(node, type, vmid),
    enabled: Boolean(node && type && vmid),
  });
}

export function useAgentInterfaces(node: string, type: GuestType, vmid: number) {
  return useQuery({
    queryKey: ['agent-interfaces', node, type, vmid],
    queryFn: () => api.getAgentInterfaces(node, type, vmid),
    enabled: Boolean(node && type && vmid),
    retry: false,
  });
}

export function useRrd(
  node: string,
  type: GuestType,
  vmid: number,
  timeframe: RrdTimeframe,
) {
  return useQuery({
    queryKey: ['rrd', node, type, vmid, timeframe],
    queryFn: () => api.getRrd(node, type, vmid, timeframe),
    refetchInterval: USE_FIXTURES ? FIXTURE_REFETCH_MS : 15000,
    enabled: Boolean(node && type && vmid),
  });
}

/**
 * Nodes additionally offer a `decade` timeframe (PVE 9). `RrdTimeframe` (the shape our server's
 * `/rrddata` passthrough is typed against) predates that, so it's widened here at the query
 * boundary and narrowed back with a cast when calling through to `api.getNodeRrd` -- the fixture
 * and real server both accept the literal string at runtime.
 */
export function useNodeRrd(node: string, timeframe: NodeRrdTimeframe) {
  return useQuery({
    queryKey: ['node-rrd', node, timeframe],
    queryFn: () => api.getNodeRrd(node, timeframe as RrdTimeframe),
    refetchInterval: USE_FIXTURES ? FIXTURE_REFETCH_MS : 15000,
    enabled: Boolean(node),
  });
}

/** Configured network interfaces for a node (bridges, bonds, physical NICs). Static; no poll. */
export function useNodeNetwork(node: string) {
  return useQuery({
    queryKey: ['node-network', node],
    queryFn: () => api.getNodeNetwork(node),
    enabled: Boolean(node),
  });
}

/** Systemd unit states for the node's core PVE/cluster services. */
export function useNodeServices(node: string) {
  return useQuery({
    queryKey: ['node-services', node],
    queryFn: () => api.getNodeServices(node),
    refetchInterval: USE_FIXTURES ? FIXTURE_REFETCH_MS : 10000,
    enabled: Boolean(node),
  });
}

/** Volumes on one storage (isos, templates, disk images, backups). */
export function useStorageContent(node: string, storage: string) {
  return useQuery({
    queryKey: ['storage-content', node, storage],
    queryFn: () => api.getStorageContent(node, storage),
    enabled: Boolean(node && storage),
  });
}

/** The captured log lines for one task. Logs are immutable once the task ends; no poll. */
export function useTaskLog(node: string, upid: string) {
  return useQuery({
    queryKey: ['task-log', node, upid],
    queryFn: () => api.getTaskLog(node, upid),
    enabled: Boolean(node && upid),
  });
}

/** A guest's snapshot list (includes the "current" live-state sentinel). */
export function useSnapshots(node: string, type: GuestType, vmid: number) {
  return useQuery({
    queryKey: ['snapshots', node, type, vmid],
    queryFn: () => api.getSnapshots(node, type, vmid),
    enabled: Boolean(node && type && vmid),
  });
}
