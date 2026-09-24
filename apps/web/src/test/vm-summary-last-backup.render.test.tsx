import { describe, expect, it } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider, createMemoryHistory, createRouter } from '@tanstack/react-router';

import { routeTree } from '@/routeTree.gen';
import { createQueryClient } from '@/api/queryClient';

// See vm-tasks-tab.render.test.tsx's own copy of this constant for why: several of this page's
// fixture-client queries (status, config, agent, rrd, cluster resources, and this panel's own
// node-tasks query) stack their simulated delays past the default 1000ms `findBy*` timeout.
const FIND_TIMEOUT_MS = 5000;

/**
 * T17: the VM Summary "Last backup" panel used to read `useTasks()` (the cluster's short
 * recent-task list), which never holds a guest's actual nightly-backup history -- it now reads
 * `useNodeTasks(node, { vmid, typefilter: 'vzdump', ... })` instead. See SummaryTab.tsx.
 */
describe('VM Summary "Last backup" panel (fixture mode)', () => {
  it('shows a populated backup row set for a running guest with vzdump history (vmid 104)', async () => {
    const queryClient = createQueryClient();
    const router = createRouter({
      routeTree,
      // vmid 104 (lab-ubuntu) has only the fixture's new nightly-backup rows (no pre-existing
      // ad-hoc vzdump entry from the original fixture list) -- its newest is unambiguously one
      // of them, run by backup@pve. (vmid 102 also has deep history, used by the VM Tasks tab
      // ">25 rows" test, but its *newest* vzdump happens to be a pre-existing, more-recent,
      // ad-hoc entry from the original fixture -- also correct behavior, just not what this
      // assertion is about.)
      history: createMemoryHistory({ initialEntries: ['/vm/pve1/qemu/104'] }),
    });

    render(
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>,
    );

    const heading = await screen.findByRole('heading', { name: 'Last backup' }, { timeout: FIND_TIMEOUT_MS });
    const panel = within(heading.closest('section')!);

    expect(await panel.findByText('Started', undefined, { timeout: FIND_TIMEOUT_MS })).toBeInTheDocument();
    expect(panel.getByText('Duration')).toBeInTheDocument();
    expect(panel.getByText('Status')).toBeInTheDocument();
    expect(panel.getByText('Run by')).toBeInTheDocument();
    // The nightly vzdump rows in fixtures.ts are run by backup@pve.
    expect(panel.getByText('backup@pve')).toBeInTheDocument();
    // Never the old empty-state copy.
    expect(panel.queryByText(/No backup task/)).toBeNull();
    expect(panel.queryByText(/No backups yet/)).toBeNull();
  });

  it('shows the empty state for a guest with no vzdump history (vmid 202)', async () => {
    const queryClient = createQueryClient();
    const router = createRouter({
      routeTree,
      history: createMemoryHistory({ initialEntries: ['/vm/pve1/lxc/202'] }),
    });

    render(
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>,
    );

    const heading = await screen.findByRole('heading', { name: 'Last backup' }, { timeout: FIND_TIMEOUT_MS });
    const panel = within(heading.closest('section')!);

    expect(
      await panel.findByText("No backup task in this node's history.", undefined, {
        timeout: FIND_TIMEOUT_MS,
      }),
    ).toBeInTheDocument();
  });
});
