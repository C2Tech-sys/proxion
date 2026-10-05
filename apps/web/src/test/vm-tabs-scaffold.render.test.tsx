import { describe, expect, it } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import { QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider, createMemoryHistory, createRouter } from '@tanstack/react-router';

import { routeTree } from '@/routeTree.gen';
import { createQueryClient } from '@/api/queryClient';

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
 * The Cloud-Init / Options / Firewall tabs are registered with "Coming soon." stubs so the
 * parallel feature work can each own one component file. Deliberately never lands on the Monitor
 * tab (see tab-range-preservation.render.test.tsx for why).
 */
describe('VM page tab scaffold (fixture mode)', () => {
  it('shows Cloud-Init, Options and Firewall on a VM in order, and each renders its stub', async () => {
    renderAt('/vm/pve1/qemu/100');

    const names = await tabNames();
    expect(names).toEqual([
      'Summary',
      'Monitor',
      'Console',
      'Hardware',
      'Cloud-Init',
      'Options',
      'Snapshots',
      'Backups',
      'Firewall',
      'Tasks',
    ]);
    expect(names.indexOf('Cloud-Init')).toBeLessThan(names.indexOf('Options'));
    expect(names.indexOf('Options')).toBeLessThan(names.indexOf('Firewall'));

    for (const [label, testId] of [
      ['Cloud-Init', 'cloudinit-tab'],
      ['Options', 'options-tab'],
      ['Firewall', 'firewall-tab'],
    ] as const) {
      // Radix's TabsTrigger switches tabs on `mousedown`, not `click`.
      fireEvent.mouseDown(screen.getByRole('tab', { name: label }), { button: 0 });
      const stub = await screen.findByTestId(testId, undefined, { timeout: FIND_TIMEOUT_MS });
      expect(within(stub).getByText('Coming soon.')).toBeInTheDocument();
    }
  });

  it('shows Options and Firewall but not Cloud-Init on a container', async () => {
    renderAt('/vm/pve2/lxc/200');

    const names = await tabNames();
    expect(names).toContain('Options');
    expect(names).toContain('Firewall');
    expect(names).not.toContain('Cloud-Init');
  });

  it('falls back to Summary for ?tab=cloudinit on a container, like an unknown tab does', async () => {
    const router = renderAt('/vm/pve2/lxc/200?tab=cloudinit');

    const names = await tabNames();
    expect(names).not.toContain('Cloud-Init');
    expect(screen.getByRole('tab', { name: 'Summary' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.queryByTestId('cloudinit-tab')).not.toBeInTheDocument();
    expect(router.state.location.pathname).toBe('/vm/pve2/lxc/200');
  });
});
