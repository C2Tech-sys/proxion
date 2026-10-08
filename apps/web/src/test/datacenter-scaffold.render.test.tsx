import { describe, expect, it } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import { QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider, createMemoryHistory, createRouter } from '@tanstack/react-router';

import { routeTree } from '@/routeTree.gen';
import { createQueryClient } from '@/api/queryClient';
import { APP_NAME } from '@/lib/app';

/** Generous on purpose: fixture mode adds a simulated 250ms network delay per query, and the
 *  full suite runs many jsdom environments in parallel. */
const FIND_TIMEOUT_MS = 10_000;

function renderAt(path: string) {
  const queryClient = createQueryClient();
  const router = createRouter({ routeTree, history: createMemoryHistory({ initialEntries: [path] }) });
  render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  return router;
}

async function tabNames(): Promise<string[]> {
  const tablist = await screen.findByRole('tablist', undefined, { timeout: FIND_TIMEOUT_MS });
  return within(tablist)
    .getAllByRole('tab')
    .map((tab) => tab.textContent ?? '');
}

/**
 * The Datacenter page and the node Network tab are scaffolds: each tab is registered and renders
 * a `data-testid` stub, so this test only checks routing, registration, order and the fallback --
 * never a tab's content (each feature lands with its own render test). Deliberately never lands on
 * a Monitor tab (see tab-range-preservation.render.test.tsx for why).
 */
describe('Datacenter page scaffold (fixture mode)', () => {
  it('the inventory tree root navigates to /datacenter and shows the Overview dashboard', async () => {
    const router = renderAt('/guests');

    const tree = await screen.findByRole('tree', { name: 'Inventory' }, { timeout: FIND_TIMEOUT_MS });
    fireEvent.click(await within(tree).findByRole('link', { name: /Datacenter/i }, { timeout: FIND_TIMEOUT_MS }));

    expect(
      await screen.findByRole(
        'heading',
        { level: 1, name: `${APP_NAME} Dashboard` },
        { timeout: FIND_TIMEOUT_MS },
      ),
    ).toBeInTheDocument();
    expect(router.state.location.pathname).toBe('/datacenter');
    expect(screen.getByRole('tab', { name: 'Overview' })).toHaveAttribute('aria-selected', 'true');
  });

  it('shows the six tabs in order and each non-Overview tab renders its stub', async () => {
    renderAt('/datacenter');

    expect(await tabNames()).toEqual([
      'Overview',
      'Backup Jobs',
      'Firewall',
      'Users & Permissions',
      'Storage',
      'Pools',
    ]);

    for (const [label, testId] of [
      ['Backup Jobs', 'dc-backup-tab'],
      ['Firewall', 'dc-firewall-tab'],
      ['Users & Permissions', 'dc-users-tab'],
      ['Storage', 'dc-storage-tab'],
      ['Pools', 'dc-pools-tab'],
    ] as const) {
      // Radix's TabsTrigger switches tabs on `mousedown`, not `click`.
      fireEvent.mouseDown(screen.getByRole('tab', { name: label }), { button: 0 });
      const panel = await screen.findByTestId(testId, undefined, { timeout: FIND_TIMEOUT_MS });
      expect(panel).toHaveTextContent('Coming soon.');
    }
  });

  it('falls back to Overview for an unknown ?tab=, like the VM and node pages do', async () => {
    const router = renderAt('/datacenter?tab=nope');

    await tabNames();
    expect(screen.getByRole('tab', { name: 'Overview' })).toHaveAttribute('aria-selected', 'true');
    expect(router.state.location.pathname).toBe('/datacenter');
    expect(
      await screen.findByRole('heading', { level: 1, name: `${APP_NAME} Dashboard` }, { timeout: FIND_TIMEOUT_MS }),
    ).toBeInTheDocument();
  });

  it('honours a valid ?tab= on a deep link', async () => {
    renderAt('/datacenter?tab=pools');

    await tabNames();
    expect(screen.getByRole('tab', { name: 'Pools' })).toHaveAttribute('aria-selected', 'true');
    expect(await screen.findByTestId('dc-pools-tab', undefined, { timeout: FIND_TIMEOUT_MS })).toBeInTheDocument();
  });
});

describe('Node page Network tab scaffold (fixture mode)', () => {
  it('shows a Network tab between Storage and Tasks, and it renders its stub', async () => {
    renderAt('/node/pve1');

    const names = await tabNames();
    expect(names).toEqual(['Summary', 'Monitor', 'Shell', 'Storage', 'Network', 'Tasks']);

    fireEvent.mouseDown(screen.getByRole('tab', { name: 'Network' }), { button: 0 });
    const panel = await screen.findByTestId('node-network-tab', undefined, { timeout: FIND_TIMEOUT_MS });
    expect(panel).toHaveTextContent('Coming soon.');
  });
});
