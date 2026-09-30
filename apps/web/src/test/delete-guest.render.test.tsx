import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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

import { ObjectHeader } from '@/components/ObjectHeader';
import { GuestContextMenu } from '@/components/actions/GuestContextMenu';
import { createQueryClient } from '@/api/queryClient';
import { TASKS_QUERY_KEY } from '@/api/liveState';
import type { AuthIdentity } from '@/api/client-types';
import type { GuestPermissions } from '@/api/actionHooks';
import type { ClusterResource } from '@/api/types';

/**
 * "Delete…" gating and dialog in the object header's "More" menu / the guest context menu (same
 * setup as `clone-guest.render.test.tsx`): a signed-in session and `VM.Allocate` gate the item; the
 * dialog (typed-VMID confirm, running-guest guard) is exercised against a mocked `destroyGuest` so
 * a confirm's exact request is asserted directly, without a real network layer.
 */
const mockUseAuthMe = vi.fn();
const mockUsePermissions = vi.fn();
const mockUseClusterResources = vi.fn();
const mockDestroyGuest = vi.fn();

vi.mock('@/api/client', async () => {
  const actual = await vi.importActual<typeof import('@/api/client')>('@/api/client');
  return { ...actual, USE_FIXTURES: false };
});

vi.mock('@/api/hooks', async () => {
  const actual = await vi.importActual<typeof import('@/api/hooks')>('@/api/hooks');
  return {
    ...actual,
    useAuthMe: () => mockUseAuthMe(),
    useClusterResources: () => mockUseClusterResources(),
  };
});

vi.mock('@/api/actionHooks', async () => {
  const actual = await vi.importActual<typeof import('@/api/actionHooks')>('@/api/actionHooks');
  return { ...actual, usePermissions: (vmid: number) => mockUsePermissions(vmid) };
});

vi.mock('@/api/actions', async () => {
  const actual = await vi.importActual<typeof import('@/api/actions')>('@/api/actions');
  return { ...actual, destroyGuest: (...args: unknown[]) => mockDestroyGuest(...args) };
});

function authData(mode: AuthIdentity['mode']) {
  return { data: { username: 'root@pam', realm: 'pam', capabilities: {}, mode } };
}

function permissionsData(can: boolean) {
  const value: GuestPermissions = { can: () => can };
  return { data: value };
}

const CLUSTER_NODES: ClusterResource[] = [
  { id: 'node/pve1', type: 'node', node: 'pve1', status: 'online' },
  { id: 'node/pve2', type: 'node', node: 'pve2', status: 'online' },
];

const UPID = 'UPID:pve1:00000001:00000000:00000000:qmdestroy:100:root@pam:';

/** Wraps `ObjectHeader` in a router with a second, `/node/$node` route so `useDestroyGuest`'s
 * post-task navigate has somewhere real to land (and its `tab` search param can be asserted). */
function renderHeader({ status = 'stopped' }: { status?: string } = {}) {
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
  const nodeRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/node/$node',
    validateSearch: (search: Record<string, unknown>): { tab?: string } =>
      typeof search.tab === 'string' ? { tab: search.tab } : {},
    component: () => {
      const { node } = nodeRoute.useParams();
      const { tab } = nodeRoute.useSearch();
      return <p>Landed on node {`${node}?tab=${tab}`}</p>;
    },
  });
  const routeTree = rootRoute.addChildren([indexRoute, nodeRoute]);
  const router = createRouter({ routeTree, history: createMemoryHistory({ initialEntries: ['/'] }) });
  const queryClient = createQueryClient();
  render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  return { queryClient, router };
}

function renderContextMenu() {
  const rootRoute = createRootRoute({ component: () => <Outlet /> });
  const indexRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/',
    component: () => (
      <GuestContextMenu guest={{ node: 'pve1', type: 'qemu', vmid: 100, name: 'web-prod-01', status: 'stopped' }}>
        <button type="button">web-prod-01</button>
      </GuestContextMenu>
    ),
  });
  const routeTree = rootRoute.addChildren([indexRoute]);
  const router = createRouter({ routeTree, history: createMemoryHistory({ initialEntries: ['/'] }) });
  render(
    <QueryClientProvider client={createQueryClient()}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
}

function openMoreMenu(trigger: HTMLElement) {
  fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false, pointerType: 'mouse' });
  fireEvent.pointerUp(trigger, { button: 0, ctrlKey: false, pointerType: 'mouse' });
  fireEvent.click(trigger);
}

async function openDeleteDialog() {
  openMoreMenu(await screen.findByRole('button', { name: 'More actions' }));
  fireEvent.click(await screen.findByRole('menuitem', { name: /Delete/ }));
  return screen.findByRole('alertdialog');
}

describe('Delete… gating and dialog', () => {
  beforeEach(() => {
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
    mockUseClusterResources.mockReturnValue({ data: CLUSTER_NODES });
    mockDestroyGuest.mockResolvedValue({ upid: UPID });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('(a) token mode: the context menu\'s "Delete…" item is disabled with the read-only tooltip', async () => {
    // The object header's "More" trigger is disabled as a whole in token mode, so the per-item
    // tooltip wording is exercised through the context menu, which gates Delete item-by-item.
    mockUseAuthMe.mockReturnValue(authData('token'));
    mockUsePermissions.mockReturnValue(permissionsData(true));

    renderContextMenu();
    fireEvent.contextMenu(await screen.findByText('web-prod-01'));
    const menu = await screen.findByRole('menu');
    const deleteItem = within(menu).getByRole('menuitem', { name: /Delete/ });

    expect(deleteItem).toHaveAttribute('aria-disabled', 'true');
    expect(deleteItem).toHaveAttribute('title', 'Read-only: signed in with a service token');
  });

  it('(a2) token mode: the object header\'s "More" trigger is disabled, so Delete… is unreachable', async () => {
    mockUseAuthMe.mockReturnValue(authData('token'));
    mockUsePermissions.mockReturnValue(permissionsData(true));

    renderHeader();
    const more = await screen.findByRole('button', { name: 'More actions' });
    expect(more).toBeDisabled();
  });

  it('(b) missing VM.Allocate: the header item is disabled with the permission tooltip, and is the last item', async () => {
    mockUseAuthMe.mockReturnValue(authData('session'));
    mockUsePermissions.mockReturnValue(permissionsData(false));

    renderHeader();
    openMoreMenu(await screen.findByRole('button', { name: 'More actions' }));
    const deleteItem = await screen.findByRole('menuitem', { name: /Delete/ });

    expect(deleteItem).toHaveAttribute('aria-disabled', 'true');
    expect(deleteItem).toHaveAttribute('title', "You don't have VM.Allocate on this guest");

    const items = screen.getAllByRole('menuitem');
    expect(items.at(-1)).toBe(deleteItem);
  });

  it('(b2) missing VM.Allocate: the context menu item is disabled with the permission tooltip', async () => {
    mockUseAuthMe.mockReturnValue(authData('session'));
    mockUsePermissions.mockReturnValue(permissionsData(false));

    renderContextMenu();
    fireEvent.contextMenu(await screen.findByText('web-prod-01'));
    const menu = await screen.findByRole('menu');
    const deleteItem = within(menu).getByRole('menuitem', { name: /Delete/ });

    expect(deleteItem).toHaveAttribute('aria-disabled', 'true');
    expect(deleteItem).toHaveAttribute('title', "You don't have VM.Allocate on this guest");
  });

  it('(c) running guest: shows "Stop the guest first" and the confirm stays disabled even with the VMID typed', async () => {
    mockUseAuthMe.mockReturnValue(authData('session'));
    mockUsePermissions.mockReturnValue(permissionsData(true));

    renderHeader({ status: 'running' });
    const dialog = await openDeleteDialog();

    within(dialog).getByText('Stop the guest first');
    fireEvent.change(within(dialog).getByLabelText('Type the VMID to confirm'), { target: { value: '100' } });
    const confirm = within(dialog).getByRole('button', { name: 'Delete 100' });
    expect(confirm).toBeDisabled();

    fireEvent.click(confirm);
    expect(mockDestroyGuest).not.toHaveBeenCalled();
  });

  it('(d) stopped guest: confirm needs the exact VMID, then sends the default body', async () => {
    mockUseAuthMe.mockReturnValue(authData('session'));
    mockUsePermissions.mockReturnValue(permissionsData(true));

    renderHeader();
    const dialog = await openDeleteDialog();

    within(dialog).getByText('Delete web-prod-01 (100)?');
    expect(within(dialog).queryByText('Stop the guest first')).toBeNull();
    const purge = within(dialog).getByRole('checkbox', {
      name: 'Also remove it from backup jobs, replication and HA (purge)',
    });
    const unreferenced = within(dialog).getByRole('checkbox', {
      name: 'Destroy unreferenced disks owned by this guest',
    });
    expect(purge).not.toBeChecked();
    expect(unreferenced).toBeChecked();

    const confirm = within(dialog).getByRole('button', { name: 'Delete 100' });
    const input = within(dialog).getByLabelText('Type the VMID to confirm');
    expect(confirm).toBeDisabled();

    fireEvent.change(input, { target: { value: '10' } });
    expect(confirm).toBeDisabled();
    fireEvent.change(input, { target: { value: '1000' } });
    expect(confirm).toBeDisabled();
    fireEvent.change(input, { target: { value: '100' } });
    expect(confirm).toBeEnabled();

    fireEvent.click(confirm);

    await waitFor(() =>
      expect(mockDestroyGuest).toHaveBeenCalledWith('pve1', 'qemu', 100, {
        purge: false,
        destroyUnreferencedDisks: true,
      }),
    );
  });

  it('(d2) toggled options are sent', async () => {
    mockUseAuthMe.mockReturnValue(authData('session'));
    mockUsePermissions.mockReturnValue(permissionsData(true));

    renderHeader();
    const dialog = await openDeleteDialog();

    fireEvent.click(
      within(dialog).getByRole('checkbox', { name: 'Also remove it from backup jobs, replication and HA (purge)' }),
    );
    fireEvent.click(within(dialog).getByRole('checkbox', { name: 'Destroy unreferenced disks owned by this guest' }));
    fireEvent.change(within(dialog).getByLabelText('Type the VMID to confirm'), { target: { value: '100' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete 100' }));

    await waitFor(() =>
      expect(mockDestroyGuest).toHaveBeenCalledWith('pve1', 'qemu', 100, {
        purge: true,
        destroyUnreferencedDisks: false,
      }),
    );
  });

  it('(e) after the delete task finishes, the router lands on the node page (Summary tab)', async () => {
    mockUseAuthMe.mockReturnValue(authData('session'));
    mockUsePermissions.mockReturnValue(permissionsData(true));

    const { queryClient, router } = renderHeader();
    const dialog = await openDeleteDialog();

    fireEvent.change(within(dialog).getByLabelText('Type the VMID to confirm'), { target: { value: '100' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete 100' }));
    await waitFor(() => expect(mockDestroyGuest).toHaveBeenCalled());

    queryClient.setQueryData(TASKS_QUERY_KEY, [
      { upid: UPID, node: 'pve1', type: 'qmdestroy', id: '100', status: 'OK', starttime: 1, endtime: 2 },
    ]);

    await screen.findByText('Landed on node pve1?tab=summary');
    expect(router.state.location.pathname).toBe('/node/pve1');
    expect(router.state.location.search).toEqual({ tab: 'summary' });
  });

  it('(e2) a failed delete task does not navigate', async () => {
    mockUseAuthMe.mockReturnValue(authData('session'));
    mockUsePermissions.mockReturnValue(permissionsData(true));

    const { queryClient, router } = renderHeader();
    const dialog = await openDeleteDialog();

    fireEvent.change(within(dialog).getByLabelText('Type the VMID to confirm'), { target: { value: '100' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete 100' }));
    await waitFor(() => expect(mockDestroyGuest).toHaveBeenCalled());

    queryClient.setQueryData(TASKS_QUERY_KEY, [
      {
        upid: UPID,
        node: 'pve1',
        type: 'qmdestroy',
        id: '100',
        status: 'VM is locked (backup)',
        starttime: 1,
        endtime: 2,
      },
    ]);

    // Give the task-feed subscription a beat to (not) act.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(router.state.location.pathname).toBe('/');
  });
});

describe('Delete…: fixture mode', () => {
  afterEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
  });

  it('(f) after fixtureDestroyGuest resolves, the guest is gone from cluster resources', async () => {
    const { fixtureDestroyGuest } = await import('@/api/actionsFixture');
    const { fixtureClient } = await import('@/api/fixtures');

    const before = await fixtureClient.getClusterResources();
    expect(before.some((r) => r.type === 'qemu' && r.vmid === 100)).toBe(true);

    await fixtureDestroyGuest('pve1', 'qemu', 100);

    const after = await fixtureClient.getClusterResources();
    expect(after.some((r) => r.type === 'qemu' && r.vmid === 100)).toBe(false);
    expect(after.length).toBe(before.length - 1);
  });
});
