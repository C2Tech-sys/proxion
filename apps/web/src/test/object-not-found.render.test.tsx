import { describe, expect, it } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import { QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider, createMemoryHistory, createRouter } from '@tanstack/react-router';

import { routeTree } from '@/routeTree.gen';
import {
  createQueryClient,
  shouldRetryQuery,
  queryRetryDelay,
  MAX_QUERY_RETRIES,
} from '@/api/queryClient';
import { NotFoundError } from '@/api/errors';

/**
 * Fix-wave 2, F3: an object that doesn't exist in the fixtures must show a "not found"
 * empty state (not a permanent skeleton). Covers both the VM route and the node Summary tab.
 *
 * Fix-wave 3, F1: these tests build their client with `createQueryClient()` -- the *same*
 * factory main.tsx uses -- so they exercise the production retry policy. Building an ad-hoc
 * client with `retry: false` here previously let the real (3-retry, 7.5s-backoff) default
 * config ship unnoticed.
 */

/** Budget for a not-found state to paint, in fixture mode. */
// Generous on purpose: the retry policy is asserted deterministically above; this budget only
// guards against the original 7.5 s retry/backoff regression and must not flake under CI load.
const NOT_FOUND_BUDGET_MS = 5000;

async function expectNotFoundWithin(budgetMs: number) {
  const started = performance.now();
  expect(await screen.findByText(/was not found/i, undefined, { timeout: budgetMs })).toBeInTheDocument();
  return performance.now() - started;
}

describe('Query retry policy (fix-wave 3, F1)', () => {
  it('never retries a NotFoundError', () => {
    expect(shouldRetryQuery(0, new NotFoundError('nope'))).toBe(false);
  });

  it('retries other errors at most twice, with a short backoff', () => {
    expect(shouldRetryQuery(0, new Error('boom'))).toBe(true);
    expect(shouldRetryQuery(MAX_QUERY_RETRIES - 1, new Error('boom'))).toBe(true);
    expect(shouldRetryQuery(MAX_QUERY_RETRIES, new Error('boom'))).toBe(false);
    // Total added latency for a non-not-found failure stays well under a second.
    expect(queryRetryDelay(0) + queryRetryDelay(1)).toBeLessThanOrEqual(1000);
  });
});

describe('Object-not-found states (fixture mode)', () => {
  it('shows a not-found empty state for an unknown VMID instead of an infinite skeleton', async () => {
    const queryClient = createQueryClient();
    const router = createRouter({
      routeTree,
      history: createMemoryHistory({ initialEntries: ['/vm/pve1/qemu/999'] }),
    });

    render(
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>,
    );

    const elapsed = await expectNotFoundWithin(NOT_FOUND_BUDGET_MS);
    expect(elapsed).toBeLessThan(NOT_FOUND_BUDGET_MS);
    expect(screen.getByRole('link', { name: /back to dashboard/i })).toBeInTheDocument();
  });

  it('shows a not-found empty state for an unknown node instead of an infinite skeleton', async () => {
    const queryClient = createQueryClient();
    const router = createRouter({
      routeTree,
      history: createMemoryHistory({ initialEntries: ['/node/nope'] }),
    });

    render(
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>,
    );

    const elapsed = await expectNotFoundWithin(NOT_FOUND_BUDGET_MS);
    expect(elapsed).toBeLessThan(NOT_FOUND_BUDGET_MS);
    expect(screen.getByRole('link', { name: /back to dashboard/i })).toBeInTheDocument();
  });

  it('shows no status dot or node heading for a node that does not exist', async () => {
    const queryClient = createQueryClient();
    const router = createRouter({
      routeTree,
      history: createMemoryHistory({ initialEntries: ['/node/nope'] }),
    });

    render(
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>,
    );

    await expectNotFoundWithin(NOT_FOUND_BUDGET_MS);
    // Fix-wave 3, F5: no fake green "online" dot and no heading above the empty state.
    // (waitFor, because the route component and the Summary tab observe the same query and
    // commit in separate passes under react-query's notify batching.)
    await waitFor(() => {
      expect(screen.queryByRole('heading', { name: 'nope' })).toBeNull();
    });
    // The route short-circuits, so the Summary tab is not mounted: exactly one empty state,
    // and the page region holds nothing but it -- no status dot, no heading.
    expect(screen.getAllByText(/was not found/i)).toHaveLength(1);
    const region = screen.getByText(/was not found/i).closest<HTMLElement>('div.p-4');
    expect(region).not.toBeNull();
    expect(within(region!).queryByRole('img', { name: /^Status:/ })).toBeNull();
    expect(within(region!).queryByRole('heading')).toBeNull();
  });
});
