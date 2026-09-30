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

import { BackupsTab } from '@/pages/vm/tabs/BackupsTab';
import { createQueryClient } from '@/api/queryClient';
import { TASKS_QUERY_KEY } from '@/api/liveState';
import type { AuthIdentity } from '@/api/client-types';
import type { GuestPermissions } from '@/api/actionHooks';
import type { BackupContentItem, ClusterResource } from '@/api/types';

/**
 * "Backup now" / per-row Restore/Delete gating and submit flow on the Backups tab (T41), same
 * mocking shape `snapshots-tab.render.test.tsx`/`migrate-guest.render.test.tsx` use for their own
 * tabs/dialogs: `useAuthMe`/`useClusterResources` (from `@/api/hooks`) and `usePermissions` (from
 * `@/api/actionHooks`) control the session/permission gate; `api.getStorageContent` and
 * `backupGuest`/`restoreGuest`/`getRestoreNextId` (from `@/api/actions`) are mocked so a submit's
 * exact request body is asserted directly, without a real network layer. `useStorageDelete` (used
 * by the reused `DeleteVolumeDialog`) is left as its actual implementation -- it itself calls the
 * mocked `deleteStorageContent`.
 */
const mockUseAuthMe = vi.fn();
const mockUsePermissions = vi.fn();
const mockUseClusterResources = vi.fn();
const mockGetStorageContent = vi.fn();
const mockBackupGuest = vi.fn();
const mockRestoreGuest = vi.fn();
const mockGetRestoreNextId = vi.fn();
const mockDeleteStorageContent = vi.fn();

vi.mock('@/api/client', async () => {
  const actual = await vi.importActual<typeof import('@/api/client')>('@/api/client');
  return {
    ...actual,
    USE_FIXTURES: false,
    api: { ...actual.api, getStorageContent: (...args: unknown[]) => mockGetStorageContent(...args) },
  };
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
    backupGuest: (...args: unknown[]) => mockBackupGuest(...args),
    restoreGuest: (...args: unknown[]) => mockRestoreGuest(...args),
    getRestoreNextId: (...args: unknown[]) => mockGetRestoreNextId(...args),
    deleteStorageContent: (...args: unknown[]) => mockDeleteStorageContent(...args),
  };
});

function authData(mode: AuthIdentity['mode']) {
  return { data: { username: 'root@pam', realm: 'pam', capabilities: {}, mode } };
}

function permissionsData(can: boolean) {
  const value: GuestPermissions = { can: () => can };
  return { data: value };
}

const STORAGE_RESOURCE: ClusterResource = {
  id: 'storage/pve1/local',
  type: 'storage',
  node: 'pve1',
  status: 'available',
  storage: 'local',
  content: 'backup,iso',
};

const GUEST_RESOURCE: ClusterResource = {
  id: 'qemu/100',
  type: 'qemu',
  node: 'pve1',
  vmid: 100,
  name: 'web-prod-01',
  status: 'stopped',
};

const BACKUP_ITEM: BackupContentItem = {
  volid: 'local:backup/vzdump-qemu-100-2024_01_01-00_00_00.tar.zst',
  content: 'backup',
  format: 'tar.zst',
  size: 123456,
  vmid: 100,
  ctime: 1700000000,
};

/** No global `fetch` in jsdom -- `BackupsTab`'s own per-storage permission check calls it
 * directly (not through a mocked hook); stubbed here to grant nothing, matching this suite's
 * scenarios, none of which depend on the Delete row action being *enabled* via that check
 * (a protected row is disabled regardless; the enabled-Delete case isn't exercised here). */
function stubFetch() {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue({ ok: true, json: async () => ({ data: {} }) }),
  );
}

/** Wraps `BackupsTab` in a router with a second, `/vm/$node/$type/$vmid` route so
 * `useRestoreGuest`'s post-restore navigate (on a new-id restore) has somewhere real to land --
 * same convention `migrate-guest.render.test.tsx`'s `renderHeader` uses for its own navigate. */
function renderTab({
  vmid = 100,
  guestResource = GUEST_RESOURCE,
  storageResource = STORAGE_RESOURCE,
}: { vmid?: number; guestResource?: ClusterResource | null; storageResource?: ClusterResource | null } = {}) {
  mockUseClusterResources.mockReturnValue({
    data: [storageResource, guestResource].filter((r): r is ClusterResource => r !== null),
  });

  const rootRoute = createRootRoute({ component: () => <Outlet /> });
  const indexRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/',
    component: () => <BackupsTab node="pve1" type="qemu" vmid={vmid} />,
  });
  const vmRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/vm/$node/$type/$vmid',
    component: () => {
      const { node, type, vmid: routedVmid } = vmRoute.useParams();
      return <p>Landed on {`${node}/${type}/${routedVmid}`}</p>;
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

/** Radix's `DropdownMenu` trigger opens on `pointerdown`, not `click` -- same polyfill/sequence
 * `snapshots-tab.render.test.tsx`/`rename-guest.render.test.tsx` use for their own row menus. */
function openRowMenu(trigger: HTMLElement) {
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
  fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false, pointerType: 'mouse' });
  fireEvent.pointerUp(trigger, { button: 0, ctrlKey: false, pointerType: 'mouse' });
  fireEvent.click(trigger);
}

describe('BackupsTab: "Backup now" gating and submit', () => {
  beforeEach(() => {
    stubFetch();
    mockGetStorageContent.mockResolvedValue([]);
    mockBackupGuest.mockResolvedValue({ upid: 'UPID:pve1:00000001:00000000:00000000:vzdump:100:root@pam:' });
  });

  afterEach(() => {
    vi.clearAllMocks();
    vi.unstubAllGlobals();
  });

  it('(a) token mode: "Backup now" is disabled', async () => {
    mockUseAuthMe.mockReturnValue(authData('token'));
    mockUsePermissions.mockReturnValue(permissionsData(true));

    renderTab();

    const button = await screen.findByRole('button', { name: /Backup now/ });
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute('aria-disabled', 'true');
  });

  it('(b) session + VM.Backup: dialog submit calls backupGuest with the default body', async () => {
    mockUseAuthMe.mockReturnValue(authData('session'));
    mockUsePermissions.mockReturnValue(permissionsData(true));

    renderTab();

    const button = await screen.findByRole('button', { name: /Backup now/ });
    expect(button).not.toBeDisabled();
    fireEvent.click(button);

    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Start backup' }));

    await waitFor(() =>
      expect(mockBackupGuest).toHaveBeenCalledWith('pve1', 'qemu', 100, {
        storage: 'local',
        mode: 'snapshot',
        compress: 'zstd',
        protected: false,
        notes: '{{guestname}}',
        prune: false,
      }),
    );
  });
});

describe('BackupsTab: per-row Restore', () => {
  beforeEach(() => {
    stubFetch();
    mockUseAuthMe.mockReturnValue(authData('session'));
    mockUsePermissions.mockReturnValue(permissionsData(true));
    mockGetStorageContent.mockResolvedValue([BACKUP_ITEM]);
    mockRestoreGuest.mockResolvedValue({ upid: 'UPID:pve1:00000001:00000000:00000000:qmrestore:100:root@pam:' });
  });

  afterEach(() => {
    vi.clearAllMocks();
    vi.unstubAllGlobals();
  });

  async function openRestoreDialog() {
    openRowMenu(await screen.findByRole('button', { name: /Actions for/ }));
    fireEvent.click(await screen.findByRole('menuitem', { name: /Restore/ }));
    return screen.findByRole('dialog');
  }

  it('(c) restore over self requires typing the VMID and sends force/start/unique', async () => {
    mockGetRestoreNextId.mockResolvedValue(101);
    renderTab();

    const dialog = await openRestoreDialog();

    // Overwriting itself (default target === 100, which already exists): the confirm button
    // starts disabled until the vmid is typed back.
    const overwriteButton = within(dialog).getByRole('button', { name: 'Overwrite 100' });
    expect(overwriteButton).toBeDisabled();

    fireEvent.change(within(dialog).getByLabelText('Type the VMID to confirm'), { target: { value: '100' } });
    expect(overwriteButton).not.toBeDisabled();

    fireEvent.click(overwriteButton);

    await waitFor(() =>
      expect(mockRestoreGuest).toHaveBeenCalledWith('pve1', 'qemu', 100, {
        archive: BACKUP_ITEM.volid,
        targetVmid: 100,
        start: false,
        force: true,
        unique: false,
      }),
    );
  });

  it('(d) restore to the next free id omits force and navigates to the new guest on task completion', async () => {
    mockGetRestoreNextId.mockResolvedValue(101);
    const queryClient = renderTab();

    const dialog = await openRestoreDialog();

    fireEvent.click(await within(dialog).findByRole('button', { name: 'Use next free ID' }));
    await within(dialog).findByRole('button', { name: 'Restore as 101' });

    fireEvent.click(within(dialog).getByRole('button', { name: 'Restore as 101' }));

    await waitFor(() =>
      expect(mockRestoreGuest).toHaveBeenCalledWith('pve1', 'qemu', 100, {
        archive: BACKUP_ITEM.volid,
        targetVmid: 101,
        start: false,
        unique: false,
      }),
    );

    // Simulate the live task feed reporting the restore task finished -- `useRestoreGuest` then
    // navigates to the new guest's own URL.
    queryClient.setQueryData(TASKS_QUERY_KEY, [
      {
        upid: 'UPID:pve1:00000001:00000000:00000000:qmrestore:100:root@pam:',
        node: 'pve1',
        type: 'qmrestore',
        id: '101',
        status: 'OK',
        starttime: 1,
        endtime: 2,
      },
    ]);

    await screen.findByText('Landed on pve1/qemu/101');
  });
});

describe('BackupsTab: per-row Delete', () => {
  beforeEach(() => {
    stubFetch();
    mockUseAuthMe.mockReturnValue(authData('session'));
    mockUsePermissions.mockReturnValue(permissionsData(true));
  });

  afterEach(() => {
    vi.clearAllMocks();
    vi.unstubAllGlobals();
  });

  it('(e) a protected row has Delete disabled with "Protected backup"', async () => {
    mockGetStorageContent.mockResolvedValue([{ ...BACKUP_ITEM, protected: true }]);
    renderTab();

    openRowMenu(await screen.findByRole('button', { name: /Actions for/ }));
    const deleteItem = await screen.findByRole('menuitem', { name: /Delete/ });
    expect(deleteItem).toHaveAttribute('aria-disabled', 'true');
    expect(deleteItem).toHaveAttribute('title', 'Protected backup');
  });
});

describe('BackupsTab: fixture mode', () => {
  afterEach(async () => {
    vi.clearAllMocks();
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it('(f) after fixtureBackupGuest resolves, the tab shows the new row', async () => {
    const { fixtureBackupGuest } = await import('@/api/actionsFixture');
    const { fixtureClient } = await import('@/api/fixtures');

    const node = 'pve1';
    const storage = 'backup-tab-fixture-test';
    const vmid = 987654;

    await fixtureBackupGuest(node, 'qemu', vmid, {
      storage,
      mode: 'snapshot',
      compress: 'zstd',
      protected: false,
      notes: 'fixture test',
      prune: false,
    });

    // `api` (mocked above to override only `getStorageContent`) still delegates every other
    // method, `getStorageContent` included, straight to the real fixture client for this describe
    // block's own assertion -- reassign the mock to the real implementation for this one test.
    mockGetStorageContent.mockImplementation((...args: Parameters<typeof fixtureClient.getStorageContent>) =>
      fixtureClient.getStorageContent(...args),
    );
    stubFetch();
    mockUseAuthMe.mockReturnValue(authData('session'));
    mockUsePermissions.mockReturnValue(permissionsData(true));

    renderTab({
      vmid,
      guestResource: { id: `qemu/${vmid}`, type: 'qemu', node, vmid, name: 'fixture-guest', status: 'stopped' },
      storageResource: { id: `storage/${node}/${storage}`, type: 'storage', node, storage, status: 'available', content: 'backup' },
    });

    const expectedPrefix = `${storage}:backup/vzdump-qemu-${vmid}-`;
    await screen.findByText((content) => content.startsWith(expectedPrefix));
  });
});
