import { describe, expect, it } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider, createMemoryHistory, createRouter } from '@tanstack/react-router';

import { routeTree } from '@/routeTree.gen';
import { createQueryClient } from '@/api/queryClient';

// Nested route (VM status+config, then this tab's own node-tasks query) stacks a couple of the
// fixture client's simulated 250ms delays -- same budget as the other tab render tests (see
// breadcrumbs.render.test.tsx et al.'s own `FIND_TIMEOUT_MS`).
const FIND_TIMEOUT_MS = 10_000;

/**
 * T17: the VM Tasks tab used to read `useTasks()` (the cluster's short recent-task list) --
 * it now reads `useNodeTasks(node, { vmid, limit: 200, source: 'all' })`, the node's own task
 * index, which carries real per-guest history (see TasksTab.tsx).
 */
describe('VM Tasks tab (fixture mode)', () => {
  it('renders more than 25 rows for a guest with deep history (vmid 102)', async () => {
    const queryClient = createQueryClient();
    const router = createRouter({
      routeTree,
      history: createMemoryHistory({ initialEntries: ['/vm/pve1/qemu/102?tab=tasks'] }),
    });

    render(
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>,
    );

    const table = await screen.findByRole('table', {}, { timeout: FIND_TIMEOUT_MS });
    const rows = within(table).getAllByRole('row');
    // rows[0] is the header row.
    expect(rows.length - 1).toBeGreaterThan(25);
    // Every data row belongs to this guest.
    for (const row of rows.slice(1)) {
      expect(within(row).getByText('102')).toBeInTheDocument();
    }
  });

  it('still renders a running (no-endtime) task row without throwing', async () => {
    const queryClient = createQueryClient();
    const router = createRouter({
      routeTree,
      history: createMemoryHistory({ initialEntries: ['/vm/pve1/qemu/100?tab=tasks'] }),
    });

    render(
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>,
    );

    const table = await screen.findByRole('table', {}, { timeout: FIND_TIMEOUT_MS });
    // The fixture's running vzdump:100 task has no `status` text (PVE omits it while running) --
    // this just proves the row set includes it (by upid-bearing type/id) rather than filtering
    // it out or crashing on its missing `endtime`.
    expect(within(table).getAllByText('vzdump').length).toBeGreaterThan(0);
  });

  it('shows the "No tasks for this guest" empty state for a guest with none', async () => {
    const queryClient = createQueryClient();
    const router = createRouter({
      routeTree,
      // vmid 202 (backup-agent, lxc, stopped) has zero rows anywhere in the fixture task data.
      history: createMemoryHistory({ initialEntries: ['/vm/pve1/lxc/202?tab=tasks'] }),
    });

    render(
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>,
    );

    expect(
      await screen.findByText('No tasks for this guest.', undefined, { timeout: FIND_TIMEOUT_MS }),
    ).toBeInTheDocument();
  });
});
