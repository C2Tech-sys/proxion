import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClientProvider } from '@tanstack/react-query';

import { NodePowerMenu } from '@/components/actions/NodePowerMenu';
import { Toaster } from '@/components/ui/sonner';
import { createQueryClient } from '@/api/queryClient';
import type { AuthIdentity } from '@/api/client-types';
import type { GuestPermissions } from '@/api/actionHooks';
import type { ClusterResource } from '@/api/types';

/**
 * `NodePowerMenu`/`NodeActionDialog` gating and confirm flow (same mocking shape
 * `object-header-actions.render.test.tsx`/`migrate-guest.render.test.tsx` use for their own
 * quick-action dialogs): `useAuthMe`/`useNodePermissions` control the session/privilege gate,
 * `useClusterResources` supplies the running-guest list the dialog reads, and `nodeAction` is
 * mocked so a confirm's exact request is asserted directly without a real network layer.
 */
const mockUseAuthMe = vi.fn();
const mockUseNodePermissions = vi.fn();
const mockUseClusterResources = vi.fn();
const mockNodeAction = vi.fn();

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
  return { ...actual, useNodePermissions: (node: string) => mockUseNodePermissions(node) };
});

vi.mock('@/api/actions', async () => {
  const actual = await vi.importActual<typeof import('@/api/actions')>('@/api/actions');
  return { ...actual, nodeAction: (...args: unknown[]) => mockNodeAction(...args) };
});

function authData(mode: AuthIdentity['mode']) {
  return { data: { username: 'root@pam', realm: 'pam', capabilities: {}, mode } };
}

function permissionsData(can: boolean) {
  const value: GuestPermissions = { can: () => can };
  return { data: value };
}

/** Two running guests on `pve1` (one qemu, one lxc), one running guest on another node (excluded),
 * and one stopped guest on `pve1` (excluded) -- enough to exercise the dialog's own filter
 * (`type qemu|lxc && status === 'running' && node === name`). */
const CLUSTER_RESOURCES: ClusterResource[] = [
  { id: 'qemu/100', type: 'qemu', node: 'pve1', status: 'running', vmid: 100, name: 'web-01' },
  { id: 'lxc/200', type: 'lxc', node: 'pve1', status: 'running', vmid: 200, name: 'db-01' },
  { id: 'qemu/101', type: 'qemu', node: 'pve2', status: 'running', vmid: 101, name: 'other-node' },
  { id: 'qemu/102', type: 'qemu', node: 'pve1', status: 'stopped', vmid: 102, name: 'stopped-guest' },
];

function renderMenu(node = 'pve1') {
  const queryClient = createQueryClient();
  render(
    <QueryClientProvider client={queryClient}>
      <NodePowerMenu node={node} />
      <Toaster />
    </QueryClientProvider>,
  );
}

function openPowerMenu(trigger: HTMLElement) {
  // Radix's DropdownMenu trigger opens on `pointerdown`, not `click` -- same polyfill/sequence
  // `migrate-guest.render.test.tsx`/`rename-guest.render.test.tsx` use for their own triggers.
  fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false, pointerType: 'mouse' });
  fireEvent.pointerUp(trigger, { button: 0, ctrlKey: false, pointerType: 'mouse' });
  fireEvent.click(trigger);
}

describe('NodePowerMenu / NodeActionDialog', () => {
  beforeEach(() => {
    // jsdom doesn't implement the Pointer Events API Radix's DropdownMenu relies on -- same
    // minimal no-op polyfills the other action-dialog render tests set up.
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
    mockUseClusterResources.mockReturnValue({ data: CLUSTER_RESOURCES });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('session + Sys.PowerMgmt: Power menu enabled; Reboot… shows the running guests; confirm is gated on the typed node name; confirming calls nodeAction and toasts', async () => {
    mockUseAuthMe.mockReturnValue(authData('session'));
    mockUseNodePermissions.mockReturnValue(permissionsData(true));
    mockNodeAction.mockResolvedValue({ ok: true });

    renderMenu();

    const trigger = await screen.findByRole('button', { name: 'Power' });
    expect(trigger).not.toBeDisabled();
    openPowerMenu(trigger);

    fireEvent.click(await screen.findByRole('menuitem', { name: /Reboot/ }));
    const dialog = await screen.findByRole('alertdialog');

    expect(within(dialog).getByText('Reboot pve1?')).toBeInTheDocument();
    expect(within(dialog).getByText('2 running guests on this node will be affected')).toBeInTheDocument();
    expect(within(dialog).getByText('web-01')).toBeInTheDocument();
    expect(within(dialog).getByText('db-01')).toBeInTheDocument();
    expect(within(dialog).queryByText('other-node')).not.toBeInTheDocument();
    expect(within(dialog).queryByText('stopped-guest')).not.toBeInTheDocument();

    const confirmButton = within(dialog).getByRole('button', { name: 'Reboot node' });
    expect(confirmButton).toBeDisabled();

    const input = within(dialog).getByLabelText('Type the node name to confirm');
    fireEvent.change(input, { target: { value: 'wrong' } });
    expect(confirmButton).toBeDisabled();

    fireEvent.change(input, { target: { value: 'pve1' } });
    expect(confirmButton).not.toBeDisabled();

    fireEvent.click(confirmButton);

    await waitFor(() => expect(mockNodeAction).toHaveBeenCalledWith('pve1', 'reboot'));
    expect(await screen.findByText('Reboot requested for pve1')).toBeInTheDocument();
  });

  it('no running guests: shows the empty-impact line', async () => {
    mockUseAuthMe.mockReturnValue(authData('session'));
    mockUseNodePermissions.mockReturnValue(permissionsData(true));
    mockUseClusterResources.mockReturnValue({ data: [] });

    renderMenu();
    openPowerMenu(await screen.findByRole('button', { name: 'Power' }));
    fireEvent.click(await screen.findByRole('menuitem', { name: /Reboot/ }));
    const dialog = await screen.findByRole('alertdialog');

    expect(within(dialog).getByText('No running guests on this node')).toBeInTheDocument();
  });

  it('token mode: the Power button is disabled with the read-only tooltip text', async () => {
    mockUseAuthMe.mockReturnValue(authData('token'));
    mockUseNodePermissions.mockReturnValue(permissionsData(true));

    renderMenu();

    const trigger = await screen.findByRole('button', { name: 'Power' });
    expect(trigger).toBeDisabled();
    expect(trigger).toHaveAttribute('title', 'Read-only: signed in with a service token');
  });

  it("missing Sys.PowerMgmt: the Power button is disabled with the missing-privilege tooltip text", async () => {
    mockUseAuthMe.mockReturnValue(authData('session'));
    mockUseNodePermissions.mockReturnValue(permissionsData(false));

    renderMenu();

    const trigger = await screen.findByRole('button', { name: 'Power' });
    expect(trigger).toBeDisabled();
    expect(trigger).toHaveAttribute('title', "You don't have Sys.PowerMgmt on this node");
  });

  it('Shut down… sends the shutdown command and toasts the shutdown message', async () => {
    mockUseAuthMe.mockReturnValue(authData('session'));
    mockUseNodePermissions.mockReturnValue(permissionsData(true));
    mockNodeAction.mockResolvedValue({ ok: true });

    renderMenu();

    openPowerMenu(await screen.findByRole('button', { name: 'Power' }));
    fireEvent.click(await screen.findByRole('menuitem', { name: /Shut down/ }));
    const dialog = await screen.findByRole('alertdialog');

    expect(within(dialog).getByText('Shut down pve1?')).toBeInTheDocument();

    const input = within(dialog).getByLabelText('Type the node name to confirm');
    fireEvent.change(input, { target: { value: 'pve1' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Shut down node' }));

    await waitFor(() => expect(mockNodeAction).toHaveBeenCalledWith('pve1', 'shutdown'));
    expect(await screen.findByText('Shutdown requested for pve1')).toBeInTheDocument();
  });
});
