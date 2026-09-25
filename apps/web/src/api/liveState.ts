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
 * How long to keep the shared `EventSource` open with zero subscribers before actually closing
 * it. A page's several live hooks (`useClusterResources`/`useTasks`/`useAlerts`, each via
 * `useLiveMode`) subscribe/unsubscribe independently as they mount and re-render, and React
 * StrictMode double-invokes an effect (subscribe, immediately unsubscribe, subscribe again) --
 * without a grace window, that teardown-then-resubscribe cycle would close and reopen the
 * connection for no reason. Any subscribe within this window reuses the existing instance.
 */
export const CLOSE_GRACE_MS = 250;

/**
 * Test-only escape hatch: force-closes and clears the module-singleton shared connection, so each
 * test starts from a clean slate instead of reusing (or racing the grace-period close of) whatever
 * a previous test's subscribers left behind. Never called by application code.
 */
export function __resetLiveEventsForTests(): void {
  if (!shared) return;
  if (shared.closeTimer !== undefined) clearTimeout(shared.closeTimer);
  shared.source.close();
  shared = null;
}

interface LiveEventsSubscriber {
  onSnapshot: (ev: MessageEvent<string>) => void;
  onResources: (ev: MessageEvent<string>) => void;
  onTasks: (ev: MessageEvent<string>) => void;
  onAlerts: (ev: MessageEvent<string>) => void;
}

interface SharedConnection {
  source: EventSource;
  subscribers: Map<symbol, LiveEventsSubscriber>;
  closeTimer: ReturnType<typeof setTimeout> | undefined;
}

/** The one `/api/events` connection shared by every `subscribeLiveEvents` caller (module-singleton, reference-counted). */
let shared: SharedConnection | null = null;

/**
 * Opens the shared `EventSource` on the first subscriber and forwards every named event to
 * whichever subscribers are currently registered, so a page holds exactly one connection no
 * matter how many hooks/components call `subscribeLiveEvents`. Reconnect/backoff is left
 * entirely to the browser's native `EventSource` behavior (unchanged from before this refactor:
 * neither the old nor the new code adds its own `error` handling), so the same instance keeps
 * delivering to every registered subscriber across a drop and reconnect.
 */
function ensureSharedConnection(): SharedConnection {
  if (shared) {
    if (shared.closeTimer !== undefined) {
      clearTimeout(shared.closeTimer);
      shared.closeTimer = undefined;
    }
    return shared;
  }

  const source = new EventSource('/api/events');
  const subscribers = new Map<symbol, LiveEventsSubscriber>();

  source.addEventListener('snapshot', (ev) => {
    for (const s of subscribers.values()) s.onSnapshot(ev);
  });
  source.addEventListener('resources', (ev) => {
    for (const s of subscribers.values()) s.onResources(ev);
  });
  source.addEventListener('tasks', (ev) => {
    for (const s of subscribers.values()) s.onTasks(ev);
  });
  source.addEventListener('alerts', (ev) => {
    for (const s of subscribers.values()) s.onAlerts(ev);
  });

  shared = { source, subscribers, closeTimer: undefined };
  return shared;
}

/**
 * Subscribes to `GET /api/events` (SSE) and writes every event straight into the react-query
 * cache: `snapshot` (sent once on connect) updates both keys; `resources`/`tasks` update just
 * their own. Every subscriber shares one underlying `EventSource` (see `ensureSharedConnection`)
 * -- the first call opens it, later calls attach to it, and the last unsubscribe closes it after
 * `CLOSE_GRACE_MS`. Returns an unsubscribe function.
 */
export function subscribeLiveEvents(queryClient: QueryClient): () => void {
  const conn = ensureSharedConnection();
  const id = Symbol('liveEventsSubscriber');

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

  const subscriber: LiveEventsSubscriber = {
    onSnapshot: (ev) => {
      const snapshot = JSON.parse(ev.data) as LiveStateSnapshot;
      queryClient.setQueryData(CLUSTER_RESOURCES_QUERY_KEY, snapshot.resources);
      queryClient.setQueryData(TASKS_QUERY_KEY, snapshot.tasks);
      queryClient.setQueryData(ALERTS_QUERY_KEY, snapshot.alerts);
      scheduleNodeTasksInvalidate();
    },
    onResources: (ev) => {
      queryClient.setQueryData(CLUSTER_RESOURCES_QUERY_KEY, JSON.parse(ev.data) as ClusterResource[]);
    },
    onTasks: (ev) => {
      queryClient.setQueryData(TASKS_QUERY_KEY, JSON.parse(ev.data) as PveTask[]);
      scheduleNodeTasksInvalidate();
    },
    /**
     * The poller recomputes and emits `alerts` on every cluster-task poll (not just its own slow
     * vzdump-history one) so a healed backup shows up within seconds -- see the server's
     * `poller.ts`. Written straight into the cache like `resources`/`tasks` above, no debounce
     * needed (there's no downstream `['node-tasks', ...]`-style fan-out to collapse).
     */
    onAlerts: (ev) => {
      queryClient.setQueryData(ALERTS_QUERY_KEY, JSON.parse(ev.data) as Alert[]);
    },
  };

  conn.subscribers.set(id, subscriber);

  return () => {
    conn.subscribers.delete(id);
    if (invalidateTimer !== undefined) clearTimeout(invalidateTimer);
    if (conn.subscribers.size > 0) return;
    conn.closeTimer = setTimeout(() => {
      conn.closeTimer = undefined;
      // Re-check size: a resubscribe within the grace period reuses `conn` (via
      // `ensureSharedConnection`'s `shared` reuse) and would have cleared this timer already,
      // but guard anyway in case a future change schedules closing differently.
      if (shared === conn && conn.subscribers.size === 0) {
        conn.source.close();
        shared = null;
      }
    }, CLOSE_GRACE_MS);
  };
}
