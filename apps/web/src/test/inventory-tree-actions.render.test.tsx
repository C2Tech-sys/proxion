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

import { InventoryTree } from '@/components/InventoryTree';
import { createQueryClient } from '@/api/queryClient';

/**
 * Context-menu guest actions (Start/Shut down/Reboot/Stop), added under a separator alongside
 * the existing Open/console/copy items. Runs under fixture mode (this suite's default, per
 * `.env.test`) where `usePermissions`/session-mode both resolve to "always allowed" -- see
 * `ObjectHeader.tsx`/`InventoryTree.tsx`'s shared `USE_FIXTURES` carve-out -- so these render
 * enabled without needing to mock auth/permissions separately from `InventoryTree.test.tsx`.
 */
function buildTestRouter() {
  const rootRoute = createRootRoute({ component: () => <Outlet /> });
  const indexRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/',
    component: InventoryTree,
  });
  const vmRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/vm/$node/$type/$vmid',
    validateSearch: (): { tab: string } => ({ tab: 'summary' }),
    component: () => <div>VM PAGE</div>,
  });
  const nodeRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/node/$node',
    validateSearch: (): { tab: string } => ({ tab: 'summary' }),
    component: () => <div>NODE PAGE</div>,
  });
  const routeTree = rootRoute.addChildren([indexRoute, vmRoute, nodeRoute]);
  return createRouter({ routeTree, history: createMemoryHistory({ initialEntries: ['/'] }) });
}

async function renderTree() {
  const queryClient = createQueryClient();
  const router = buildTestRouter();
  render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  await screen.findByText('web-prod-01');
}

describe('Guest row context menu actions', () => {
  it('a running guest (web-prod-01) offers Shut down, Reboot and Stop, not Start', async () => {
    await renderTree();

    fireEvent.contextMenu(screen.getByText('web-prod-01'));
    const menu = await screen.findByRole('menu');

    expect(within(menu).getByRole('menuitem', { name: /Shut down/ })).toBeEnabled();
    expect(within(menu).getByRole('menuitem', { name: /Reboot/ })).toBeEnabled();
    expect(within(menu).getByRole('menuitem', { name: /Stop/ })).toBeEnabled();
    expect(within(menu).queryByRole('menuitem', { name: /^Start/ })).not.toBeInTheDocument();
  });

  it('a stopped guest (db-prod-02) offers Start, not Shut down/Reboot/Stop', async () => {
    await renderTree();

    fireEvent.contextMenu(screen.getByText('db-prod-02'));
    const menu = await screen.findByRole('menu');

    expect(within(menu).getByRole('menuitem', { name: /Start/ })).toBeEnabled();
    expect(within(menu).queryByRole('menuitem', { name: /Shut down/ })).not.toBeInTheDocument();
    expect(within(menu).queryByRole('menuitem', { name: /Reboot/ })).not.toBeInTheDocument();
    expect(within(menu).queryByRole('menuitem', { name: /^Stop/ })).not.toBeInTheDocument();
  });

  it('still offers Open, Open console, Copy VMID and Copy name alongside the new actions', async () => {
    await renderTree();

    fireEvent.contextMenu(screen.getByText('web-prod-01'));
    const menu = await screen.findByRole('menu');

    expect(within(menu).getByRole('menuitem', { name: /^Open$/ })).toBeInTheDocument();
    expect(within(menu).getByRole('menuitem', { name: /Open console/ })).toBeInTheDocument();
    expect(within(menu).getByRole('menuitem', { name: /Copy VMID/ })).toBeInTheDocument();
    expect(within(menu).getByRole('menuitem', { name: /Copy name/ })).toBeInTheDocument();
  });
});
