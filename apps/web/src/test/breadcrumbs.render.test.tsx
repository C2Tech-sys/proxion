import { describe, expect, it } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider, createMemoryHistory, createRouter } from '@tanstack/react-router';

import { routeTree } from '@/routeTree.gen';
import { createQueryClient } from '@/api/queryClient';

/** Generous on purpose -- see tab-range-preservation.render.test.tsx for why. */
const FIND_TIMEOUT_MS = 5000;

function renderAt(path: string) {
  const queryClient = createQueryClient();
  const router = createRouter({
    routeTree,
    history: createMemoryHistory({ initialEntries: [path] }),
  });
  render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  return router;
}

describe('Breadcrumbs per route (T7)', () => {
  it('Dashboard: a single, unlinked "Datacenter" segment', async () => {
    renderAt('/');

    const nav = await screen.findByRole('navigation', { name: 'Breadcrumb' }, { timeout: FIND_TIMEOUT_MS });
    expect(within(nav).getByText('Datacenter')).toBeInTheDocument();
    expect(within(nav).queryAllByRole('link')).toHaveLength(0);
  });

  it('Tasks: "Datacenter › Tasks", with Datacenter linking to /', async () => {
    renderAt('/tasks');

    const nav = await screen.findByRole('navigation', { name: 'Breadcrumb' }, { timeout: FIND_TIMEOUT_MS });
    const homeLink = within(nav).getByRole('link', { name: 'Datacenter' });
    expect(homeLink).toHaveAttribute('href', '/');
    expect(within(nav).getByText('Tasks')).toBeInTheDocument();
  });

  it('Node page: "Datacenter › pve1", with Datacenter linking to / and pve1 unlinked', async () => {
    renderAt('/node/pve1?tab=summary');

    const nav = await screen.findByRole('navigation', { name: 'Breadcrumb' }, { timeout: FIND_TIMEOUT_MS });
    const homeLink = within(nav).getByRole('link', { name: 'Datacenter' });
    expect(homeLink).toHaveAttribute('href', '/');
    expect(within(nav).getByText('pve1')).toBeInTheDocument();
    expect(within(nav).queryAllByRole('link')).toHaveLength(1);
  });

  it('Guest page: "Datacenter › pve1 › web-prod-01", first two segments linked', async () => {
    renderAt('/vm/pve1/qemu/100?tab=summary');

    const nav = await screen.findByRole('navigation', { name: 'Breadcrumb' }, { timeout: FIND_TIMEOUT_MS });
    const homeLink = await within(nav).findByRole('link', { name: 'Datacenter' }, { timeout: FIND_TIMEOUT_MS });
    expect(homeLink).toHaveAttribute('href', '/');
    const nodeLink = within(nav).getByRole('link', { name: 'pve1' });
    expect(nodeLink).toHaveAttribute('href', '/node/pve1?tab=summary');
    expect(within(nav).getByText('web-prod-01')).toBeInTheDocument();
    expect(within(nav).queryAllByRole('link')).toHaveLength(2);
  });
});
