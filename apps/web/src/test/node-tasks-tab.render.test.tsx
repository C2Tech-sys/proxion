import { describe, expect, it } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider, createMemoryHistory, createRouter } from '@tanstack/react-router';

import { routeTree } from '@/routeTree.gen';
import { createQueryClient } from '@/api/queryClient';

// See vm-tasks-tab.render.test.tsx's own copy of this constant for why: the node route's
// status/config queries plus this tab's own node-tasks query stack the fixture client's
// simulated delays past the default 1000ms `findBy*` timeout on a slower CI run.
const FIND_TIMEOUT_MS = 5000;

/**
 * T17: the node Tasks tab used to read `useTasks()` (the cluster's short recent-task list) --
 * it now reads `useNodeTasks(node, { limit: 200, source: 'all' })`, the node's own task index.
 * See node/tabs/TasksTab.tsx. The footer's "N === limit" behavior is exercised separately, with
 * a mocked hook, in node-tasks-tab-footer.test.tsx (this file must not mock `@/api/hooks` --
 * it exercises the real fixture client end to end).
 */
describe('Node Tasks tab (fixture mode)', () => {
  it('renders real (deep) task history -- more rows than the 25-row cluster recent-task cap', async () => {
    const queryClient = createQueryClient();
    const router = createRouter({
      routeTree,
      history: createMemoryHistory({ initialEntries: ['/node/pve1?tab=tasks'] }),
    });

    render(
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>,
    );

    const table = await screen.findByRole('table', {}, { timeout: FIND_TIMEOUT_MS });
    const rows = within(table).getAllByRole('row');
    expect(rows.length - 1).toBeGreaterThan(25);
    // A nightly vzdump row must be present (this is the whole point of the fix).
    expect(within(table).getAllByText('vzdump').length).toBeGreaterThan(0);
  });

  it('does not show the "Showing the node\'s last N tasks" footer below the 200-row limit', async () => {
    const queryClient = createQueryClient();
    const router = createRouter({
      routeTree,
      history: createMemoryHistory({ initialEntries: ['/node/pve1?tab=tasks'] }),
    });

    render(
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>,
    );

    await screen.findByRole('table', {}, { timeout: FIND_TIMEOUT_MS });
    // The fixture's total pve1 task count is comfortably under 200 today.
    expect(screen.queryByText(/Showing the node's last \d+ tasks\./)).toBeNull();
  });
});
