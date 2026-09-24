import type { ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { toastError } = vi.hoisted(() => ({ toastError: vi.fn() }));
vi.mock('sonner', () => ({ toast: { error: toastError, success: vi.fn() } }));

// `patchPrefs`/`getPrefs` mocked so these tests control exactly when the "request" resolves,
// independent of the real fixture-mode 300ms delay.
vi.mock('@/api/prefs', async () => {
  const actual = await vi.importActual<typeof import('@/api/prefs')>('@/api/prefs');
  return { ...actual, patchPrefs: vi.fn(), getPrefs: vi.fn() };
});

import { getPrefs, patchPrefs, PREFS_DEFAULTS, type PrefsResponse } from '@/api/prefs';
import { PREFS_QUERY_KEY, useThemePreferenceSync, useUpdatePrefs } from '@/api/prefsHooks';
import { useUiStore } from '@/store/ui';

function wrapper(queryClient: QueryClient) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
  };
}

const SEEDED: PrefsResponse = { ...PREFS_DEFAULTS, readOnly: false };

describe('useUpdatePrefs', () => {
  beforeEach(() => {
    vi.mocked(patchPrefs).mockReset();
    vi.mocked(getPrefs).mockReset();
    toastError.mockReset();
  });

  it('applies an optimistic update to the cache before the request resolves', async () => {
    const queryClient = new QueryClient();
    queryClient.setQueryData(PREFS_QUERY_KEY, SEEDED);
    let resolvePatch!: (value: PrefsResponse) => void;
    vi.mocked(patchPrefs).mockReturnValue(
      new Promise((resolve) => {
        resolvePatch = resolve;
      }),
    );

    const { result } = renderHook(() => useUpdatePrefs(), { wrapper: wrapper(queryClient) });
    act(() => {
      result.current.mutate({ theme: 'dark' });
    });

    // Optimistic: the cache already reflects `theme: 'dark'` even though `patchPrefs` hasn't
    // resolved yet (it's parked on `resolvePatch`, called nowhere above).
    await waitFor(() => {
      expect(queryClient.getQueryData(PREFS_QUERY_KEY)).toMatchObject({ theme: 'dark' });
    });

    resolvePatch({ ...SEEDED, theme: 'dark' });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
  });

  it('a slow older write cannot overwrite a newer one (two quick saves keep both changes)', async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    queryClient.setQueryData(PREFS_QUERY_KEY, SEEDED);
    vi.mocked(getPrefs).mockResolvedValue({ ...SEEDED, theme: 'dark', density: 'compact' });
    let resolveFirst!: (value: PrefsResponse) => void;
    let resolveSecond!: (value: PrefsResponse) => void;
    vi.mocked(patchPrefs)
      .mockReturnValueOnce(
        new Promise((resolve) => {
          resolveFirst = resolve;
        }),
      )
      .mockReturnValueOnce(
        new Promise((resolve) => {
          resolveSecond = resolve;
        }),
      );

    const { result } = renderHook(() => useUpdatePrefs(), { wrapper: wrapper(queryClient) });
    act(() => {
      result.current.mutate({ theme: 'dark' });
    });
    await waitFor(() => {
      expect(queryClient.getQueryData(PREFS_QUERY_KEY)).toMatchObject({ theme: 'dark' });
    });
    act(() => {
      result.current.mutate({ density: 'compact' });
    });
    await waitFor(() => {
      expect(queryClient.getQueryData(PREFS_QUERY_KEY)).toMatchObject({ theme: 'dark', density: 'compact' });
    });

    // The second (newer) write's response lands first...
    resolveSecond({ ...SEEDED, theme: 'dark', density: 'compact' });
    // ...then the first's, which knows nothing about `density` -- it must not win.
    resolveFirst({ ...SEEDED, theme: 'dark' });
    await waitFor(() => expect(vi.mocked(patchPrefs)).toHaveBeenCalledTimes(2));
    await new Promise((r) => setTimeout(r, 20));
    expect(queryClient.getQueryData(PREFS_QUERY_KEY)).toMatchObject({ theme: 'dark', density: 'compact' });
  });

  it('rolls back the optimistic update and shows a toast when the write fails', async () => {
    const queryClient = new QueryClient();
    queryClient.setQueryData(PREFS_QUERY_KEY, SEEDED);
    vi.mocked(patchPrefs).mockRejectedValue(new Error('prefs-read-only-in-token-mode'));

    const { result } = renderHook(() => useUpdatePrefs(), { wrapper: wrapper(queryClient) });
    act(() => {
      result.current.mutate({ theme: 'dark' });
    });

    await waitFor(() => expect(result.current.isError).toBe(true));
    // Rolled back to exactly what was cached before the optimistic write.
    expect(queryClient.getQueryData(PREFS_QUERY_KEY)).toEqual(SEEDED);
    expect(toastError).toHaveBeenCalledTimes(1);
    expect(toastError.mock.calls[0]![0]).toContain('prefs-read-only-in-token-mode');
  });
});

/** A minimal `matchMedia` stub -- jsdom doesn't implement it at all, so every test that needs it
 *  installs (and removes) its own, scoped to this describe block. */
interface FakeMediaQueryList {
  matches: boolean;
  addEventListener: (type: 'change', cb: () => void) => void;
  removeEventListener: (type: 'change', cb: () => void) => void;
  fireChange: () => void;
}

function installFakeMatchMedia(initialMatches: boolean): FakeMediaQueryList {
  const listeners = new Set<() => void>();
  const mql: FakeMediaQueryList = {
    matches: initialMatches,
    addEventListener: (_type, cb) => listeners.add(cb),
    removeEventListener: (_type, cb) => listeners.delete(cb),
    fireChange: () => listeners.forEach((cb) => cb()),
  };
  vi.stubGlobal('matchMedia', vi.fn().mockReturnValue(mql));
  return mql;
}

describe('useThemePreferenceSync', () => {
  beforeEach(() => {
    vi.mocked(getPrefs).mockReset();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('resolves theme: "system" via prefers-color-scheme and applies it to the shell', async () => {
    // `useUiStore` is a module-level singleton -- pinned to the value this test moves *away*
    // from, so the `waitFor` below can only pass once this test's own effect has actually run,
    // never on leftover state from an earlier test (or this file's ui.ts module init).
    useUiStore.getState().setTheme('dark');
    installFakeMatchMedia(true); // prefers light
    vi.mocked(getPrefs).mockResolvedValue({ ...PREFS_DEFAULTS, theme: 'system', readOnly: false });
    const queryClient = new QueryClient();
    // `usePrefs()` is gated on `useAuthMe()` -- seed it directly so this test only exercises the
    // theme-sync effect, not the auth query too.
    queryClient.setQueryData(['auth-me'], { username: 'root@pam', realm: 'pam', capabilities: {}, mode: 'session' });

    renderHook(() => useThemePreferenceSync(), { wrapper: wrapper(queryClient) });

    await waitFor(() => expect(useUiStore.getState().theme).toBe('light'));
  });

  it('re-applies the theme when the OS media query changes, while still "system"', async () => {
    useUiStore.getState().setTheme('dark');
    const mql = installFakeMatchMedia(true); // starts light
    vi.mocked(getPrefs).mockResolvedValue({ ...PREFS_DEFAULTS, theme: 'system', readOnly: false });
    const queryClient = new QueryClient();
    queryClient.setQueryData(['auth-me'], { username: 'root@pam', realm: 'pam', capabilities: {}, mode: 'session' });

    renderHook(() => useThemePreferenceSync(), { wrapper: wrapper(queryClient) });
    await waitFor(() => expect(useUiStore.getState().theme).toBe('light'));

    mql.matches = false; // OS switched to dark
    act(() => mql.fireChange());
    expect(useUiStore.getState().theme).toBe('dark');
  });

  it('an explicit theme (not "system") is applied as-is, ignoring the OS setting', async () => {
    useUiStore.getState().setTheme('light');
    installFakeMatchMedia(true); // OS prefers light -- irrelevant here
    vi.mocked(getPrefs).mockResolvedValue({ ...PREFS_DEFAULTS, theme: 'dark', readOnly: false });
    const queryClient = new QueryClient();
    queryClient.setQueryData(['auth-me'], { username: 'root@pam', realm: 'pam', capabilities: {}, mode: 'session' });

    renderHook(() => useThemePreferenceSync(), { wrapper: wrapper(queryClient) });

    await waitFor(() => expect(useUiStore.getState().theme).toBe('dark'));
  });
});
