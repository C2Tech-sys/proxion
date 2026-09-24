import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
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
import { ObjectHeader } from '@/components/ObjectHeader';
import { createQueryClient } from '@/api/queryClient';
import type { AuthIdentity } from '@/api/client-types';
import type { GuestPermissions } from '@/api/actionHooks';

/**
 * "Rename…" gating in both surfaces it's wired into (InventoryTree's context menu, ObjectHeader's
 * "More" menu), on `VM.Config.Options` -- independent of `VM.PowerMgmt`, same pattern
 * `object-header-actions.render.test.tsx` uses for the power actions themselves.
 */
const mockUseAuthMe = vi.fn();
const mockUsePermissions = vi.fn();

vi.mock('@/api/client', async () => {
  const actual = await vi.importActual<typeof import('@/api/client')>('@/api/client');
  return { ...actual, USE_FIXTURES: false };
});

vi.mock('@/api/hooks', async () => {
  const actual = await vi.importActual<typeof import('@/api/hooks')>('@/api/hooks');
  return { ...actual, useAuthMe: () => mockUseAuthMe() };
});

vi.mock('@/api/actionHooks', async () => {
  const actual = await vi.importActual<typeof import('@/api/actionHooks')>('@/api/actionHooks');
  return { ...actual, usePermissions: (vmid: number) => mockUsePermissions(vmid) };
});

function authData(mode: AuthIdentity['mode']) {
  return { data: { username: 'root@pam', realm: 'pam', capabilities: {}, mode } };
}

function permissionsData(can: boolean) {
  const value: GuestPermissions = { can: () => can };
  return { data: value };
}

function buildInventoryRouter() {
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

async function renderInventoryTree() {
  const queryClient = createQueryClient();
  const router = buildInventoryRouter();
  render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  await screen.findByText('web-prod-01');
}

function renderHeader(status: 'running' | 'stopped' = 'running') {
  const rootRoute = createRootRoute({ component: () => <Outlet /> });
  const indexRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/',
    component: () => (
      <ObjectHeader
        breadcrumb={[{ label: 'Datacenter', to: 'home' }, { label: 'web-prod-01' }]}
        name="web-prod-01"
        vmid={100}
        status={status}
        node="pve1"
        type="qemu"
      />
    ),
  });
  const routeTree = rootRoute.addChildren([indexRoute]);
  const router = createRouter({ routeTree, history: createMemoryHistory({ initialEntries: ['/'] }) });
  const queryClient = createQueryClient();
  render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
}

describe('InventoryTree context menu Rename gating', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('enabled with session + VM.Config.Options', async () => {
    mockUseAuthMe.mockReturnValue(authData('session'));
    mockUsePermissions.mockReturnValue(permissionsData(true));

    await renderInventoryTree();
    fireEvent.contextMenu(screen.getByText('web-prod-01'));
    const menu = await screen.findByRole('menu');

    expect(within(menu).getByRole('menuitem', { name: /Rename/ })).not.toHaveAttribute('aria-disabled', 'true');
  });

  it('disabled without VM.Config.Options', async () => {
    mockUseAuthMe.mockReturnValue(authData('session'));
    mockUsePermissions.mockReturnValue(permissionsData(false));

    await renderInventoryTree();
    fireEvent.contextMenu(screen.getByText('web-prod-01'));
    const menu = await screen.findByRole('menu');

    expect(within(menu).getByRole('menuitem', { name: /Rename/ })).toHaveAttribute('aria-disabled', 'true');
  });
});

describe('ObjectHeader More menu Rename', () => {
  beforeEach(() => {
    // jsdom doesn't implement the Pointer Events API Radix's DropdownMenu relies on to open --
    // minimal no-op polyfills so a real click on its trigger works here (same as
    // topbar-preferences-menu.render.test.tsx's identical setup for its own DropdownMenu).
    if (!Element.prototype.hasPointerCapture) {
      Element.prototype.hasPointerCapture = () => false;
    }
    if (!Element.prototype.setPointerCapture) {
      Element.prototype.setPointerCapture = () => {};
    }
    if (!Element.prototype.releasePointerCapture) {
      Element.prototype.releasePointerCapture = () => {};
    }
    if (!Element.prototype.scrollIntoView) {
      Element.prototype.scrollIntoView = () => {};
    }
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  function openMoreMenu(trigger: HTMLElement) {
    // Radix's trigger opens on `pointerdown`, not `click`.
    fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false, pointerType: 'mouse' });
    fireEvent.pointerUp(trigger, { button: 0, ctrlKey: false, pointerType: 'mouse' });
    fireEvent.click(trigger);
  }

  it('offers Rename in the More menu for a running guest', async () => {
    mockUseAuthMe.mockReturnValue(authData('session'));
    mockUsePermissions.mockReturnValue(permissionsData(true));

    renderHeader('running');
    openMoreMenu(await screen.findByRole('button', { name: 'More actions' }));
    expect(await screen.findByRole('menuitem', { name: /Rename/ })).toBeInTheDocument();
  });

  it('offers Rename in the More menu even for a stopped guest (rename is not a power action)', async () => {
    mockUseAuthMe.mockReturnValue(authData('session'));
    mockUsePermissions.mockReturnValue(permissionsData(true));

    renderHeader('stopped');
    openMoreMenu(await screen.findByRole('button', { name: 'More actions' }));
    expect(await screen.findByRole('menuitem', { name: /Rename/ })).toBeInTheDocument();
  });
});

