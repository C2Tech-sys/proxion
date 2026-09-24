import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';

import { usePermissions } from '@/api/actionHooks';

// `vi.mock` calls are hoisted above these imports by vitest's transform, so `usePermissions`
// sees the mocked `USE_FIXTURES` regardless of source order (same pattern as `actions.test.ts`).
vi.mock('@/api/client', async () => {
  const actual = await vi.importActual<typeof import('@/api/client')>('@/api/client');
  return { ...actual, USE_FIXTURES: false };
});

function wrapper({ children }: { children: ReactNode }) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
}

describe('usePermissions (real client, nested-shape parsing)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('parses the real PVE nested shape ({ "/vms/100": { ... } })', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(jsonResponse({ data: { '/vms/100': { 'VM.PowerMgmt': 1, 'VM.Audit': 1 } } })),
    );

    const { result } = renderHook(() => usePermissions(100), { wrapper });

    await waitFor(() => expect(result.current.data).toBeDefined());
    expect(result.current.data!.can('VM.PowerMgmt')).toBe(true);
    expect(result.current.data!.can('VM.Config.Disk')).toBe(false);

    const [url] = (fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [string];
    expect(url).toBe('/api/pve/access/permissions?path=%2Fvms%2F100');
  });

  it('falls back to a flat map if the response is not nested', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ data: { 'VM.PowerMgmt': 1 } })));

    const { result } = renderHook(() => usePermissions(100), { wrapper });

    await waitFor(() => expect(result.current.data).toBeDefined());
    expect(result.current.data!.can('VM.PowerMgmt')).toBe(true);
  });

  it('reports no privileges when the request fails', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('', { status: 500 })));

    const { result } = renderHook(() => usePermissions(100), { wrapper });

    await waitFor(() => expect(result.current.isError).toBe(true));
  });
});
