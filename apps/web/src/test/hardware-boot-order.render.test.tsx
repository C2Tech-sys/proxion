import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClientProvider } from '@tanstack/react-query';

import { HardwareTab } from '@/pages/vm/tabs/HardwareTab';
import { createQueryClient } from '@/api/queryClient';
import { patchFixtureGuestConfig } from '@/api/fixtures';
import { parseGuestBootOrder } from '@/lib/pve-config';
import type { AuthIdentity } from '@/api/client-types';
import type { GuestPermissions } from '@/api/actionHooks';

/**
 * The Hardware tab's boot order editor (T51): the Boot Order row's chips and pencil (gated on
 * session mode + `VM.Config.Options`), the dialog's candidate list / enable checkboxes / Up-Down
 * buttons, and the exact order handed to `setBootOrder`. `useAuthMe`/`usePermissions` are mocked so
 * each test controls the gate; the guest config comes from the real fixture client (guest 100 boots
 * `order=scsi0;net0` and also has scsi1, ide2, net1 and a cloud-init drive on ide3), and
 * `@/api/bootOrder`'s network function is mocked so the request can be asserted. The fixture-mode
 * test flips `USE_FIXTURES` on and uses the real fixture flow instead.
 */
const mockUseAuthMe = vi.fn();
const mockUsePermissions = vi.fn();
const mockSetBootOrder = vi.fn();

const state = vi.hoisted(() => ({
  fixtures: false,
  actual: undefined as typeof import('@/api/bootOrder') | undefined,
}));

// `USE_FIXTURES` is true by default in this test env; a getter so one test can flip it.
vi.mock('@/api/client', async () => {
  const actual = await vi.importActual<typeof import('@/api/client')>('@/api/client');
  return {
    ...actual,
    get USE_FIXTURES() {
      return state.fixtures;
    },
  };
});

vi.mock('@/api/hooks', async () => {
  const actual = await vi.importActual<typeof import('@/api/hooks')>('@/api/hooks');
  return { ...actual, useAuthMe: () => mockUseAuthMe() };
});

vi.mock('@/api/actionHooks', async () => {
  const actual = await vi.importActual<typeof import('@/api/actionHooks')>('@/api/actionHooks');
  return { ...actual, usePermissions: (vmid: number) => mockUsePermissions(vmid) };
});

vi.mock('@/api/hardware', async () => {
  const actual = await vi.importActual<typeof import('@/api/hardware')>('@/api/hardware');
  return { ...actual, getPendingConfig: () => Promise.resolve([]) };
});

vi.mock('@/api/bootOrder', async () => {
  const actual = await vi.importActual<typeof import('@/api/bootOrder')>('@/api/bootOrder');
  state.actual = actual;
  return { ...actual, setBootOrder: (...args: unknown[]) => mockSetBootOrder(...args) };
});

function authData(mode: AuthIdentity['mode']) {
  return { data: { username: 'root@pam', realm: 'pam', capabilities: {}, mode } };
}

function permissionsData(privs: Record<string, boolean> | true) {
  const value: GuestPermissions = { can: (p: string) => privs === true || privs[p] === true };
  return { data: value };
}

function renderTab(guest: { node: string; type: 'qemu' | 'lxc'; vmid: number } = { node: 'pve1', type: 'qemu', vmid: 100 }) {
  const queryClient = createQueryClient();
  render(
    <QueryClientProvider client={queryClient}>
      <HardwareTab node={guest.node} type={guest.type} vmid={guest.vmid} />
    </QueryClientProvider>,
  );
}

async function openDialog() {
  fireEvent.click(await screen.findByRole('button', { name: 'Edit boot order' }));
  return screen.findByRole('dialog');
}

function candidateLabels(dialog: HTMLElement): string[] {
  return within(dialog)
    .getAllByTestId('boot-candidate')
    .map((li) => li.textContent ?? '');
}

function chipTexts(): string[] {
  return within(screen.getByTestId('boot-order-chips'))
    .getAllByRole('listitem')
    .map((li) => li.textContent ?? '');
}

describe('Hardware tab boot order editor', () => {
  beforeEach(() => {
    state.fixtures = false;
    mockUseAuthMe.mockReturnValue(authData('session'));
    mockUsePermissions.mockReturnValue(permissionsData(true));
    mockSetBootOrder.mockResolvedValue({ ok: true, pending: [] });
  });

  afterEach(() => {
    state.fixtures = false;
    patchFixtureGuestConfig('pve1', 'qemu', 100, { boot: 'order=scsi0;net0', bootdisk: undefined });
    vi.clearAllMocks();
  });

  it('(a) the row shows the current order as chips', async () => {
    renderTab();
    await screen.findByText('Boot Order');
    expect(chipTexts()).toEqual(['1. scsi0', '2. net0']);
  });

  it('(a) token mode: the pencil is disabled with the read-only tooltip', async () => {
    mockUseAuthMe.mockReturnValue(authData('token'));

    renderTab();
    const pencil = await screen.findByRole('button', { name: 'Edit boot order' });
    expect(pencil).toBeDisabled();
    expect(pencil).toHaveAttribute('title', 'Read-only: signed in with a service token');
  });

  it('(a2) without VM.Config.Options the pencil is disabled with the privilege tooltip', async () => {
    mockUsePermissions.mockReturnValue(permissionsData({ 'VM.Config.CPU': true, 'VM.Config.Memory': true }));

    renderTab();
    const pencil = await screen.findByRole('button', { name: 'Edit boot order' });
    expect(pencil).toBeDisabled();
    expect(pencil).toHaveAttribute('title', "You don't have VM.Config.Options on this guest");

    mockUsePermissions.mockReturnValue(permissionsData({ 'VM.Config.Options': true }));
  });

  it('(b) lists the guest candidates with the current order enabled first, and saves a reorder', async () => {
    renderTab();
    const dialog = await openDialog();

    // Enabled devices first (current order), then the rest; the cloud-init drive (ide3) is not bootable.
    expect(candidateLabels(dialog)).toEqual([
      'scsi0 — tank:vm-100-disk-0 (32G)',
      'net0 — virtio, vmbr0',
      'ide2 — CD/DVD: local:iso/debian-12.7.0-amd64-netinst.iso',
      'scsi1 — tank:vm-100-disk-4 (16G)',
      'net1 — virtio, vmbr0',
    ]);
    const checked = within(dialog)
      .getAllByRole('checkbox')
      .map((c) => c.getAttribute('aria-checked'));
    expect(checked).toEqual(['true', 'true', 'false', 'false', 'false']);

    // Only enabled devices can move, and not past the ends of the enabled block.
    expect(within(dialog).getByRole('button', { name: 'Move scsi0 up' })).toBeDisabled();
    expect(within(dialog).getByRole('button', { name: 'Move net0 down' })).toBeDisabled();
    expect(within(dialog).getByRole('button', { name: 'Move ide2 up' })).toBeDisabled();
    expect(within(dialog).getByRole('button', { name: 'Save' })).toBeDisabled();

    // Enable ide2 (joins the end of the enabled block), then move it to the top.
    fireEvent.click(within(dialog).getByRole('checkbox', { name: /^ide2/ }));
    expect(candidateLabels(dialog).slice(0, 3).map((l) => l.split(' ')[0])).toEqual(['scsi0', 'net0', 'ide2']);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Move ide2 up' }));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Move ide2 up' }));
    expect(candidateLabels(dialog).slice(0, 3).map((l) => l.split(' ')[0])).toEqual(['ide2', 'scsi0', 'net0']);

    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(mockSetBootOrder).toHaveBeenCalledWith('pve1', 'qemu', 100, ['ide2', 'scsi0', 'net0']),
    );
    expect(mockSetBootOrder).toHaveBeenCalledTimes(1);
  });

  it('(b2) move down reorders, and disabling a device drops it below the enabled ones', async () => {
    renderTab();
    const dialog = await openDialog();

    fireEvent.click(within(dialog).getByRole('button', { name: 'Move scsi0 down' }));
    expect(candidateLabels(dialog).slice(0, 2).map((l) => l.split(' ')[0])).toEqual(['net0', 'scsi0']);

    fireEvent.click(within(dialog).getByRole('checkbox', { name: /^net0/ }));
    expect(candidateLabels(dialog).slice(0, 2).map((l) => l.split(' ')[0])).toEqual(['scsi0', 'net0']);

    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(mockSetBootOrder).toHaveBeenCalledWith('pve1', 'qemu', 100, ['scsi0']));
  });

  it('(c) disabling every device saves an empty order', async () => {
    renderTab();
    const dialog = await openDialog();

    fireEvent.click(within(dialog).getByRole('checkbox', { name: /^scsi0/ }));
    fireEvent.click(within(dialog).getByRole('checkbox', { name: /^net0/ }));
    expect(within(dialog).getByText(/No device ticked/)).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(mockSetBootOrder).toHaveBeenCalledWith('pve1', 'qemu', 100, []));
  });

  it('(c2) a server error stays inline and the dialog stays open', async () => {
    const { GuestActionError } = await import('@/api/actions');
    mockSetBootOrder.mockRejectedValue(new GuestActionError(400, 'boot: invalid boot order'));

    renderTab();
    const dialog = await openDialog();
    fireEvent.click(within(dialog).getByRole('checkbox', { name: /^ide2/ }));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));

    expect(await within(dialog).findByRole('alert')).toHaveTextContent('boot: invalid boot order');
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });

  it('(d) the legacy boot: cdn + bootdisk form parses to scsi0, ide2, net0', async () => {
    const config = { boot: 'cdn', bootdisk: 'scsi0', ide2: 'local:iso/a.iso,media=cdrom', net0: 'virtio=AA,bridge=vmbr0' };
    expect(parseGuestBootOrder(config)).toEqual({ order: ['scsi0', 'ide2', 'net0'], legacy: true });

    patchFixtureGuestConfig('pve1', 'qemu', 100, { boot: 'cdn', bootdisk: 'scsi0' });
    renderTab();
    await screen.findByText('Boot Order');
    expect(chipTexts()).toEqual(['1. scsi0', '2. ide2', '3. net0', '(legacy)']);

    // Saving is allowed even without reordering: it rewrites the legacy form as order=.
    const dialog = await openDialog();
    expect(within(dialog).getByText(/legacy boot setting/)).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(mockSetBootOrder).toHaveBeenCalledWith('pve1', 'qemu', 100, ['scsi0', 'ide2', 'net0']),
    );
  });

  it('(e) fixture mode: after saving, the row shows the new order', async () => {
    state.fixtures = true;
    mockSetBootOrder.mockImplementation(state.actual!.setBootOrder);

    renderTab();
    await screen.findByText('Boot Order');
    expect(chipTexts()).toEqual(['1. scsi0', '2. net0']);

    const dialog = await openDialog();
    fireEvent.click(within(dialog).getByRole('checkbox', { name: /^ide2/ }));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Move ide2 up' }));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Move ide2 up' }));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(chipTexts()).toEqual(['1. ide2', '2. scsi0', '3. net0']));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });

  it('(e2) fixture mode: clearing every device shows "No boot device"', async () => {
    state.fixtures = true;
    mockSetBootOrder.mockImplementation(state.actual!.setBootOrder);

    renderTab();
    const dialog = await openDialog();
    fireEvent.click(within(dialog).getByRole('checkbox', { name: /^scsi0/ }));
    fireEvent.click(within(dialog).getByRole('checkbox', { name: /^net0/ }));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));

    expect(await screen.findByText('No boot device')).toBeInTheDocument();
  });

  it('(f) an lxc guest has no boot order row or editor', async () => {
    renderTab({ node: 'pve2', type: 'lxc', vmid: 200 });
    await screen.findByText('Memory');
    expect(screen.queryByText('Boot Order')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Edit boot order' })).not.toBeInTheDocument();
  });
});
