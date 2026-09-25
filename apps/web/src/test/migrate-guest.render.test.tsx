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
import type { AuthIdentity } from '@/api/client-types';
import type { GuestPermissions } from '@/api/actionHooks';
import type { ClusterResource, GuestType } from '@/api/types';
import type { MigratePrecheck } from '@/api/actions';

/**
 * "Migrate…" gating in the object header's "More" menu (same pattern as
 * `object-header-actions.render.test.tsx`/`rename-guest.render.test.tsx`'s own copies of this
 * setup, for the power actions and rename respectively): a signed-in session, `VM.Migrate`, and
 * at least one other cluster node all gate the item; the dialog itself is exercised against a
 * mocked `migrateGuest`/`getMigratePrecheck` so a confirm's exact request body is asserted
 * directly, the same way `rename-guest.render.test.tsx` never hits a real network layer either.
 */
const mockUseAuthMe = vi.fn();
const mockUsePermissions = vi.fn();
const mockUseClusterResources = vi.fn();
const mockMigrateGuest = vi.fn();
const mockGetMigratePrecheck = vi.fn();

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
  return {
    ...actual,
    migrateGuest: (...args: unknown[]) => mockMigrateGuest(...args),
    getMigratePrecheck: (...args: unknown[]) => mockGetMigratePrecheck(...args),
  };
});

function authData(mode: AuthIdentity['mode']) {
  return { data: { username: 'root@pam', realm: 'pam', capabilities: {}, mode } };
}

function permissionsData(can: boolean) {
  const value: GuestPermissions = { can: () => can };
  return { data: value };
}

/** `pve1` (the guest's own node), `pve2` (another online node) and `pve3` (offline) -- enough to
 * exercise "other nodes only" and "offline disabled" in one fixture. */
const CLUSTER_NODES: ClusterResource[] = [
  { id: 'node/pve1', type: 'node', node: 'pve1', status: 'online' },
  { id: 'node/pve2', type: 'node', node: 'pve2', status: 'online' },
  { id: 'node/pve3', type: 'node', node: 'pve3', status: 'offline' },
];

/** Same three nodes, but `pve3` online too -- for the `notAllowedNodes`-driven disabling tests,
 * where "not eligible" needs to come from PVE's own precheck data rather than being offline. */
const CLUSTER_NODES_ALL_ONLINE: ClusterResource[] = [
  { id: 'node/pve1', type: 'node', node: 'pve1', status: 'online' },
  { id: 'node/pve2', type: 'node', node: 'pve2', status: 'online' },
  { id: 'node/pve3', type: 'node', node: 'pve3', status: 'online' },
];

const EMPTY_PRECHECK: MigratePrecheck = {
  running: true,
  allowedNodes: ['pve2'],
  notAllowedNodes: {},
  localDisks: [],
  localResources: [],
};

function renderHeader({
  status = 'running',
  type = 'qemu',
  vmid = 100,
}: { status?: string; type?: GuestType; vmid?: number } = {}) {
  const rootRoute = createRootRoute({ component: () => <Outlet /> });
  const indexRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/',
    component: () => (
      <ObjectHeader
        breadcrumb={[{ label: 'Datacenter', to: 'home' }, { label: 'web-prod-01' }]}
        name="web-prod-01"
        vmid={vmid}
        status={status}
        node="pve1"
        type={type}
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

function renderContextMenu({ status = 'running', type = 'qemu', vmid = 100 }: { status?: string; type?: GuestType; vmid?: number } = {}) {
  const rootRoute = createRootRoute({ component: () => <Outlet /> });
  const indexRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/',
    component: () => (
      <GuestContextMenu guest={{ node: 'pve1', type, vmid, name: 'web-prod-01', status }}>
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
  // Radix's DropdownMenu trigger opens on `pointerdown`, not `click` -- same polyfill/sequence
  // `rename-guest.render.test.tsx` uses for the identical "More actions" trigger.
  fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false, pointerType: 'mouse' });
  fireEvent.pointerUp(trigger, { button: 0, ctrlKey: false, pointerType: 'mouse' });
  fireEvent.click(trigger);
}

async function openMigrateDialog() {
  openMoreMenu(await screen.findByRole('button', { name: 'More actions' }));
  fireEvent.click(await screen.findByRole('menuitem', { name: /Migrate/ }));
  return screen.findByRole('dialog');
}

describe('Migrate… gating and dialog', () => {
  beforeEach(() => {
    // jsdom doesn't implement the Pointer Events API Radix's DropdownMenu/Select rely on --
    // same minimal no-op polyfills `rename-guest.render.test.tsx` sets up for its own DropdownMenu.
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
    mockGetMigratePrecheck.mockResolvedValue(EMPTY_PRECHECK);
    mockMigrateGuest.mockResolvedValue({ upid: 'UPID:pve1:00000001:00000000:00000000:qmigrate:100:root@pam:' });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('enabled with session + VM.Migrate; dialog lists other nodes only, offline node disabled', async () => {
    mockUseAuthMe.mockReturnValue(authData('session'));
    mockUsePermissions.mockReturnValue(permissionsData(true));

    renderHeader();
    openMoreMenu(await screen.findByRole('button', { name: 'More actions' }));
    const migrateItem = await screen.findByRole('menuitem', { name: /Migrate/ });
    expect(migrateItem).not.toHaveAttribute('aria-disabled', 'true');

    fireEvent.click(migrateItem);
    const dialog = await screen.findByRole('dialog');

    fireEvent.click(within(dialog).getByRole('combobox', { name: 'Target node' }));
    const options = await screen.findAllByRole('option');
    const optionNames = options.map((o) => o.textContent);
    expect(optionNames.some((t) => t?.includes('pve1'))).toBe(false);
    expect(optionNames.some((t) => t?.includes('pve2'))).toBe(true);

    const pve3Option = options.find((o) => o.textContent?.includes('pve3'));
    expect(pve3Option).toHaveAttribute('aria-disabled', 'true');
    const pve2Option = options.find((o) => o.textContent?.includes('pve2') && !o.textContent?.includes('pve3'));
    expect(pve2Option).not.toHaveAttribute('aria-disabled', 'true');
  });

  it("token mode: the context menu's Migrate item is disabled with the read-only tooltip text", async () => {
    // The object header's "More" trigger is disabled as a whole in token mode (same as Rename --
    // see `object-header-actions.render.test.tsx`'s identical token-mode assertion, unchanged by
    // this ticket), so the per-item tooltip wording is exercised through the context menu
    // instead, whose trigger always opens and gates Migrate (like every other action) item-by-item.
    mockUseAuthMe.mockReturnValue(authData('token'));
    mockUsePermissions.mockReturnValue(permissionsData(true));

    renderContextMenu();
    fireEvent.contextMenu(await screen.findByText('web-prod-01'));
    const menu = await screen.findByRole('menu');
    const migrateItem = within(menu).getByRole('menuitem', { name: /Migrate/ });

    expect(migrateItem).toHaveAttribute('aria-disabled', 'true');
    expect(migrateItem).toHaveAttribute('title', 'Read-only: signed in with a service token');
  });

  it('qemu running with a local disk: both checkboxes default on; confirm sends target/online/withLocalDisks', async () => {
    mockUseAuthMe.mockReturnValue(authData('session'));
    mockUsePermissions.mockReturnValue(permissionsData(true));
    mockGetMigratePrecheck.mockResolvedValue({
      ...EMPTY_PRECHECK,
      localDisks: [{ volid: 'local-lvm:vm-100-disk-0', size: 1, cdrom: false, isUnused: false }],
    });

    renderHeader({ status: 'running', type: 'qemu', vmid: 100 });
    const dialog = await openMigrateDialog();

    const onlineCheckbox = await within(dialog).findByRole('checkbox', { name: /Online \(live\) migration/ });
    const localDisksCheckbox = await within(dialog).findByRole('checkbox', { name: /Migrate local disks/ });
    expect(onlineCheckbox).toHaveAttribute('aria-checked', 'true');
    expect(localDisksCheckbox).toHaveAttribute('aria-checked', 'true');

    fireEvent.click(within(dialog).getByRole('button', { name: 'Migrate' }));

    await waitFor(() =>
      expect(mockMigrateGuest).toHaveBeenCalledWith('pve1', 'qemu', 100, {
        target: 'pve2',
        online: true,
        withLocalDisks: true,
      }),
    );
  });

  it("a not-allowed (but online) node is disabled in the picker with PVE's reason", async () => {
    mockUseAuthMe.mockReturnValue(authData('session'));
    mockUsePermissions.mockReturnValue(permissionsData(true));
    mockUseClusterResources.mockReturnValue({ data: CLUSTER_NODES_ALL_ONLINE });
    mockGetMigratePrecheck.mockResolvedValue({
      ...EMPTY_PRECHECK,
      allowedNodes: [],
      notAllowedNodes: { pve3: { unavailableStorages: ['tank'], blockingHaResources: [] } },
    });

    renderHeader();
    const dialog = await openMigrateDialog();

    fireEvent.click(within(dialog).getByRole('combobox', { name: 'Target node' }));
    const pve3Option = await screen.findByRole('option', { name: /pve3/ });
    expect(pve3Option).toHaveAttribute('aria-disabled', 'true');
    expect(pve3Option.textContent).toContain('Storage not available: tank');
    const pve2Option = screen.getByRole('option', { name: /pve2/ });
    expect(pve2Option).not.toHaveAttribute('aria-disabled', 'true');
  });

  it(
    'the first eligible node becomes the default target; confirm is enabled and sends it; ' +
      'precheck is queried without a target first, then with the chosen one',
    async () => {
      mockUseAuthMe.mockReturnValue(authData('session'));
      mockUsePermissions.mockReturnValue(permissionsData(true));
      mockUseClusterResources.mockReturnValue({ data: CLUSTER_NODES_ALL_ONLINE });
      mockGetMigratePrecheck.mockResolvedValue({
        ...EMPTY_PRECHECK,
        allowedNodes: [],
        notAllowedNodes: { pve3: { unavailableStorages: ['tank'], blockingHaResources: [] } },
      });

      renderHeader();
      const dialog = await openMigrateDialog();

      // pve2 -- the only eligible node -- becomes the default target with no picker interaction
      // at all, and confirm is enabled and fires with target: 'pve2'.
      await waitFor(() => expect(within(dialog).getByRole('button', { name: 'Migrate' })).toBeEnabled());
      fireEvent.click(within(dialog).getByRole('button', { name: 'Migrate' }));
      await waitFor(() =>
        expect(mockMigrateGuest).toHaveBeenCalledWith(
          'pve1',
          'qemu',
          100,
          expect.objectContaining({ target: 'pve2' }),
        ),
      );

      // The cluster-wide precheck (no target) ran first, so the picker knew pve3 was not-allowed
      // before any target was chosen; a later call was then made with the chosen target (pve2).
      expect(mockGetMigratePrecheck.mock.calls[0]).toEqual(['pve1', 'qemu', 100, undefined]);
      expect(mockGetMigratePrecheck.mock.calls.some((call) => call[3] === 'pve2')).toBe(true);
    },
  );

  it('no eligible target node: confirm is disabled and "No eligible target node" is shown', async () => {
    mockUseAuthMe.mockReturnValue(authData('session'));
    mockUsePermissions.mockReturnValue(permissionsData(true));
    mockUseClusterResources.mockReturnValue({ data: CLUSTER_NODES_ALL_ONLINE });
    mockGetMigratePrecheck.mockResolvedValue({
      ...EMPTY_PRECHECK,
      allowedNodes: [],
      notAllowedNodes: {
        pve2: { unavailableStorages: ['tank'], blockingHaResources: [] },
        pve3: { unavailableStorages: [], blockingHaResources: ['ha:vm100'] },
      },
    });

    renderHeader();
    const dialog = await openMigrateDialog();

    await within(dialog).findByText('No eligible target node');
    expect(within(dialog).getByRole('button', { name: 'Migrate' })).toBeDisabled();
  });

  it('lxc running: confirm sends target/restart only', async () => {
    mockUseAuthMe.mockReturnValue(authData('session'));
    mockUsePermissions.mockReturnValue(permissionsData(true));
    mockGetMigratePrecheck.mockResolvedValue(EMPTY_PRECHECK);

    renderHeader({ status: 'running', type: 'lxc', vmid: 200 });
    const dialog = await openMigrateDialog();

    // No live-migration/local-disk checkboxes for lxc -- just the fixed restart-mode note.
    expect(within(dialog).queryByRole('checkbox')).not.toBeInTheDocument();
    await within(dialog).findByText(/Restart mode/);

    fireEvent.click(within(dialog).getByRole('button', { name: 'Migrate' }));

    await waitFor(() =>
      expect(mockMigrateGuest).toHaveBeenCalledWith('pve1', 'lxc', 200, { target: 'pve2', restart: true }),
    );
  });
});

describe('fixture-mode migrate', () => {
  afterEach(() => {
    vi.resetModules();
  });

  it('fixtureMigrateGuest moves the guest to the target node in the fixture resources', async () => {
    const { fixtureMigrateGuest } = await import('@/api/actionsFixture');
    const { fixtureClient } = await import('@/api/fixtures');

    const before = await fixtureClient.getClusterResources();
    const guest = before.find((r) => r.type === 'qemu' && r.vmid === 100);
    expect(guest).toBeDefined();
    const originalNode = guest!.node;
    const target = originalNode === 'pve1' ? 'pve2' : 'pve1';

    await fixtureMigrateGuest(originalNode, 'qemu', 100, { target });

    const after = await fixtureClient.getClusterResources();
    const moved = after.find((r) => r.type === 'qemu' && r.vmid === 100);
    expect(moved?.node).toBe(target);

    // Restore, so this test has no lasting effect on the shared in-memory fixture module for any
    // other test file that imports it in the same worker.
    await fixtureMigrateGuest(target, 'qemu', 100, { target: originalNode });
  });
});
