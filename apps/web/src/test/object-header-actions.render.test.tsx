import { afterEach, describe, expect, it, vi } from 'vitest';
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

import { ObjectHeader } from '@/components/ObjectHeader';
import { createQueryClient } from '@/api/queryClient';
import type { AuthIdentity } from '@/api/client-types';
import type { GuestPermissions } from '@/api/actionHooks';

/**
 * `ObjectHeader` renders a `Breadcrumbs` (needs router context) and calls `useAuthMe` /
 * `usePermissions` / `useGuestAction` (via `useGuestActionFlow`) -- `useAuthMe` and
 * `usePermissions` are mocked per test to control the session/permission gate; `useGuestAction`
 * is left real (it calls the mocked `guestAction` in `actions.test.ts`'s sibling module -- here
 * `@/api/actions` itself is mocked so the mutation resolves without a real request).
 */
const mockUseAuthMe = vi.fn();
const mockUsePermissions = vi.fn();
const mockGuestAction = vi.fn();

// `USE_FIXTURES` is true by default in this test env (`.env.test`), which would short-circuit
// the session-mode gate to "always enabled" (the demo carve-out -- see ObjectHeader.tsx) before
// the mocked `useAuthMe` below ever mattered. Forcing it `false` here exercises the real
// session/permission gate, same as `auth-gate.render.test.tsx`.
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

vi.mock('@/api/actions', async () => {
  const actual = await vi.importActual<typeof import('@/api/actions')>('@/api/actions');
  return {
    ...actual,
    guestAction: (...args: unknown[]) => mockGuestAction(...args),
  };
});

function authData(mode: AuthIdentity['mode']) {
  return { data: { username: 'root@pam', realm: 'pam', capabilities: {}, mode } };
}

function permissionsData(can: boolean) {
  const value: GuestPermissions = { can: () => can };
  return { data: value };
}

function renderHeader(status: 'running' | 'stopped' | 'paused') {
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

describe('ObjectHeader quick actions', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('session + VM.PowerMgmt: quick actions are enabled', async () => {
    mockUseAuthMe.mockReturnValue(authData('session'));
    mockUsePermissions.mockReturnValue(permissionsData(true));

    renderHeader('running');

    expect(await screen.findByRole('button', { name: 'Shut down' })).not.toBeDisabled();
    expect(screen.getByRole('button', { name: 'Reboot' })).not.toBeDisabled();
    expect(screen.getByRole('button', { name: 'Pause' })).not.toBeDisabled();
    expect(screen.getByRole('button', { name: 'More actions' })).not.toBeDisabled();
  });

  it('token mode: quick actions are disabled', async () => {
    mockUseAuthMe.mockReturnValue(authData('token'));
    mockUsePermissions.mockReturnValue(permissionsData(true));

    renderHeader('running');

    const shutdown = await screen.findByRole('button', { name: 'Shut down' });
    expect(shutdown).toBeDisabled();
    expect(shutdown).toHaveAttribute('aria-disabled', 'true');
    expect(screen.getByRole('button', { name: 'Reboot' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'More actions' })).toBeDisabled();
  });

  it('session but missing VM.PowerMgmt: quick actions are disabled', async () => {
    mockUseAuthMe.mockReturnValue(authData('session'));
    mockUsePermissions.mockReturnValue(permissionsData(false));

    renderHeader('running');

    expect(await screen.findByRole('button', { name: 'Shut down' })).toBeDisabled();
  });

  it('stopped guest: shows Start, not Shut down/Reboot', async () => {
    mockUseAuthMe.mockReturnValue(authData('session'));
    mockUsePermissions.mockReturnValue(permissionsData(true));

    renderHeader('stopped');

    expect(await screen.findByRole('button', { name: 'Start' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Shut down' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Reboot' })).not.toBeInTheDocument();
  });

  it('paused (qemu) guest: shows Resume instead of Pause', async () => {
    mockUseAuthMe.mockReturnValue(authData('session'));
    mockUsePermissions.mockReturnValue(permissionsData(true));

    renderHeader('paused');

    expect(await screen.findByRole('button', { name: 'Resume' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Pause' })).not.toBeInTheDocument();
  });
});

describe('ObjectHeader guest action dialog flow', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('confirming Shut down (no force-stop) calls guestAction with an empty body', async () => {
    mockUseAuthMe.mockReturnValue(authData('session'));
    mockUsePermissions.mockReturnValue(permissionsData(true));
    mockGuestAction.mockResolvedValue({ upid: 'UPID:pve1:test' });

    renderHeader('running');

    fireEvent.click(await screen.findByRole('button', { name: 'Shut down' }));
    const dialog = await screen.findByRole('alertdialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Shut down' }));

    await vi.waitFor(() => expect(mockGuestAction).toHaveBeenCalledTimes(1));
    expect(mockGuestAction).toHaveBeenCalledWith('pve1', 'qemu', 100, 'shutdown', undefined);
  });

  it('checking force-stop includes forceStop + the selected timeout in the body', async () => {
    mockUseAuthMe.mockReturnValue(authData('session'));
    mockUsePermissions.mockReturnValue(permissionsData(true));
    mockGuestAction.mockResolvedValue({ upid: 'UPID:pve1:test' });

    renderHeader('running');

    fireEvent.click(await screen.findByRole('button', { name: 'Shut down' }));
    const dialog = await screen.findByRole('alertdialog');
    fireEvent.click(within(dialog).getByRole('checkbox'));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Shut down' }));

    await vi.waitFor(() => expect(mockGuestAction).toHaveBeenCalledTimes(1));
    expect(mockGuestAction).toHaveBeenCalledWith('pve1', 'qemu', 100, 'shutdown', {
      forceStop: true,
      timeout: 120,
    });
  });

  it('cancel closes the dialog without calling guestAction', async () => {
    mockUseAuthMe.mockReturnValue(authData('session'));
    mockUsePermissions.mockReturnValue(permissionsData(true));

    renderHeader('running');

    fireEvent.click(await screen.findByRole('button', { name: 'Reboot' }));
    const dialog = await screen.findByRole('alertdialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));

    await vi.waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument());
    expect(mockGuestAction).not.toHaveBeenCalled();
  });
});
