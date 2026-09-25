import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { QueryClientProvider } from '@tanstack/react-query';

import { SnapshotsTab } from '@/pages/vm/tabs/SnapshotsTab';
import { createQueryClient } from '@/api/queryClient';
import type { AuthIdentity } from '@/api/client-types';
import type { GuestPermissions } from '@/api/actionHooks';
import type { Snapshot, ClusterResource } from '@/api/types';

/**
 * `SnapshotsTab` calls `useAuthMe`/`useSnapshots`/`useVmStatus` (from `@/api/hooks`) and
 * `usePermissions` (from `@/api/actionHooks`) -- all four mocked here so each test controls the
 * session/permission gate and the snapshot data directly, without a real network request. Same
 * convention as `object-header-actions.render.test.tsx`.
 */
const mockUseAuthMe = vi.fn();
const mockUseSnapshots = vi.fn();
const mockUseVmStatus = vi.fn();
const mockUsePermissions = vi.fn();

// `USE_FIXTURES` is true by default in this test env (`.env.test`), which would short-circuit
// the session-mode gate to "always enabled" before the mocked `useAuthMe` below ever mattered.
vi.mock('@/api/client', async () => {
  const actual = await vi.importActual<typeof import('@/api/client')>('@/api/client');
  return { ...actual, USE_FIXTURES: false };
});

vi.mock('@/api/hooks', async () => {
  const actual = await vi.importActual<typeof import('@/api/hooks')>('@/api/hooks');
  return {
    ...actual,
    useAuthMe: () => mockUseAuthMe(),
    useSnapshots: () => mockUseSnapshots(),
    useVmStatus: () => mockUseVmStatus(),
  };
});

vi.mock('@/api/actionHooks', async () => {
  const actual = await vi.importActual<typeof import('@/api/actionHooks')>('@/api/actionHooks');
  return { ...actual, usePermissions: (vmid: number) => mockUsePermissions(vmid) };
});

function authData(mode: AuthIdentity['mode']) {
  return { data: { username: 'root@pam', realm: 'pam', capabilities: {}, mode } };
}

function permissionsData(privs: Record<string, boolean>) {
  const value: GuestPermissions = { can: (p: string) => privs[p] === true };
  return { data: value };
}

const SNAPSHOTS: Snapshot[] = [
  { name: 'current' },
  { name: 'pre-upgrade', description: 'before the upgrade', snaptime: 1700000000 },
];

function renderTab() {
  mockUseSnapshots.mockReturnValue({ data: SNAPSHOTS, isLoading: false, isError: false, error: null });
  mockUseVmStatus.mockReturnValue({ data: { status: 'running', name: 'web-prod-01' } as Partial<ClusterResource> });

  const queryClient = createQueryClient();
  render(
    <QueryClientProvider client={queryClient}>
      <SnapshotsTab node="pve1" type="qemu" vmid={100} />
    </QueryClientProvider>,
  );
}

/** Radix's `DropdownMenu` trigger opens on `pointerdown`, not `click`; jsdom doesn't implement
 * the Pointer Events API it relies on, so a real click needs these no-op polyfills first, plus
 * firing pointerdown/pointerup ourselves -- same setup `rename-guest.render.test.tsx` and
 * `topbar-preferences-menu.render.test.tsx` use for their own `DropdownMenu`s. */
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

describe('SnapshotsTab gating', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('session + VM.Snapshot: "Take snapshot" is enabled, and a real row has an actions menu', async () => {
    mockUseAuthMe.mockReturnValue(authData('session'));
    mockUsePermissions.mockReturnValue(permissionsData({ 'VM.Snapshot': true, 'VM.Snapshot.Rollback': true }));

    renderTab();

    expect(await screen.findByRole('button', { name: 'Take snapshot' })).not.toBeDisabled();
    const menuButton = screen.getByRole('button', { name: 'Actions for pre-upgrade' });
    expect(menuButton).not.toBeDisabled();

    openRowMenu(menuButton);
    expect(await screen.findByRole('menuitem', { name: /Roll back/ })).not.toHaveAttribute('aria-disabled', 'true');
    expect(screen.getByRole('menuitem', { name: /Delete/ })).not.toHaveAttribute('aria-disabled', 'true');
  });

  it('token mode: "Take snapshot" is disabled', async () => {
    mockUseAuthMe.mockReturnValue(authData('token'));
    mockUsePermissions.mockReturnValue(permissionsData({ 'VM.Snapshot': true, 'VM.Snapshot.Rollback': true }));

    renderTab();

    const button = await screen.findByRole('button', { name: 'Take snapshot' });
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute('aria-disabled', 'true');
  });

  it('session but missing VM.Snapshot: "Take snapshot" and row Delete are disabled', async () => {
    mockUseAuthMe.mockReturnValue(authData('session'));
    mockUsePermissions.mockReturnValue(permissionsData({ 'VM.Snapshot.Rollback': true }));

    renderTab();

    expect(await screen.findByRole('button', { name: 'Take snapshot' })).toBeDisabled();
    openRowMenu(screen.getByRole('button', { name: 'Actions for pre-upgrade' }));
    expect(await screen.findByRole('menuitem', { name: /Delete/ })).toHaveAttribute('aria-disabled', 'true');
    // VM.Snapshot.Rollback is a different privilege and stays enabled.
    expect(screen.getByRole('menuitem', { name: /Roll back/ })).not.toHaveAttribute('aria-disabled', 'true');
  });

  it('the "NOW" sentinel row has no actions menu', async () => {
    mockUseAuthMe.mockReturnValue(authData('session'));
    mockUsePermissions.mockReturnValue(permissionsData({ 'VM.Snapshot': true, 'VM.Snapshot.Rollback': true }));

    renderTab();

    await screen.findByRole('button', { name: 'Actions for pre-upgrade' });
    expect(screen.queryByRole('button', { name: 'Actions for NOW' })).not.toBeInTheDocument();
  });
});
