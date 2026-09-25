import { describe, expect, it } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import { QueryClientProvider } from '@tanstack/react-query';
import {
  Outlet,
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from '@tanstack/react-router';

import { GuestContextMenu } from '@/components/actions/GuestContextMenu';
import { createQueryClient } from '@/api/queryClient';

/**
 * `GuestContextMenu` is the menu `InventoryTree.tsx`'s guest rows and `GuestsPage.tsx`'s table
 * rows both render (T25 extracted it out of the rail so both surfaces stay identical). These
 * tests exercise the shared component directly, in isolation from either caller, mirroring
 * `inventory-tree-actions.render.test.tsx`'s own expectations for the rail so a change to one
 * would have to break the other too.
 */
function buildTestRouter(initial: string) {
  const rootRoute = createRootRoute({ component: () => <Outlet /> });
  const homeRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/',
    component: () => (
      <GuestContextMenu guest={{ node: 'pve1', type: 'qemu', vmid: 100, name: 'web-prod-01', status: 'running' }}>
        <button type="button">web-prod-01</button>
      </GuestContextMenu>
    ),
  });
  const stoppedRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/stopped',
    component: () => (
      <GuestContextMenu guest={{ node: 'pve1', type: 'qemu', vmid: 101, name: 'db-prod-02', status: 'stopped' }}>
        <button type="button">db-prod-02</button>
      </GuestContextMenu>
    ),
  });
  const vmRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/vm/$node/$type/$vmid',
    validateSearch: (): { tab: string } => ({ tab: 'summary' }),
    component: () => <div>VM PAGE</div>,
  });
  const routeTree = rootRoute.addChildren([homeRoute, stoppedRoute, vmRoute]);
  return createRouter({ routeTree, history: createMemoryHistory({ initialEntries: [initial] }) });
}

function renderMenu(initial: string) {
  const queryClient = createQueryClient();
  const router = buildTestRouter(initial);
  render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
}

describe('GuestContextMenu (shared by the inventory rail and the Guests table, T25)', () => {
  it('a running guest offers Shut down, Reboot and Stop, not Start', async () => {
    renderMenu('/');
    await screen.findByText('web-prod-01');
    fireEvent.contextMenu(screen.getByText('web-prod-01'));
    const menu = await screen.findByRole('menu');

    expect(within(menu).getByRole('menuitem', { name: /Shut down/ })).toBeEnabled();
    expect(within(menu).getByRole('menuitem', { name: /Reboot/ })).toBeEnabled();
    expect(within(menu).getByRole('menuitem', { name: /Stop/ })).toBeEnabled();
    expect(within(menu).queryByRole('menuitem', { name: /^Start/ })).not.toBeInTheDocument();
  });

  it('a stopped guest offers Start, not Shut down/Reboot/Stop', async () => {
    renderMenu('/stopped');
    await screen.findByText('db-prod-02');
    fireEvent.contextMenu(screen.getByText('db-prod-02'));
    const menu = await screen.findByRole('menu');

    expect(within(menu).getByRole('menuitem', { name: /Start/ })).toBeEnabled();
    expect(within(menu).queryByRole('menuitem', { name: /Shut down/ })).not.toBeInTheDocument();
    expect(within(menu).queryByRole('menuitem', { name: /Reboot/ })).not.toBeInTheDocument();
    expect(within(menu).queryByRole('menuitem', { name: /^Stop/ })).not.toBeInTheDocument();
  });

  it('offers Open, Open console, Copy VMID, Copy name and Rename alongside the power actions', async () => {
    renderMenu('/');
    await screen.findByText('web-prod-01');
    fireEvent.contextMenu(screen.getByText('web-prod-01'));
    const menu = await screen.findByRole('menu');

    expect(within(menu).getByRole('menuitem', { name: /^Open$/ })).toBeInTheDocument();
    expect(within(menu).getByRole('menuitem', { name: /Open console/ })).toBeInTheDocument();
    expect(within(menu).getByRole('menuitem', { name: /Copy VMID/ })).toBeInTheDocument();
    expect(within(menu).getByRole('menuitem', { name: /Copy name/ })).toBeInTheDocument();
    expect(within(menu).getByRole('menuitem', { name: /Rename/ })).toBeInTheDocument();
  });
});
