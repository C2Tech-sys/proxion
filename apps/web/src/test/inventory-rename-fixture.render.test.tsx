import { describe, expect, it } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
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
 * Fixture mode (this suite's default, per `.env.test`) reports every privilege as granted, so
 * "Rename…" renders enabled with no auth/permission mocking needed -- same carve-out
 * `inventory-tree-actions.render.test.tsx` relies on for the power actions. Exercises the whole
 * flow through the real fixture mutator (`setFixtureGuestConfig`), confirming the tree's own
 * label -- not just the fixture config -- updates once the rename succeeds.
 */
function buildTestRouter() {
  const rootRoute = createRootRoute({ component: () => <Outlet /> });
  const indexRoute = createRoute({ getParentRoute: () => rootRoute, path: '/', component: InventoryTree });
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
  await screen.findByText('web-prod-02');
}

describe('Fixture-mode rename updates the tree label', () => {
  it('renaming db-prod-01 (vmid 102) through the context menu updates its label in the tree', async () => {
    await renderTree();

    fireEvent.contextMenu(screen.getByText('db-prod-01'));
    const menu = await screen.findByRole('menu');
    fireEvent.click(within(menu).getByRole('menuitem', { name: /Rename/ }));

    const dialog = await screen.findByRole('dialog');
    const input = within(dialog).getByRole('textbox', { name: 'Guest name' });
    fireEvent.change(input, { target: { value: 'db-prod-01-renamed' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Rename' }));

    await waitFor(() => expect(screen.getByText('db-prod-01-renamed')).toBeInTheDocument(), { timeout: 3000 });
    expect(screen.queryByText('db-prod-01')).not.toBeInTheDocument();
  });
});
