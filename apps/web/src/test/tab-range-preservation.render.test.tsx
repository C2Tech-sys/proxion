import { describe, expect, it } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider, createMemoryHistory, createRouter } from '@tanstack/react-router';

import { routeTree } from '@/routeTree.gen';
import { createQueryClient } from '@/api/queryClient';

/** Generous on purpose: fixture mode adds a simulated 250ms network delay per query, and the
 *  full suite runs many jsdom environments in parallel, so the default 1000ms `findBy*` budget
 *  can flake under load even though it's comfortable in isolation. */
const FIND_TIMEOUT_MS = 5000;

/**
 * `setTab` used to replace the whole search object (`{ tab }`), dropping `?range=` on a plain
 * tab click. It now merges onto the previous search, so a chart's chosen range survives
 * switching tabs and back. Covers both the VM/CT object page and the node object page.
 *
 * Deliberately never lands on (or leaves from) the Monitor tab here: mounting it would mount
 * `TimeSeriesChart`, which dynamically imports the real `uplot` package -- and that package
 * touches `matchMedia` as soon as its module evaluates, which jsdom doesn't implement (see
 * TimeSeriesChart.tsx's own note on this). `range` is a plain search param independent of
 * which tab is active, so Hardware/Summary <-> Snapshots and Storage/Summary cover the same
 * `setTab` regression without ever needing a real chart to render.
 */
describe('Tab switches preserve `?range=` (object pages)', () => {
  it('keeps range when switching from Hardware to Snapshots on a VM page', async () => {
    const queryClient = createQueryClient();
    const router = createRouter({
      routeTree,
      history: createMemoryHistory({ initialEntries: ['/vm/pve1/qemu/100?tab=hardware&range=day'] }),
    });

    render(
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>,
    );

    await screen.findByText('Processors', undefined, { timeout: FIND_TIMEOUT_MS });

    // Radix's TabsTrigger switches tabs on `mousedown`, not `click` -- see
    // @radix-ui/react-tabs' TabsTrigger.
    const snapshotsTab = await screen.findByRole('tab', { name: 'Snapshots' }, { timeout: FIND_TIMEOUT_MS });
    fireEvent.mouseDown(snapshotsTab, { button: 0 });

    await waitFor(
      () => {
        expect(router.state.location.search).toMatchObject({ tab: 'snapshots', range: 'day' });
      },
      { timeout: FIND_TIMEOUT_MS },
    );
  });

  it('keeps range when switching from Storage to Summary on a node page', async () => {
    const queryClient = createQueryClient();
    const router = createRouter({
      routeTree,
      history: createMemoryHistory({ initialEntries: ['/node/pve1?tab=storage&range=week'] }),
    });

    render(
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>,
    );

    await screen.findByRole('cell', { name: 'tank-backups' }, { timeout: FIND_TIMEOUT_MS });

    // Radix's TabsTrigger switches tabs on `mousedown`, not `click` -- see
    // @radix-ui/react-tabs' TabsTrigger.
    const summaryTab = await screen.findByRole('tab', { name: 'Summary' }, { timeout: FIND_TIMEOUT_MS });
    fireEvent.mouseDown(summaryTab, { button: 0 });

    await waitFor(
      () => {
        expect(router.state.location.search).toMatchObject({ tab: 'summary', range: 'week' });
      },
      { timeout: FIND_TIMEOUT_MS },
    );
  });
});
