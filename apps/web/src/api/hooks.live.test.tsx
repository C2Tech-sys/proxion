import type { ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// `USE_FIXTURES` is read once at module scope in `@/api/client`; mocked here so `useLiveMode`
// takes the real (non-fixture) branch and actually exercises the /api/state + SSE wiring.
vi.mock('@/api/client', async () => {
  const actual = await vi.importActual<typeof import('@/api/client')>('@/api/client');
  // Force the real (fetch-based) client and the non-fixture branch regardless of how this test
  // run's `VITE_USE_FIXTURES` happens to be set -- these tests exercise `useLiveMode`'s actual
  // /api/state + SSE wiring, not the fixture-mode demo poll.
  return { ...actual, USE_FIXTURES: false, api: actual.httpClient };
});

import { useAlerts, useClusterResources, useTasks } from './hooks';
import { __resetLiveEventsForTests } from './liveState';

// `subscribeLiveEvents` (used by every hook here via `useLiveMode`) shares one module-singleton
// `EventSource` across subscribers (reference-counted, with a grace period before actually
// closing -- see liveState.ts). Without resetting it between tests, a hook unmounted at one
// test's cleanup can leave that shared connection alive long enough for the *next* test's hook to
// reuse it instead of opening a fresh (fake) `EventSource`, so `FakeEventSource.instances` (reset
// per test below) would stay empty even though a real subscriber attached successfully.
afterEach(() => {
  __resetLiveEventsForTests();
});

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
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function wrapper(queryClient: QueryClient) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
  };
}

describe('useClusterResources / useTasks -- prefer-the-poller wiring', () => {
  let queryClient: QueryClient;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    queryClient = new QueryClient();
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    FakeEventSource.instances.length = 0;
    vi.stubGlobal('EventSource', FakeEventSource);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('uses /api/state + SSE and never polls the proxy when the poller is available', async () => {
    const snapshot = {
      resources: [{ id: 'node/c2dc2', type: 'node', node: 'c2dc2', status: 'online' }],
      tasks: [{ upid: 'UPID:c2dc2:1:1:1:qmstart:100:user@pam:', node: 'c2dc2', type: 'qmstart', status: 'OK', starttime: 1 }],
    };
    fetchMock.mockImplementation((input: RequestInfo | URL) => {
      const url = String(input);
      if (url === '/api/state') return Promise.resolve(jsonResponse(200, snapshot));
      throw new Error(`unexpected fetch to ${url}`);
    });

    const { result } = renderHook(() => useClusterResources(), { wrapper: wrapper(queryClient) });

    await waitFor(() => expect(result.current.data).toEqual(snapshot.resources));

    // Only /api/state was ever called -- never the proxy (/api/pve/cluster/resources).
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith('/api/state');
    expect(FakeEventSource.instances).toHaveLength(1);
    expect(FakeEventSource.instances[0]!.url).toBe('/api/events');

    // A live "resources" SSE event updates the hook's data without any further fetch.
    act(() => {
      FakeEventSource.instances[0]!.emit('resources', [
        { id: 'node/c2dc2', type: 'node', node: 'c2dc2', status: 'online', name: 'updated' },
      ]);
    });
    await waitFor(() =>
      expect(result.current.data).toEqual([
        { id: 'node/c2dc2', type: 'node', node: 'c2dc2', status: 'online', name: 'updated' },
      ]),
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('falls back to polling the proxy every 5s when /api/state 503s (no service token)', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const proxyResources = [{ id: 'node/c2dc2', type: 'node', node: 'c2dc2', status: 'online' }];
    fetchMock.mockImplementation((input: RequestInfo | URL) => {
      const url = String(input);
      if (url === '/api/state') return Promise.resolve(new Response(null, { status: 503 }));
      if (url === '/api/pve/cluster/resources') {
        return Promise.resolve(jsonResponse(200, { data: proxyResources }));
      }
      throw new Error(`unexpected fetch to ${url}`);
    });

    const { result } = renderHook(() => useClusterResources(), { wrapper: wrapper(queryClient) });

    await vi.waitFor(() => expect(result.current.data).toEqual(proxyResources));
    expect(FakeEventSource.instances).toHaveLength(0);

    const callsAfterFirstFetch = fetchMock.mock.calls.length;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });
    expect(fetchMock.mock.calls.length).toBeGreaterThan(callsAfterFirstFetch);
    expect(fetchMock.mock.calls.some(([u]) => String(u) === '/api/pve/cluster/resources')).toBe(true);

    vi.useRealTimers();
  });

  it('useTasks also prefers /api/state + SSE (the "tasks" event)', async () => {
    const snapshot = { resources: [], tasks: [{ upid: 'UPID:c2dc2:1:1:1:qmstart:100:user@pam:', node: 'c2dc2', type: 'qmstart', status: 'OK', starttime: 1 }] };
    fetchMock.mockImplementation((input: RequestInfo | URL) => {
      const url = String(input);
      if (url === '/api/state') return Promise.resolve(jsonResponse(200, snapshot));
      throw new Error(`unexpected fetch to ${url}`);
    });

    const { result } = renderHook(() => useTasks(), { wrapper: wrapper(queryClient) });
    await waitFor(() => expect(result.current.data).toEqual(snapshot.tasks));

    act(() => {
      FakeEventSource.instances[0]!.emit('tasks', [{ upid: 'new', node: 'c2dc2', type: 'qmstart', status: 'OK', starttime: 2 }]);
    });
    await waitFor(() =>
      expect(result.current.data).toEqual([{ upid: 'new', node: 'c2dc2', type: 'qmstart', status: 'OK', starttime: 2 }]),
    );
  });
});

describe('useAlerts -- prefer-the-poller wiring', () => {
  let queryClient: QueryClient;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    queryClient = new QueryClient();
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    FakeEventSource.instances.length = 0;
    vi.stubGlobal('EventSource', FakeEventSource);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('uses /api/state + SSE (the "alerts" event) and never polls a proxy', async () => {
    const softAlert = { id: 'backup:pve1:100:UPID:1', kind: 'backup', severity: 'warning', title: 'soft', at: 1 };
    const snapshot = { resources: [], tasks: [], alerts: [softAlert] };
    fetchMock.mockImplementation((input: RequestInfo | URL) => {
      const url = String(input);
      if (url === '/api/state') return Promise.resolve(jsonResponse(200, snapshot));
      throw new Error(`unexpected fetch to ${url}`);
    });

    const { result } = renderHook(() => useAlerts(), { wrapper: wrapper(queryClient) });
    await waitFor(() => expect(result.current.data).toEqual([softAlert]));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith('/api/state');

    const healedAlert = { ...softAlert, severity: 'healed', title: 'healed' };
    act(() => {
      FakeEventSource.instances[0]!.emit('alerts', [healedAlert]);
    });
    await waitFor(() => expect(result.current.data).toEqual([healedAlert]));
    // Still only the one initial /api/state call -- the heal arrived over SSE, not a refetch.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('falls back to polling GET /api/state directly every 5s when the poller is unavailable', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const alert = { id: 'x', kind: 'storage', severity: 'warning', title: 'full', at: 1 };
    fetchMock.mockImplementation((input: RequestInfo | URL) => {
      const url = String(input);
      if (url === '/api/state') return Promise.resolve(new Response(null, { status: 503 }));
      throw new Error(`unexpected fetch to ${url}`);
    });

    const { result } = renderHook(() => useAlerts(), { wrapper: wrapper(queryClient) });
    await vi.waitFor(() => expect(result.current.data).toEqual([]));
    expect(FakeEventSource.instances).toHaveLength(0);

    // Once in fallback mode, a real backend serving alerts would answer /api/state with 200.
    fetchMock.mockImplementation((input: RequestInfo | URL) => {
      const url = String(input);
      if (url === '/api/state') {
        return Promise.resolve(jsonResponse(200, { resources: [], tasks: [], alerts: [alert] }));
      }
      throw new Error(`unexpected fetch to ${url}`);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });
    await vi.waitFor(() => expect(result.current.data).toEqual([alert]));

    vi.useRealTimers();
  });
});
