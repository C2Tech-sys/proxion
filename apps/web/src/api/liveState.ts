import type { QueryClient } from '@tanstack/react-query';
import type { Alert } from '@proxion/core';

import type { ClusterResource, PveTask } from '@/api/types';

/** `GET /api/state`'s shape (our own endpoint -- no PVE envelope). */
export interface LiveStateSnapshot {
  resources: ClusterResource[];
  tasks: PveTask[];
  alerts: Alert[];
}

export const CLUSTER_RESOURCES_QUERY_KEY = ['cluster-resources'] as const;
export const TASKS_QUERY_KEY = ['tasks'] as const;
export const ALERTS_QUERY_KEY = ['alerts'] as const;
/** Prefix shared by every `useNodeTasks` query key (`['node-tasks', node, params]`). */
export const NODE_TASKS_QUERY_KEY_PREFIX = ['node-tasks'] as const;

/**
 * How long to wait, after the live task list last changed, before invalidating every
 * `['node-tasks', ...]` query. A burst of task events (a backup finishing plus the next one
 * starting, say) collapses into a single refetch instead of one per event.
 */
const NODE_TASKS_INVALIDATE_DEBOUNCE_MS = 2000;

/**
 * `GET /api/state` -- the shared poller's latest `{ resources, tasks }` snapshot. Resolves
 * `null` (not a throw) for the documented `503` ("no service token configured"): that's a
 * normal, expected way for this endpoint to be unavailable, not a transient failure, and the
 * caller's job is to fall back to per-user polling through the proxy, not to retry it.
 */
export async function fetchLiveState(): Promise<LiveStateSnapshot | null> {
  const res = await fetch('/api/state');
  if (res.status === 503) return null;
  if (!res.ok) {
    throw new Error(`Request to /api/state failed: ${res.status} ${res.statusText}`);
  }
  return (await res.json()) as LiveStateSnapshot;
}

/**
 * Subscribes to `GET /api/events` (SSE) and writes every event straight into the react-query
 * cache: `snapshot` (sent once on connect) updates both keys; `resources`/`tasks` update just
 * their own. Returns an unsubscribe function that closes the connection.
 */
export function subscribeLiveEvents(queryClient: QueryClient): () => void {
  const source = new EventSource('/api/events');

  let invalidateTimer: ReturnType<typeof setTimeout> | undefined;
  /**
   * A task that just finished (or a new one starting) means some guest's task history changed,
   * but every `useNodeTasks` query is keyed by its own `(node, params)` -- there's no single
   * query to just overwrite the way `onTasks` does for the cluster list above. Invalidating by
   * the shared `['node-tasks']` prefix marks all of them stale in one go; debounced so a burst of
   * task events collapses into one refetch per query instead of one per event.
   */
  function scheduleNodeTasksInvalidate() {
    if (invalidateTimer !== undefined) clearTimeout(invalidateTimer);
    invalidateTimer = setTimeout(() => {
      invalidateTimer = undefined;
      void queryClient.invalidateQueries({ queryKey: NODE_TASKS_QUERY_KEY_PREFIX });
    }, NODE_TASKS_INVALIDATE_DEBOUNCE_MS);
  }

  const onSnapshot = (ev: MessageEvent<string>) => {
    const snapshot = JSON.parse(ev.data) as LiveStateSnapshot;
    queryClient.setQueryData(CLUSTER_RESOURCES_QUERY_KEY, snapshot.resources);
    queryClient.setQueryData(TASKS_QUERY_KEY, snapshot.tasks);
    queryClient.setQueryData(ALERTS_QUERY_KEY, snapshot.alerts);
    scheduleNodeTasksInvalidate();
  };
  const onResources = (ev: MessageEvent<string>) => {
    queryClient.setQueryData(CLUSTER_RESOURCES_QUERY_KEY, JSON.parse(ev.data) as ClusterResource[]);
  };
  const onTasks = (ev: MessageEvent<string>) => {
    queryClient.setQueryData(TASKS_QUERY_KEY, JSON.parse(ev.data) as PveTask[]);
    scheduleNodeTasksInvalidate();
  };
  /**
   * The poller recomputes and emits `alerts` on every cluster-task poll (not just its own slow
   * vzdump-history one) so a healed backup shows up within seconds -- see the server's
   * `poller.ts`. Written straight into the cache like `resources`/`tasks` above, no debounce
   * needed (there's no downstream `['node-tasks', ...]`-style fan-out to collapse).
   */
  const onAlerts = (ev: MessageEvent<string>) => {
    queryClient.setQueryData(ALERTS_QUERY_KEY, JSON.parse(ev.data) as Alert[]);
  };

  source.addEventListener('snapshot', onSnapshot);
  source.addEventListener('resources', onResources);
  source.addEventListener('tasks', onTasks);
  source.addEventListener('alerts', onAlerts);

  return () => {
    source.removeEventListener('snapshot', onSnapshot);
    source.removeEventListener('resources', onResources);
    source.removeEventListener('tasks', onTasks);
    source.removeEventListener('alerts', onAlerts);
    if (invalidateTimer !== undefined) clearTimeout(invalidateTimer);
    source.close();
  };
}
