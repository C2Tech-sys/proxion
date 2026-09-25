import { QueryClient } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  ALERTS_QUERY_KEY,
  CLOSE_GRACE_MS,
  CLUSTER_RESOURCES_QUERY_KEY,
  NODE_TASKS_QUERY_KEY_PREFIX,
  TASKS_QUERY_KEY,
  __resetLiveEventsForTests,
  fetchLiveState,
  subscribeLiveEvents,
} from './liveState';

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

// The shared connection is a module-level singleton (that's the point of this refactor): reset it
// after every test so one test's leftover connection/grace-period timer never leaks into the next.
afterEach(() => {
  __resetLiveEventsForTests();
});

describe('fetchLiveState', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('resolves the bare { resources, tasks } snapshot on 200 (no PVE envelope)', async () => {
    const snapshot = { resources: [{ id: 'node/c2dc2' }], tasks: [{ upid: 'x' }] };
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(jsonResponse(200, snapshot)));
    await expect(fetchLiveState()).resolves.toEqual(snapshot);
  });

  it('resolves null on 503 (no service token configured) rather than throwing', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(new Response(null, { status: 503 })));
    await expect(fetchLiveState()).resolves.toBeNull();
  });

  it('throws for any other non-2xx status', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValueOnce(new Response(null, { status: 500, statusText: 'Internal Error' })),
    );
    await expect(fetchLiveState()).rejects.toThrow(/500/);
  });
});

/** Minimal fake EventSource: exposes ways for a test to fire named events by hand. */
class FakeEventSource {
  static instances: FakeEventSource[] = [];
  url: string;
  closed = false;
  listeners = new Map<string, Set<(ev: MessageEvent<string>) => void>>();

  constructor(url: string) {
    this.url = url;
    FakeEventSource.instances.push(this);
  }

  addEventListener(type: string, cb: (ev: MessageEvent<string>) => void) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type)!.add(cb);
  }

  removeEventListener(type: string, cb: (ev: MessageEvent<string>) => void) {
    this.listeners.get(type)?.delete(cb);
  }

  close() {
    this.closed = true;
  }

  emit(type: string, data: unknown) {
    const event = { data: JSON.stringify(data) } as MessageEvent<string>;
    for (const cb of this.listeners.get(type) ?? []) cb(event);
  }

  /** A native `error` event carries no payload; used to simulate a drop/reconnect cycle. */
  emitError() {
    for (const cb of this.listeners.get('error') ?? []) cb({} as MessageEvent<string>);
  }
}

describe('subscribeLiveEvents', () => {
  let queryClient: QueryClient;

  beforeEach(() => {
    queryClient = new QueryClient();
    FakeEventSource.instances.length = 0;
    vi.stubGlobal('EventSource', FakeEventSource);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('opens exactly one EventSource against /api/events', () => {
    const unsubscribe = subscribeLiveEvents(queryClient);
    expect(FakeEventSource.instances).toHaveLength(1);
    expect(FakeEventSource.instances[0]!.url).toBe('/api/events');
    unsubscribe();
  });

  it('a "snapshot" event writes all three query keys', () => {
    const unsubscribe = subscribeLiveEvents(queryClient);
    const source = FakeEventSource.instances[0]!;
    const snapshot = {
      resources: [{ id: 'a' }],
      tasks: [{ upid: 'b' }],
      alerts: [{ id: 'backup:pve1:100:UPID:1', kind: 'backup', severity: 'warning', title: 't', at: 1 }],
    };
    source.emit('snapshot', snapshot);
    expect(queryClient.getQueryData(CLUSTER_RESOURCES_QUERY_KEY)).toEqual(snapshot.resources);
    expect(queryClient.getQueryData(TASKS_QUERY_KEY)).toEqual(snapshot.tasks);
    expect(queryClient.getQueryData(ALERTS_QUERY_KEY)).toEqual(snapshot.alerts);
    unsubscribe();
  });

  it('an "alerts" event updates only the alerts key', () => {
    const unsubscribe = subscribeLiveEvents(queryClient);
    const source = FakeEventSource.instances[0]!;
    queryClient.setQueryData(TASKS_QUERY_KEY, ['sentinel']);
    const alerts = [{ id: 'x', kind: 'storage', severity: 'warning', title: 't', at: 1 }];
    source.emit('alerts', alerts);
    expect(queryClient.getQueryData(ALERTS_QUERY_KEY)).toEqual(alerts);
    expect(queryClient.getQueryData(TASKS_QUERY_KEY)).toEqual(['sentinel']);
    unsubscribe();
  });

  it('a "resources" event updates only the cluster-resources key', () => {
    const unsubscribe = subscribeLiveEvents(queryClient);
    const source = FakeEventSource.instances[0]!;
    queryClient.setQueryData(TASKS_QUERY_KEY, ['sentinel']);
    source.emit('resources', [{ id: 'new' }]);
    expect(queryClient.getQueryData(CLUSTER_RESOURCES_QUERY_KEY)).toEqual([{ id: 'new' }]);
    expect(queryClient.getQueryData(TASKS_QUERY_KEY)).toEqual(['sentinel']);
    unsubscribe();
  });

  it('a "tasks" event updates only the tasks key', () => {
    const unsubscribe = subscribeLiveEvents(queryClient);
    const source = FakeEventSource.instances[0]!;
    queryClient.setQueryData(CLUSTER_RESOURCES_QUERY_KEY, ['sentinel']);
    source.emit('tasks', [{ upid: 'new' }]);
    expect(queryClient.getQueryData(TASKS_QUERY_KEY)).toEqual([{ upid: 'new' }]);
    expect(queryClient.getQueryData(CLUSTER_RESOURCES_QUERY_KEY)).toEqual(['sentinel']);
    unsubscribe();
  });

  it('unsubscribe closes the connection after the grace period', async () => {
    const unsubscribe = subscribeLiveEvents(queryClient);
    const source = FakeEventSource.instances[0]!;
    unsubscribe();
    // Zero subscribers doesn't close synchronously any more -- see CLOSE_GRACE_MS -- so wait it out.
    await new Promise((resolve) => setTimeout(resolve, CLOSE_GRACE_MS + 10));
    expect(source.closed).toBe(true);
  });
});

describe('subscribeLiveEvents shares one EventSource across subscribers (singleton + grace period)', () => {
  let queryClient: QueryClient;

  beforeEach(() => {
    queryClient = new QueryClient();
    FakeEventSource.instances.length = 0;
    vi.stubGlobal('EventSource', FakeEventSource);
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('two subscribers share a single EventSource', () => {
    const unsubscribe1 = subscribeLiveEvents(queryClient);
    const unsubscribe2 = subscribeLiveEvents(queryClient);
    expect(FakeEventSource.instances).toHaveLength(1);
    unsubscribe1();
    unsubscribe2();
  });

  it('unsubscribing one of two leaves the connection open', () => {
    const unsubscribe1 = subscribeLiveEvents(queryClient);
    const unsubscribe2 = subscribeLiveEvents(queryClient);
    const source = FakeEventSource.instances[0]!;

    unsubscribe1();
    expect(source.closed).toBe(false);

    unsubscribe2();
    vi.advanceTimersByTime(CLOSE_GRACE_MS);
  });

  it('unsubscribing both closes the connection only after the grace period', () => {
    const unsubscribe1 = subscribeLiveEvents(queryClient);
    const unsubscribe2 = subscribeLiveEvents(queryClient);
    const source = FakeEventSource.instances[0]!;

    unsubscribe1();
    unsubscribe2();
    expect(source.closed).toBe(false);

    vi.advanceTimersByTime(CLOSE_GRACE_MS - 1);
    expect(source.closed).toBe(false);

    vi.advanceTimersByTime(1);
    expect(source.closed).toBe(true);
  });

  it('resubscribing within the grace period reuses the same instance (StrictMode subscribe/unsubscribe/subscribe)', () => {
    const unsubscribe1 = subscribeLiveEvents(queryClient);
    const source = FakeEventSource.instances[0]!;
    unsubscribe1();

    // Resubscribe before CLOSE_GRACE_MS elapses -- simulates React StrictMode's immediate
    // double-invoke of an effect (mount -> cleanup -> mount again).
    vi.advanceTimersByTime(CLOSE_GRACE_MS - 50);
    const unsubscribe2 = subscribeLiveEvents(queryClient);

    expect(FakeEventSource.instances).toHaveLength(1);
    expect(source.closed).toBe(false);

    vi.advanceTimersByTime(CLOSE_GRACE_MS);
    expect(source.closed).toBe(false); // the second subscriber is still active

    unsubscribe2();
    vi.advanceTimersByTime(CLOSE_GRACE_MS);
    expect(source.closed).toBe(true);
  });

  it('delivers events to every active subscriber', () => {
    const secondClient = new QueryClient();

    const unsubscribe1 = subscribeLiveEvents(queryClient);
    const unsubscribe2 = subscribeLiveEvents(secondClient);
    const source = FakeEventSource.instances[0]!;

    source.emit('resources', [{ id: 'shared' }]);
    expect(queryClient.getQueryData(CLUSTER_RESOURCES_QUERY_KEY)).toEqual([{ id: 'shared' }]);
    expect(secondClient.getQueryData(CLUSTER_RESOURCES_QUERY_KEY)).toEqual([{ id: 'shared' }]);

    unsubscribe1();
    unsubscribe2();
  });

  it('an error/reconnect on the shared connection still delivers events to every subscriber', () => {
    const secondClient = new QueryClient();
    const unsubscribe1 = subscribeLiveEvents(queryClient);
    const unsubscribe2 = subscribeLiveEvents(secondClient);
    const source = FakeEventSource.instances[0]!;

    // Simulate a drop; the native EventSource reconnects on the same instance without any
    // `error` handling of our own (unchanged from before this refactor).
    source.emitError();
    expect(FakeEventSource.instances).toHaveLength(1);
    expect(source.closed).toBe(false);

    source.emit('resources', [{ id: 'post-reconnect' }]);
    expect(queryClient.getQueryData(CLUSTER_RESOURCES_QUERY_KEY)).toEqual([{ id: 'post-reconnect' }]);
    expect(secondClient.getQueryData(CLUSTER_RESOURCES_QUERY_KEY)).toEqual([{ id: 'post-reconnect' }]);

    unsubscribe1();
    unsubscribe2();
  });
});

describe('subscribeLiveEvents invalidates node-tasks queries (debounced)', () => {
  let queryClient: QueryClient;

  beforeEach(() => {
    queryClient = new QueryClient();
    FakeEventSource.instances.length = 0;
    vi.stubGlobal('EventSource', FakeEventSource);
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('invalidates ["node-tasks"] queries ~2s after a "tasks" event', () => {
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');
    const unsubscribe = subscribeLiveEvents(queryClient);
    const source = FakeEventSource.instances[0]!;

    source.emit('tasks', [{ upid: 'new' }]);
    expect(invalidateSpy).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1999);
    expect(invalidateSpy).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: NODE_TASKS_QUERY_KEY_PREFIX });

    unsubscribe();
  });

  it('collapses a burst of "tasks" events into a single invalidation (debounced)', () => {
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');
    const unsubscribe = subscribeLiveEvents(queryClient);
    const source = FakeEventSource.instances[0]!;

    source.emit('tasks', [{ upid: 'a' }]);
    vi.advanceTimersByTime(1000);
    source.emit('tasks', [{ upid: 'b' }]); // resets the debounce window
    vi.advanceTimersByTime(1000);
    expect(invalidateSpy).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1000);
    expect(invalidateSpy).toHaveBeenCalledTimes(1);

    unsubscribe();
  });

  it('also invalidates after a "snapshot" event', () => {
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');
    const unsubscribe = subscribeLiveEvents(queryClient);
    const source = FakeEventSource.instances[0]!;

    source.emit('snapshot', { resources: [], tasks: [] });
    vi.advanceTimersByTime(2000);
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: NODE_TASKS_QUERY_KEY_PREFIX });

    unsubscribe();
  });

  it('does not invalidate after a "resources" event (no task-list change)', () => {
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');
    const unsubscribe = subscribeLiveEvents(queryClient);
    const source = FakeEventSource.instances[0]!;

    source.emit('resources', [{ id: 'a' }]);
    vi.advanceTimersByTime(5000);
    expect(invalidateSpy).not.toHaveBeenCalled();

    unsubscribe();
  });

  it('unsubscribing before the debounce fires cancels the pending invalidation', () => {
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');
    const unsubscribe = subscribeLiveEvents(queryClient);
    const source = FakeEventSource.instances[0]!;

    source.emit('tasks', [{ upid: 'a' }]);
    unsubscribe();
    vi.advanceTimersByTime(5000);
    expect(invalidateSpy).not.toHaveBeenCalled();
  });
});
