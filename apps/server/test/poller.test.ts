import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PveClient } from '@proxion/pve-api';
import type { FastifyBaseLogger } from 'fastify';
import { Poller } from '../src/poller/poller.js';

function fakeLogger(): FastifyBaseLogger {
  return { warn: vi.fn(), info: vi.fn(), error: vi.fn() } as unknown as FastifyBaseLogger;
}

function fakeClient(impl: {
  get: (path: string) => Promise<unknown>;
  raw: (method: string, path: string) => Promise<unknown>;
}): PveClient {
  return impl as unknown as PveClient;
}

describe('Poller', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('polls immediately on start and emits a change event for the first (non-empty) snapshot', async () => {
    const resources = [{ id: 'node/pve' }];
    const client = fakeClient({
      get: async () => resources,
      raw: async () => [],
    });
    const poller = new Poller(client, fakeLogger(), {
      resourcesIntervalMs: 2000,
      tasksIntervalMs: 3000,
    });
    const events: string[] = [];
    poller.on((e) => events.push(e.type));

    poller.start();
    await vi.runOnlyPendingTimersAsync();

    expect(poller.getSnapshot().resources).toEqual(resources);
    expect(events).toContain('resources');
    poller.stop();
  });

  it('does not emit again when the polled data has not changed', async () => {
    const client = fakeClient({
      get: async () => [{ id: 'node/pve' }],
      raw: async () => [],
    });
    const poller = new Poller(client, fakeLogger(), {
      resourcesIntervalMs: 100,
      tasksIntervalMs: 100,
    });
    const events: string[] = [];
    poller.on((e) => events.push(e.type));

    poller.start();
    await vi.advanceTimersByTimeAsync(100); // first poll (from delay 0)
    const countAfterFirst = events.filter((e) => e === 'resources').length;

    await vi.advanceTimersByTimeAsync(300); // several more resource polls, same data
    expect(events.filter((e) => e === 'resources').length).toBe(countAfterFirst);
    poller.stop();
  });

  it('emits again only when the polled data actually changes', async () => {
    let call = 0;
    const client = fakeClient({
      get: async () => {
        call += 1;
        return call === 1 ? [{ id: 'a' }] : [{ id: 'a' }, { id: 'b' }];
      },
      raw: async () => [],
    });
    const poller = new Poller(client, fakeLogger(), {
      resourcesIntervalMs: 100,
      tasksIntervalMs: 100,
    });
    const snapshots: unknown[] = [];
    poller.on((e) => {
      if (e.type === 'resources') snapshots.push(e.data);
    });

    poller.start();
    await vi.advanceTimersByTimeAsync(100);
    await vi.advanceTimersByTimeAsync(100);

    expect(snapshots).toHaveLength(2);
    expect(snapshots[0]).toEqual([{ id: 'a' }]);
    expect(snapshots[1]).toEqual([{ id: 'a' }, { id: 'b' }]);
    poller.stop();
  });

  it('keeps polling on the configured interval after a failure, and logs a warning', async () => {
    let call = 0;
    const client = fakeClient({
      get: async () => {
        call += 1;
        if (call === 1) throw new Error('network error');
        return [{ id: 'ok' }];
      },
      raw: async () => [],
    });
    const log = fakeLogger();
    const poller = new Poller(client, log, { resourcesIntervalMs: 100, tasksIntervalMs: 100 });

    poller.start();
    await vi.advanceTimersByTimeAsync(100);
    expect(log.warn).toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(100);
    expect(poller.getSnapshot().resources).toEqual([{ id: 'ok' }]);
    poller.stop();
  });

  it('recomputes alerts as "healed" once an OK vzdump for a previously-failed guest lands in the cluster task poll', async () => {
    const nodeResource = { id: 'node/pve1', type: 'node', node: 'pve1' };
    const failedTask = {
      upid: 'UPID:pve1:00000001:00000000:00000000:vzdump:113:msp360@pve:',
      node: 'pve1',
      type: 'vzdump',
      id: '113',
      user: 'msp360@pve',
      starttime: Math.floor(Date.now() / 1000) - 600,
      endtime: Math.floor(Date.now() / 1000) - 590,
      status: 'ERROR: job errors',
    };
    const healedTask = {
      ...failedTask,
      upid: 'UPID:pve1:00000002:00000000:00000000:vzdump:113:msp360@pve:',
      starttime: Math.floor(Date.now() / 1000) - 300,
      endtime: Math.floor(Date.now() / 1000) - 290,
      status: 'OK',
    };

    let clusterTasks: unknown[] = [failedTask];
    const client = fakeClient({
      get: async (path: string) => (path === '/cluster/resources' ? [nodeResource] : []),
      raw: async () => clusterTasks,
    });
    const poller = new Poller(client, fakeLogger(), {
      resourcesIntervalMs: 100,
      tasksIntervalMs: 100,
      vzdumpHistoryIntervalMs: 100_000, // effectively disabled for this test
    });
    const alertsEvents: unknown[][] = [];
    poller.on((e) => {
      if (e.type === 'alerts') alertsEvents.push(e.data);
    });

    poller.start();
    await vi.advanceTimersByTimeAsync(100);
    expect(poller.getSnapshot().alerts).toMatchObject([{ kind: 'backup', severity: 'warning' }]);

    clusterTasks = [failedTask, healedTask];
    await vi.advanceTimersByTimeAsync(100);
    expect(poller.getSnapshot().alerts).toMatchObject([{ kind: 'backup', severity: 'healed' }]);
    poller.stop();
  });

  it('merges the vzdump-history poll into the alerts computation and keeps the last known history on failure', async () => {
    const nodeResource = { id: 'node/pve1', type: 'node', node: 'pve1' };
    const failedTask = {
      upid: 'UPID:pve1:00000001:00000000:00000000:vzdump:113:msp360@pve:',
      node: 'pve1',
      type: 'vzdump',
      id: '113',
      user: 'msp360@pve',
      starttime: Math.floor(Date.now() / 1000) - 600,
      endtime: Math.floor(Date.now() / 1000) - 590,
      status: 'ERROR: job errors',
    };

    let historyCalls = 0;
    let shouldFail = false;
    const client = fakeClient({
      get: async (path: string) => {
        if (path === '/cluster/resources') return [nodeResource];
        if (path === '/nodes/{node}/tasks') {
          historyCalls += 1;
          if (shouldFail) throw new Error('node unreachable');
          return [failedTask];
        }
        return [];
      },
      raw: async () => [],
    });
    const log = fakeLogger();
    const poller = new Poller(client, log, {
      resourcesIntervalMs: 100,
      tasksIntervalMs: 100_000, // effectively disabled
      vzdumpHistoryIntervalMs: 50,
    });

    poller.start();
    // Generous window: at least one resources poll (populating node names) and at least one
    // vzdump-history poll after it have both had a chance to land.
    await vi.advanceTimersByTimeAsync(250);
    expect(historyCalls).toBeGreaterThan(0);
    expect(poller.getSnapshot().alerts).toMatchObject([{ kind: 'backup', severity: 'warning' }]);

    shouldFail = true;
    const callsBeforeFailure = historyCalls;
    await vi.advanceTimersByTimeAsync(150); // at least one more history poll, now failing
    expect(historyCalls).toBeGreaterThan(callsBeforeFailure);
    expect(log.warn).toHaveBeenCalled();
    // Last known history (the one failed attempt) is kept, so the alert doesn't vanish.
    expect(poller.getSnapshot().alerts).toMatchObject([{ kind: 'backup', severity: 'warning' }]);
    poller.stop();
  });

  it('stop() prevents further polling', async () => {
    let call = 0;
    const client = fakeClient({
      get: async () => {
        call += 1;
        return [];
      },
      raw: async () => [],
    });
    const poller = new Poller(client, fakeLogger(), {
      resourcesIntervalMs: 100,
      tasksIntervalMs: 100,
    });
    poller.start();
    await vi.advanceTimersByTimeAsync(100);
    const callsBeforeStop = call;
    poller.stop();
    await vi.advanceTimersByTimeAsync(1000);
    expect(call).toBe(callsBeforeStop);
  });
});
