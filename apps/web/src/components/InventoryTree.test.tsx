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

import { InventoryTree } from './InventoryTree';
import { createQueryClient } from '@/api/queryClient';

/**
 * A minimal, non-file-based router just for this test: index route renders InventoryTree,
 * and a vm route renders a marker we can assert on to prove a real navigation happened
 * (rather than a left-click being swallowed by a menu trigger -- see fix-wave 2, F2).
 */
function buildTestRouter(initialEntries: string[] = ['/']) {
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
    component: function VmMarker() {
      const { vmid } = vmRoute.useParams();
      return <div>VM PAGE {vmid}</div>;
    },
  });
  const nodeRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/node/$node',
    validateSearch: (): { tab: string } => ({ tab: 'summary' }),
    component: function NodeMarker() {
      const { node } = nodeRoute.useParams();
      return <div>NODE PAGE {node}</div>;
    },
  });

  const routeTree = rootRoute.addChildren([indexRoute, vmRoute, nodeRoute]);
  return createRouter({ routeTree, history: createMemoryHistory({ initialEntries }) });
}

describe('InventoryTree row navigation (fix-wave 2, F2)', () => {
  it('left-clicking a guest row navigates to its VM page (not swallowed by a menu)', async () => {
    const queryClient = createQueryClient();
    const router = buildTestRouter();

    render(
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>,
    );

    const row = await screen.findByText('web-prod-01');
    fireEvent.click(row);

    expect(await screen.findByText('VM PAGE 100')).toBeInTheDocument();
  });
});


async function renderTree() {
  const queryClient = createQueryClient();
  const router = buildTestRouter();
  render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  // Wait for the fixture-backed tree to paint.
  await screen.findByText('web-prod-01');
}

describe('Node row context menu (fix-wave 3, F2)', () => {
  it('opens a context menu on the node row with Open, Open shell and Copy name', async () => {
    await renderTree();

    const nodeName = screen.getByRole('link', { name: 'pve1' });
    // Right-click, Shift+F10 and the context-menu key all dispatch this same native event;
    // the Radix trigger keys off it (on the row, which the name link bubbles the event up to),
    // so covering `contextmenu` covers all three.
    fireEvent.contextMenu(nodeName);

    const menu = await screen.findByRole('menu');
    expect(within(menu).getByRole('menuitem', { name: 'Open' })).toBeInTheDocument();
    expect(within(menu).getByRole('menuitem', { name: 'Open shell' })).toBeInTheDocument();
    expect(within(menu).getByRole('menuitem', { name: 'Copy name' })).toBeInTheDocument();
  });

  it('navigates to the node page from the context menu Open item', async () => {
    await renderTree();

    fireEvent.contextMenu(screen.getByRole('link', { name: 'pve1' }));
    const menu = await screen.findByRole('menu');
    fireEvent.click(within(menu).getByRole('menuitem', { name: 'Open' }));

    expect(await screen.findByText('NODE PAGE pve1')).toBeInTheDocument();
  });
});

describe('Node row name vs. chevron (T7)', () => {
  it('clicking the node NAME navigates to the node Summary page, not a subtree toggle', async () => {
    await renderTree();

    fireEvent.click(screen.getByRole('link', { name: 'pve1' }));

    expect(await screen.findByText('NODE PAGE pve1')).toBeInTheDocument();
    // The click navigated away from the tree entirely (not a toggle-in-place), so there is no
    // lingering "web-prod-01" row to assert against here.
  });

  it('clicking the chevron only toggles the subtree, without navigating', async () => {
    await renderTree();

    expect(screen.getByText('web-prod-01')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Collapse pve1' }));

    expect(screen.queryByText('web-prod-01')).toBeNull();
    // Still on the tree route -- no navigation happened.
    expect(screen.getByRole('link', { name: 'pve1' })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Expand pve1' }));
    expect(screen.getByText('web-prod-01')).toBeInTheDocument();
  });

  it('ArrowLeft/ArrowRight on the chevron also toggle the subtree', async () => {
    await renderTree();

    const chevron = screen.getByRole('button', { name: 'Collapse pve1' });
    fireEvent.keyDown(chevron, { key: 'ArrowLeft' });
    expect(screen.queryByText('web-prod-01')).toBeNull();

    fireEvent.keyDown(screen.getByRole('button', { name: 'Expand pve1' }), { key: 'ArrowRight' });
    expect(screen.getByText('web-prod-01')).toBeInTheDocument();
  });
});

describe('Datacenter header row (T7)', () => {
  it('navigates to / when clicked, from another route', async () => {
    // The tree lives in the persistent shell alongside the routed page in the real app (see
    // _shell.tsx) -- mirror that here (rather than reusing `buildTestRouter`, where the tree is
    // itself the index route's component) so we can click it while sitting on a different page.
    const rootRoute = createRootRoute({
      component: () => (
        <>
          <InventoryTree />
          <Outlet />
        </>
      ),
    });
    const indexRoute = createRoute({
      getParentRoute: () => rootRoute,
      path: '/',
      component: () => <div>DASHBOARD MARKER</div>,
    });
    const nodeRoute = createRoute({
      getParentRoute: () => rootRoute,
      path: '/node/$node',
      validateSearch: (): { tab: string } => ({ tab: 'summary' }),
      component: () => <div>NODE PAGE MARKER</div>,
    });
    const routeTree = rootRoute.addChildren([indexRoute, nodeRoute]);
    const router = createRouter({
      routeTree,
      history: createMemoryHistory({ initialEntries: ['/node/pve1?tab=summary'] }),
    });

    const queryClient = createQueryClient();
    render(
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>,
    );

    await screen.findByText('web-prod-01');
    expect(screen.getByText('NODE PAGE MARKER')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('link', { name: /Datacenter/i }));

    expect(await screen.findByText('DASHBOARD MARKER')).toBeInTheDocument();
  });
});

describe('Node row selected state (T7)', () => {
  it("shows the selected state when the current route is that node", async () => {
    const rootRoute = createRootRoute({ component: () => <Outlet /> });
    const nodeRoute = createRoute({
      getParentRoute: () => rootRoute,
      path: '/node/$node',
      validateSearch: (): { tab: string } => ({ tab: 'summary' }),
      component: InventoryTree,
    });
    const routeTree = rootRoute.addChildren([nodeRoute]);
    const router = createRouter({
      routeTree,
      history: createMemoryHistory({ initialEntries: ['/node/pve1?tab=summary'] }),
    });

    const queryClient = createQueryClient();
    render(
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>,
    );

    const nameLink = await screen.findByRole('link', { name: 'pve1' });
    const row = nameLink.closest('div');
    expect(row).not.toBeNull();
    expect(row).toHaveClass('bg-accent/15');
  });
});

describe('Guest row context menu (fix-wave 3, F2)', () => {
  it('no longer carries the "Open shell (node)" workaround item', async () => {
    await renderTree();

    fireEvent.contextMenu(screen.getByText('web-prod-01'));
    const menu = await screen.findByRole('menu');
    expect(within(menu).queryByRole('menuitem', { name: /Open shell \(node\)/ })).toBeNull();
    expect(within(menu).getByRole('menuitem', { name: 'Open' })).toBeInTheDocument();
    expect(within(menu).getByRole('menuitem', { name: 'Open console' })).toBeInTheDocument();
  });
});

describe('Guest row tags (fix-wave 3, F4)', () => {
  it('collapses multi-tag rows to one summary chip and exposes the full list as a tooltip', async () => {
    await renderTree();

    // win-dc01 has 4 tags: prod;windows;critical;dc
    const row = screen.getByText('win-dc01').closest('a');
    expect(row).not.toBeNull();
    const strip = within(row!).getByTitle('prod, windows, critical, dc');
    expect(strip).toBeInTheDocument();
    // Narrow arrangement: a single "N tags" chip. Wide arrangement: two chips + "+2".
    expect(within(strip).getByText('4 tags')).toBeInTheDocument();
    expect(within(strip).getByText('prod')).toBeInTheDocument();
    expect(within(strip).getByText('windows')).toBeInTheDocument();
    expect(within(strip).getByText('+2')).toBeInTheDocument();
  });
});
