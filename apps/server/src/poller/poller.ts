import type { FastifyBaseLogger } from 'fastify';
import type { PveClient } from '@proxion/pve-api';
import { computeAlerts, type Alert, type ResourceLike, type TaskLike } from '@proxion/core';

export interface PollerSnapshot {
  resources: unknown[];
  tasks: unknown[];
  alerts: Alert[];
}

export type PollerEvent =
  | { type: 'resources'; data: unknown[] }
  | { type: 'tasks'; data: unknown[] }
  | { type: 'alerts'; data: Alert[] };

export interface PollerOptions {
  resourcesIntervalMs?: number;
  tasksIntervalMs?: number;
  /** How often the per-node vzdump task history (used only for the backup-incident alerts
   * rule) is refetched. Independent of the fast cluster polls above -- this is a much cheaper,
   * much less time-sensitive poll (a 24h history per node), so it runs on its own, slower
   * timer. */
  vzdumpHistoryIntervalMs?: number;
  /** How far back each node's vzdump history fetch looks. Passed straight through to
   * `computeAlerts`'s look-back too, so a failure never falls out of the alert before its own
   * history fetch would have stopped returning it. */
  vzdumpLookbackMs?: number;
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (a === null || b === null) return false;
  if (typeof a !== 'object') return false;

  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b)) return false;
    if (a.length !== b.length) return false;
    return a.every((item, index) => deepEqual(item, b[index]));
  }

  const aKeys = Object.keys(a as Record<string, unknown>);
  const bKeys = Object.keys(b as Record<string, unknown>);
  if (aKeys.length !== bKeys.length) return false;
  return aKeys.every((key) =>
    deepEqual((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key]),
  );
}

function isTaskLike(value: unknown): value is TaskLike {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { upid?: unknown }).upid === 'string'
  );
}

/**
 * Polls `GET /cluster/resources` and `GET /cluster/tasks` on independent
 * intervals using one shared `PveClient` (the service token's), keeps the
 * latest snapshot of each, and notifies subscribers only when a poll's
 * result actually changed (deep-compare) from the previous one.
 *
 * It additionally maintains, on its own slow (60s default) timer, each node's `vzdump` task
 * history (`GET /nodes/{node}/tasks?typefilter=vzdump&...`, nodes taken from the latest
 * `resources` snapshot) -- merged with the fast cluster task list by UPID -- and recomputes
 * `snapshot.alerts` (`@proxion/core`'s `computeAlerts`) from that merged history whenever either
 * feed changes, so a healed backup shows up within seconds of the healing task landing in the
 * fast `/cluster/tasks` poll, without needing the slow history poll to also have run since.
 */
export class Poller {
  private readonly resourcesIntervalMs: number;
  private readonly tasksIntervalMs: number;
  private readonly vzdumpHistoryIntervalMs: number;
  private readonly vzdumpLookbackMs: number;
  private resourcesTimer: ReturnType<typeof setTimeout> | undefined;
  private tasksTimer: ReturnType<typeof setTimeout> | undefined;
  private vzdumpHistoryTimer: ReturnType<typeof setTimeout> | undefined;
  private stopped = true;
  private readonly listeners = new Set<(event: PollerEvent) => void>();
  private snapshot: PollerSnapshot = { resources: [], tasks: [], alerts: [] };
  /** Latest known vzdump history per node -- kept across a failed refetch ("keep the last known
   * history" per the ticket), keyed by node name. */
  private readonly vzdumpHistoryByNode = new Map<string, TaskLike[]>();

  constructor(
    private readonly client: PveClient,
    private readonly log: FastifyBaseLogger,
    options: PollerOptions = {},
  ) {
    this.resourcesIntervalMs = options.resourcesIntervalMs ?? 2000;
    this.tasksIntervalMs = options.tasksIntervalMs ?? 3000;
    this.vzdumpHistoryIntervalMs = options.vzdumpHistoryIntervalMs ?? 60_000;
    this.vzdumpLookbackMs = options.vzdumpLookbackMs ?? 24 * 60 * 60 * 1000;
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.scheduleResourcesPoll(0);
    this.scheduleTasksPoll(0);
    this.scheduleVzdumpHistoryPoll(0);
  }

  stop(): void {
    this.stopped = true;
    if (this.resourcesTimer) clearTimeout(this.resourcesTimer);
    if (this.tasksTimer) clearTimeout(this.tasksTimer);
    if (this.vzdumpHistoryTimer) clearTimeout(this.vzdumpHistoryTimer);
    this.resourcesTimer = undefined;
    this.tasksTimer = undefined;
    this.vzdumpHistoryTimer = undefined;
  }

  getSnapshot(): PollerSnapshot {
    return this.snapshot;
  }

  /** Subscribe to change events. Returns an unsubscribe function. */
  on(listener: (event: PollerEvent) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private emit(event: PollerEvent): void {
    for (const listener of this.listeners) listener(event);
  }

  private scheduleResourcesPoll(delayMs: number): void {
    if (this.stopped) return;
    this.resourcesTimer = setTimeout(() => {
      void this.pollResources();
    }, delayMs);
  }

  private scheduleTasksPoll(delayMs: number): void {
    if (this.stopped) return;
    this.tasksTimer = setTimeout(() => {
      void this.pollTasks();
    }, delayMs);
  }

  private scheduleVzdumpHistoryPoll(delayMs: number): void {
    if (this.stopped) return;
    this.vzdumpHistoryTimer = setTimeout(() => {
      void this.pollVzdumpHistory();
    }, delayMs);
  }

  private async pollResources(): Promise<void> {
    try {
      const data = (await this.client.get('/cluster/resources')) as unknown[];
      if (!deepEqual(data, this.snapshot.resources)) {
        this.snapshot = { ...this.snapshot, resources: data };
        this.emit({ type: 'resources', data });
        this.recomputeAlerts();
      }
    } catch (error) {
      this.log.warn({ err: error }, 'Poller: /cluster/resources poll failed');
    } finally {
      this.scheduleResourcesPoll(this.resourcesIntervalMs);
    }
  }

  private async pollTasks(): Promise<void> {
    try {
      const data = (await this.client.raw('GET', '/cluster/tasks')) as unknown[];
      if (!deepEqual(data, this.snapshot.tasks)) {
        this.snapshot = { ...this.snapshot, tasks: data };
        this.emit({ type: 'tasks', data });
        // Recomputed on every cluster-task poll (not just the slow vzdump-history one) so a
        // heal -- an OK vzdump landing in this fast, short recent-task list -- shows up within
        // seconds rather than waiting out the next history refresh.
        this.recomputeAlerts();
      }
    } catch (error) {
      this.log.warn({ err: error }, 'Poller: /cluster/tasks poll failed');
    } finally {
      this.scheduleTasksPoll(this.tasksIntervalMs);
    }
  }

  private nodeNames(): string[] {
    const names = new Set<string>();
    for (const resource of this.snapshot.resources) {
      if (
        typeof resource === 'object' &&
        resource !== null &&
        (resource as { type?: unknown }).type === 'node' &&
        typeof (resource as { node?: unknown }).node === 'string'
      ) {
        names.add((resource as { node: string }).node);
      }
    }
    return [...names];
  }

  private async pollVzdumpHistory(): Promise<void> {
    try {
      const since = Math.floor((Date.now() - this.vzdumpLookbackMs) / 1000);
      const nodes = this.nodeNames();
      await Promise.all(
        nodes.map(async (node) => {
          try {
            const data = await this.client.get('/nodes/{node}/tasks', {
              node,
              typefilter: 'vzdump',
              since,
              limit: 500,
              source: 'all',
            });
            this.vzdumpHistoryByNode.set(node, (data as unknown as TaskLike[]) ?? []);
          } catch (error) {
            // Keep the last known history for this node -- a stale-but-present incident is
            // better than one that vanishes because a single history fetch hiccuped.
            this.log.warn(
              { err: error, node },
              'Poller: vzdump history poll failed for node, keeping last known history',
            );
          }
        }),
      );
    } finally {
      // Always recompute, even if every fetch above failed: `now` has advanced regardless,
      // which alone can flip a soft incident to hard once its heal window elapses.
      this.recomputeAlerts();
      this.scheduleVzdumpHistoryPoll(this.vzdumpHistoryIntervalMs);
    }
  }

  /** Merges the fast cluster task list with the slower per-node vzdump history (by UPID -- the
   * cluster list, being polled far more often, wins on overlap) and recomputes `snapshot.alerts`
   * from the result, emitting an `alerts` event iff it actually changed. */
  private recomputeAlerts(): void {
    const merged = new Map<string, TaskLike>();
    for (const history of this.vzdumpHistoryByNode.values()) {
      for (const task of history) merged.set(task.upid, task);
    }
    for (const task of this.snapshot.tasks) {
      if (isTaskLike(task)) merged.set(task.upid, task);
    }

    const alerts = computeAlerts({
      resources: this.snapshot.resources as unknown as ResourceLike[],
      tasks: [...merged.values()],
      now: Date.now(),
    });

    if (!deepEqual(alerts, this.snapshot.alerts)) {
      this.snapshot = { ...this.snapshot, alerts };
      this.emit({ type: 'alerts', data: alerts });
    }
  }
}
