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
 * "Clone…" gating in the object header's "More" menu (same pattern as
 * `migrate-guest.render.test.tsx`'s own copy of this setup, for migrate): a signed-in session and
 * `VM.Clone` gate the item; the dialog itself is exercised against a mocked
 * `cloneGuest`/`getCloneNextId` so a confirm's exact request body is asserted directly, without a
 * real network layer -- same convention `backups-tab-actions.render.test.tsx` uses for
 * `backupGuest`/`restoreGuest`.
 */
const mockUseAuthMe = vi.fn();
const mockUsePermissions = vi.fn();
const mockUseClusterResources = vi.fn();
const mockUseSnapshots = vi.fn();
const mockCloneGuest = vi.fn();
const mockGetCloneNextId = vi.fn();

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
    useSnapshots: (...args: unknown[]) => mockUseSnapshots(...args),
  };
});

vi.mock('@/api/actionHooks', async () => {
  const actual = await vi.importActual<typeof import('@/api/actionHooks')>('@/api/actionHooks');
  return { ...actual, usePermissions: (vmid: number) => mockUsePermissions(vmid) };
});

vi.mock('@/api/actions', async () => {
  const actual = await vi.importActual<typeof import('@/api/actions')>('@/api/actions');
  return {
    ...actual,
    cloneGuest: (...args: unknown[]) => mockCloneGuest(...args),
    getCloneNextId: (...args: unknown[]) => mockGetCloneNextId(...args),
  };
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

function sourceRow(template: boolean): ClusterResource {
  return {
    id: 'qemu/100',
    type: 'qemu',
    node: 'pve1',
    vmid: 100,
    name: 'web-prod-01',
    status: 'running',
    template: template ? 1 : 0,
  };
}

/** Wraps `ObjectHeader` in a router with a second, `/vm/$node/$type/$vmid` route so
 * `useCloneGuest`'s post-task navigate has somewhere real to land -- same convention
 * `backups-tab-actions.render.test.tsx`'s own `renderTab` uses for `useRestoreGuest`. */
function renderHeader({ status = 'running' }: { status?: string } = {}) {
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
  const vmRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/vm/$node/$type/$vmid',
    component: () => {
      const { node, type, vmid } = vmRoute.useParams();
      return <p>Landed on {`${node}/${type}/${vmid}`}</p>;
    },
  });
  const routeTree = rootRoute.addChildren([indexRoute, vmRoute]);
  const router = createRouter({ routeTree, history: createMemoryHistory({ initialEntries: ['/'] }) });
  const queryClient = createQueryClient();
  render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  return queryClient;
}

function renderContextMenu() {
  const rootRoute = createRootRoute({ component: () => <Outlet /> });
  const indexRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/',
    component: () => (
      <GuestContextMenu guest={{ node: 'pve1', type: 'qemu', vmid: 100, name: 'web-prod-01', status: 'running' }}>
        <button type="button">web-prod-01</button>
      </GuestContextMenu>
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

function openMoreMenu(trigger: HTMLElement) {
  fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false, pointerType: 'mouse' });
  fireEvent.pointerUp(trigger, { button: 0, ctrlKey: false, pointerType: 'mouse' });
  fireEvent.click(trigger);
}

async function openCloneDialog() {
  openMoreMenu(await screen.findByRole('button', { name: 'More actions' }));
  fireEvent.click(await screen.findByRole('menuitem', { name: /Clone/ }));
  return screen.findByRole('dialog');
}

describe('Clone… gating and dialog', () => {
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
    mockUseClusterResources.mockReturnValue({ data: [...CLUSTER_NODES, sourceRow(false)] });
    mockUseSnapshots.mockReturnValue({ data: [] });
    mockGetCloneNextId.mockResolvedValue(101);
    mockCloneGuest.mockResolvedValue({ upid: 'UPID:pve1:00000001:00000000:00000000:qmclone:100:root@pam:' });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('(a) token mode: the context menu\'s "Clone…" item is disabled with the read-only tooltip', async () => {
    // Same rationale as `migrate-guest.render.test.tsx`'s own token-mode test: the object header's
    // "More" trigger is disabled as a whole in token mode, so the per-item tooltip wording is
    // exercised through the context menu instead, which always opens and gates Clone item-by-item.
    mockUseAuthMe.mockReturnValue(authData('token'));
    mockUsePermissions.mockReturnValue(permissionsData(true));

    renderContextMenu();
    fireEvent.contextMenu(await screen.findByText('web-prod-01'));
    const menu = await screen.findByRole('menu');
    const cloneItem = within(menu).getByRole('menuitem', { name: /Clone/ });

    expect(cloneItem).toHaveAttribute('aria-disabled', 'true');
    expect(cloneItem).toHaveAttribute('title', 'Read-only: signed in with a service token');
  });

  it('(b) missing VM.Clone: the item is disabled with the permission tooltip', async () => {
    mockUseAuthMe.mockReturnValue(authData('session'));
    mockUsePermissions.mockReturnValue(permissionsData(false));

    renderHeader();
    openMoreMenu(await screen.findByRole('button', { name: 'More actions' }));
    const cloneItem = await screen.findByRole('menuitem', { name: /Clone/ });

    expect(cloneItem).toHaveAttribute('aria-disabled', 'true');
    expect(cloneItem).toHaveAttribute('title', "You don't have VM.Clone on this guest");
  });

  it('(c) dialog defaults (nextid, name, Full selected, Linked disabled) and submit sends exactly the default body', async () => {
    mockUseAuthMe.mockReturnValue(authData('session'));
    mockUsePermissions.mockReturnValue(permissionsData(true));

    renderHeader();
    const dialog = await openCloneDialog();

    const newIdInput = await within(dialog).findByLabelText('New VMID');
    await waitFor(() => expect(newIdInput).toHaveValue(101));

    const nameInput = within(dialog).getByLabelText('Name');
    expect(nameInput).toHaveValue('web-prod-01-clone');

    const fullRadio = within(dialog).getByRole('radio', { name: 'Full clone' });
    const linkedRadio = within(dialog).getByRole('radio', { name: 'Linked clone' });
    expect(fullRadio).toBeChecked();
    expect(linkedRadio).not.toBeChecked();
    expect(linkedRadio).toBeDisabled();
    within(dialog).getByText('Linked clones require a template');

    fireEvent.click(within(dialog).getByRole('button', { name: 'Clone' }));

    await waitFor(() =>
      expect(mockCloneGuest).toHaveBeenCalledWith('pve1', 'qemu', 100, {
        newid: 101,
        full: true,
        target: 'pve1',
        name: 'web-prod-01-clone',
      }),
    );
  });

  it('(d) template source: Linked clone is enabled and full:false is sent', async () => {
    mockUseAuthMe.mockReturnValue(authData('session'));
    mockUsePermissions.mockReturnValue(permissionsData(true));
    mockUseClusterResources.mockReturnValue({ data: [...CLUSTER_NODES, sourceRow(true)] });

    renderHeader();
    const dialog = await openCloneDialog();
    await within(dialog).findByLabelText('New VMID');

    const linkedRadio = within(dialog).getByRole('radio', { name: 'Linked clone' });
    expect(linkedRadio).not.toBeDisabled();
    fireEvent.click(linkedRadio);

    fireEvent.click(within(dialog).getByRole('button', { name: 'Clone' }));

    await waitFor(() =>
      expect(mockCloneGuest).toHaveBeenCalledWith(
        'pve1',
        'qemu',
        100,
        expect.objectContaining({ full: false }),
      ),
    );
  });

  it('(e) after the clone task finishes, the router navigates to the new guest URL', async () => {
    mockUseAuthMe.mockReturnValue(authData('session'));
    mockUsePermissions.mockReturnValue(permissionsData(true));

    const queryClient = renderHeader();
    const dialog = await openCloneDialog();
    await within(dialog).findByLabelText('New VMID');

    fireEvent.click(within(dialog).getByRole('button', { name: 'Clone' }));
    await waitFor(() => expect(mockCloneGuest).toHaveBeenCalled());

    queryClient.setQueryData(TASKS_QUERY_KEY, [
      {
        upid: 'UPID:pve1:00000001:00000000:00000000:qmclone:100:root@pam:',
        node: 'pve1',
        type: 'qmclone',
        id: '101',
        status: 'OK',
        starttime: 1,
        endtime: 2,
      },
    ]);

    await screen.findByText('Landed on pve1/qemu/101');
  });
});

describe('Clone…: fixture mode', () => {
  afterEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
  });

  it('(f) after fixtureCloneGuest resolves, cluster resources contain the new guest on the target node', async () => {
    const { fixtureCloneGuest } = await import('@/api/actionsFixture');
    const { fixtureClient } = await import('@/api/fixtures');

    const node = 'pve1';
    const target = 'pve2';
    const sourceVmid = 100;
    const newid = 987321;

    await fixtureCloneGuest(node, 'qemu', sourceVmid, { newid, full: true, target, name: 'fixture-clone' });

    const resources = await fixtureClient.getClusterResources();
    const cloned = resources.find((r) => r.type === 'qemu' && r.vmid === newid);
    expect(cloned).toBeDefined();
    expect(cloned?.node).toBe(target);
    expect(cloned?.name).toBe('fixture-clone');
    expect(cloned?.status).toBe('stopped');
  });
});
