import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider, createMemoryHistory, createRouter } from '@tanstack/react-router';

import { routeTree } from '@/routeTree.gen';
import type { AuthIdentity } from '@/api/client-types';

/**
 * T36 regression: `useAuthGate` (`routes/_shell.tsx`) must keep the shell mounted whenever it
 * already has an identity, even while a background refetch (window focus / reconnect, past
 * `useAuthMe`'s 30s `staleTime`) is in flight -- only a *settled*, definitive `null` should ever
 * unmount it (and redirect to /login). This reproduces the production incident: a background
 * `/api/auth/me` refetch flipped `isFetching` true, the old gate (`settled && auth !== null`)
 * unmounted the entire shell for the round trip, and an in-progress upload dialog silently
 * vanished mid-upload.
 *
 * `useAuthMe` is mocked directly (same convention as `storage-actions.render.test.tsx`/
 * `node-actions.render.test.tsx`) so each of the three states below can be driven independently
 * of the real query lifecycle; the real router + routeTree renders the actual `_shell` gate.
 */
const mockUseAuthMe = vi.fn();

vi.mock('@/api/hooks', async () => {
  const actual = await vi.importActual<typeof import('@/api/hooks')>('@/api/hooks');
  return { ...actual, useAuthMe: () => mockUseAuthMe() };
});

function identity(): AuthIdentity {
  return { username: 'root@pam', realm: 'pam', capabilities: {}, mode: 'session' };
}

function renderApp(initialEntry: string) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const router = createRouter({
    routeTree,
    history: createMemoryHistory({ initialEntries: [initialEntry] }),
  });
  render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  return { router };
}

describe('_shell auth gate during background auth refetches (T36)', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('(a) renders the Outlet content while a background refetch is in flight (data present, isFetching true)', async () => {
    mockUseAuthMe.mockReturnValue({ data: identity(), isLoading: false, isFetching: true });
    const { router } = renderApp('/');

    // Same top-bar/dashboard content `shell.render.test.tsx` asserts for a normal authenticated
    // render -- proves the shell (and the Outlet's page content) is mounted, not unmounted, while
    // `isFetching` is true.
    expect(await screen.findByText('PROXION')).toBeInTheDocument();
    expect(await screen.findByText('Nodes')).toBeInTheDocument();
    expect(router.state.location.pathname).toBe('/');
  });

  it('(b) renders nothing and navigates to /login on a settled null (existing behaviour)', async () => {
    mockUseAuthMe.mockReturnValue({ data: null, isLoading: false, isFetching: false });
    const { router } = renderApp('/');

    await waitFor(() => expect(router.state.location.pathname).toBe('/login'));
    // `Logo` (and its "PROXION" text) renders on the login page too -- assert the absence of
    // something only the shell itself renders (the inventory rail).
    expect(screen.queryByRole('tree', { name: 'Inventory' })).not.toBeInTheDocument();
  });

  it('(c) renders nothing but does NOT navigate on a stale null right after login (isFetching true)', async () => {
    mockUseAuthMe.mockReturnValue({ data: null, isLoading: false, isFetching: true });
    const { router } = renderApp('/');

    // Let any pending effects/microtasks flush -- proves the redirect effect never fires while
    // `settled` is false, not just that it hasn't fired yet.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
    });

    expect(router.state.location.pathname).toBe('/');
    expect(screen.queryByRole('tree', { name: 'Inventory' })).not.toBeInTheDocument();
  });
});
