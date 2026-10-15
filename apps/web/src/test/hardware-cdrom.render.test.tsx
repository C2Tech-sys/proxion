import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClientProvider } from '@tanstack/react-query';

import { HardwareTab } from '@/pages/vm/tabs/HardwareTab';
import { CDROM_SLOT_ORDER } from '@/api/disks';
import { createQueryClient } from '@/api/queryClient';
import { GuestActionError } from '@/api/actions';
import { getFixtureGuestConfig, patchFixtureGuestConfig } from '@/api/fixtures';
import type { AuthIdentity } from '@/api/client-types';
import type { GuestPermissions } from '@/api/actionHooks';
import type { ClusterResource, GuestConfig } from '@/api/types';

/**
 * The Hardware tab's CD/DVD drive lifecycle (T75): "Add CD/DVD drive" next to the Disks header and
 * a "Remove" trash on every CD/DVD row. Same harness as `hardware-disks.render.test.tsx`:
 * `useAuthMe`, `useClusterResources` and `usePermissions` are mocked so each test controls the
 * gate and the storages; `updateHardware` (the existing hardware patch, which also adds a drive)
 * and `removeCdrom` are mocked so the exact request each dialog builds can be asserted; the guest
 * config and the ISO lists come from the real fixture client. The round-trip tests flip
 * `USE_FIXTURES` on and run the real fixture mutators instead.
 *
 * Guest 100 (qemu) holds scsi0, scsi1, a CD-ROM on ide2 and the cloud-init drive on ide3, so the
 * first free slot is ide0. Guest 200 is a container.
 */
const mockUseAuthMe = vi.fn();
const mockUseClusterResources = vi.fn();
const mockUsePermissions = vi.fn();
const mockGetPendingConfig = vi.fn();
const mockUpdateHardware = vi.fn();
const mockRemoveCdrom = vi.fn();

const state = vi.hoisted(() => ({
  fixtures: false,
  hardware: undefined as typeof import('@/api/hardware') | undefined,
  disks: undefined as typeof import('@/api/disks') | undefined,
}));

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

vi.mock('@/api/hardware', async () => {
  const actual = await vi.importActual<typeof import('@/api/hardware')>('@/api/hardware');
  state.hardware = actual;
  return {
    ...actual,
    updateHardware: (...args: unknown[]) => mockUpdateHardware(...args),
    getPendingConfig: (...args: unknown[]) => mockGetPendingConfig(...args),
  };
});

vi.mock('@/api/disks', async () => {
  const actual = await vi.importActual<typeof import('@/api/disks')>('@/api/disks');
  state.disks = actual;
  return { ...actual, removeCdrom: (...args: unknown[]) => mockRemoveCdrom(...args) };
});

function authData(mode: AuthIdentity['mode']) {
  return { data: { username: 'root@pam', realm: 'pam', capabilities: {}, mode } };
}

function permissionsData(privs: Record<string, boolean> | true) {
  const value: GuestPermissions = { can: (p: string) => privs === true || privs[p] === true };
  return { data: value };
}

const STORAGES: ClusterResource[] = [
  {
    id: 'storage/pve1/local',
    type: 'storage',
    node: 'pve1',
    status: 'available',
    storage: 'local',
    plugintype: 'dir',
    content: 'iso,vztmpl,backup,images,rootdir',
  },
  { id: 'storage/pve1/tank', type: 'storage', node: 'pve1', status: 'available', storage: 'tank', content: 'images,rootdir' },
];

const QEMU = { node: 'pve1', type: 'qemu', vmid: 100 } as const;
const LXC = { node: 'pve2', type: 'lxc', vmid: 200 } as const;

function renderTab(guest: { node: string; type: 'qemu' | 'lxc'; vmid: number } = QEMU) {
  const queryClient = createQueryClient();
  render(
    <QueryClientProvider client={queryClient}>
      <HardwareTab node={guest.node} type={guest.type} vmid={guest.vmid} />
    </QueryClientProvider>,
  );
}

async function openDialog(buttonName: string, role: 'dialog' | 'alertdialog' = 'dialog') {
  fireEvent.click(await screen.findByRole('button', { name: buttonName }));
  return screen.findByRole(role);
}

/** The fixture configs are shared module state; put a guest's config back exactly as it was. */
function restoreConfig(vmid: number, snapshot: GuestConfig | undefined) {
  if (!snapshot) return;
  const patch: Record<string, string | number | undefined> = {};
  for (const key of Object.keys(getFixtureGuestConfig(vmid) ?? {})) {
    if (!(key in snapshot)) patch[key] = undefined;
  }
  for (const [key, value] of Object.entries(snapshot)) patch[key] = value as string | number;
  patchFixtureGuestConfig('', 'qemu', vmid, patch);
}

const ISO = 'local:iso/virtio-win-0.1.240.iso';

describe('Hardware tab CD/DVD drive lifecycle', () => {
  let snapshot100: GuestConfig | undefined;

  beforeEach(() => {
    snapshot100 = getFixtureGuestConfig(100);
    state.fixtures = false;
    mockUseAuthMe.mockReturnValue(authData('session'));
    mockUsePermissions.mockReturnValue(permissionsData(true));
    mockUseClusterResources.mockReturnValue({ data: STORAGES, isLoading: false });
    mockGetPendingConfig.mockResolvedValue([]);
    mockUpdateHardware.mockResolvedValue({ ok: true, changed: ['ide0'], pending: [] });
    mockRemoveCdrom.mockResolvedValue({ ok: true, removed: 'ide2', pending: [] });
  });

  afterEach(() => {
    cleanup();
    state.fixtures = false;
    restoreConfig(100, snapshot100);
    vi.clearAllMocks();
  });

  it('(a) the add action renders for a qemu guest and not for a container', async () => {
    renderTab();
    expect(await screen.findByRole('button', { name: 'Add CD/DVD drive' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Remove CD/DVD drive ide2' })).toBeEnabled();
    cleanup();

    renderTab(LXC);
    await screen.findByText('Memory');
    expect(screen.getByRole('button', { name: 'Add mount point' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Add CD/DVD drive' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Remove CD\/DVD drive/ })).not.toBeInTheDocument();
  });

  it('(b) the slot picker defaults to the first free slot and omits the taken ones', async () => {
    renderTab();
    const dialog = await openDialog('Add CD/DVD drive');

    const slot = within(dialog).getByLabelText('Bus/Slot');
    expect(slot).toHaveValue('ide0');
    const values = within(slot).getAllByRole('option').map((o) => o.getAttribute('value'));
    // ide2 (CD-ROM), ide3 (cloud-init), scsi0 and scsi1 (disks) are taken.
    expect(values).toStrictEqual([
      'ide0',
      'ide1',
      ...Array.from({ length: 6 }, (_, n) => `sata${n}`),
      ...Array.from({ length: 29 }, (_, n) => `scsi${n + 2}`),
    ]);
    expect(within(slot).getByRole('option', { name: 'IDE 0 (ide0)' })).toBeInTheDocument();
    expect(within(slot).getByRole('option', { name: 'SATA 3 (sata3)' })).toBeInTheDocument();
    expect(within(dialog).getByText(/a running VM sees it after a restart \(PVE shows it as pending\)/)).toBeInTheDocument();
    // The ISO picker is the same one the edit dialog uses.
    await within(dialog).findByRole('option', { name: /virtio-win-0\.1\.240\.iso/ });
  });

  it('(c) with every slot taken the dialog says so and Add is disabled', async () => {
    const taken: Record<string, string> = {};
    for (const slot of CDROM_SLOT_ORDER) taken[slot] = `tank:vm-100-disk-${slot},size=1G`;
    patchFixtureGuestConfig('pve1', 'qemu', 100, taken);

    renderTab();
    const dialog = await openDialog('Add CD/DVD drive');
    expect(within(dialog).getByTestId('cdrom-no-free-slot')).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: 'Add' })).toBeDisabled();
    expect(within(dialog).getByLabelText('Bus/Slot')).toBeDisabled();
  });

  it('(d) adding with "No media" sends exactly { cdrom: { slot: ide0, iso: null } }', async () => {
    renderTab();
    const dialog = await openDialog('Add CD/DVD drive');
    expect(within(dialog).getByLabelText('Media')).toHaveValue('');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Add' }));

    await waitFor(() => expect(mockUpdateHardware).toHaveBeenCalledTimes(1));
    expect(mockUpdateHardware.mock.calls[0]).toStrictEqual(['pve1', 'qemu', 100, { cdrom: { slot: 'ide0', iso: null } }]);
    // The dialog closes on success.
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });

  it('(e) adding with an ISO on a chosen slot sends exactly that slot and volid', async () => {
    renderTab();
    const dialog = await openDialog('Add CD/DVD drive');
    await within(dialog).findByRole('option', { name: /virtio-win-0\.1\.240\.iso/ });

    fireEvent.change(within(dialog).getByLabelText('Bus/Slot'), { target: { value: 'sata1' } });
    fireEvent.change(within(dialog).getByLabelText('Media'), { target: { value: ISO } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Add' }));

    await waitFor(() => expect(mockUpdateHardware).toHaveBeenCalledTimes(1));
    expect(mockUpdateHardware.mock.calls[0]).toStrictEqual(['pve1', 'qemu', 100, { cdrom: { slot: 'sata1', iso: ISO } }]);
  });

  it('(f) a rejected add keeps the dialog open and shows the server message', async () => {
    mockUpdateHardware.mockRejectedValue(new GuestActionError(400, 'ide0 already holds a disk'));
    renderTab();
    const dialog = await openDialog('Add CD/DVD drive');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Add' }));

    expect(await within(dialog).findByRole('alert')).toHaveTextContent('ide0 already holds a disk');
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });

  it('(g) fixture round trip: the added drive appears as a new row with its ISO', async () => {
    state.fixtures = true;
    mockUpdateHardware.mockImplementation(state.hardware!.updateHardware);
    mockGetPendingConfig.mockImplementation(state.hardware!.getPendingConfig);

    renderTab();
    expect(await screen.findByText('CD/DVD Drive (ide2)')).toBeInTheDocument();
    expect(screen.queryByText('CD/DVD Drive (ide0)')).not.toBeInTheDocument();

    const dialog = await openDialog('Add CD/DVD drive');
    await within(dialog).findByRole('option', { name: /virtio-win-0\.1\.240\.iso/ });
    fireEvent.change(within(dialog).getByLabelText('Media'), { target: { value: ISO } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Add' }));

    const row = (await screen.findByText('CD/DVD Drive (ide0)')).closest('tr')!;
    expect(within(row).getByTestId('volume-id')).toHaveTextContent(ISO);
    expect(getFixtureGuestConfig(100)?.ide0).toBe(`${ISO},media=cdrom`);
    // The new drive is removable straight away, and the slot is no longer offered.
    expect(within(row).getByRole('button', { name: 'Remove CD/DVD drive ide0' })).toBeEnabled();
    const again = await openDialog('Add CD/DVD drive');
    expect(within(again).getByLabelText('Bus/Slot')).toHaveValue('ide1');
  });

  it('(h) remove asks for confirmation and sends exactly slot ide2', async () => {
    renderTab();
    const dialog = await openDialog('Remove CD/DVD drive ide2', 'alertdialog');
    expect(within(dialog).getByText('Remove CD/DVD drive ide2?')).toBeInTheDocument();
    expect(
      within(dialog).getByText('The ISO file stays on its storage; only the drive is removed from this VM.'),
    ).toBeInTheDocument();
    // Cancelling sends nothing.
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument());
    expect(mockRemoveCdrom).not.toHaveBeenCalled();

    const confirm = await openDialog('Remove CD/DVD drive ide2', 'alertdialog');
    fireEvent.click(within(confirm).getByRole('button', { name: 'Remove' }));
    await waitFor(() => expect(mockRemoveCdrom).toHaveBeenCalledTimes(1));
    expect(mockRemoveCdrom.mock.calls[0]).toStrictEqual(['pve1', 'qemu', 100, 'ide2']);
  });

  it('(i) fixture round trip: the removed drive disappears and nothing becomes an unused disk', async () => {
    state.fixtures = true;
    mockRemoveCdrom.mockImplementation(state.disks!.removeCdrom);

    renderTab();
    expect(await screen.findByText('CD/DVD Drive (ide2)')).toBeInTheDocument();
    const dialog = await openDialog('Remove CD/DVD drive ide2', 'alertdialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Remove' }));

    await waitFor(() => expect(screen.queryByText('CD/DVD Drive (ide2)')).not.toBeInTheDocument());
    const config = getFixtureGuestConfig(100) ?? {};
    expect(config).not.toHaveProperty('ide2');
    expect(Object.keys(config).filter((key) => key.startsWith('unused'))).toStrictEqual([]);
    // The cloud-init drive is untouched.
    expect(config.ide3).toBe('tank:vm-100-cloudinit,media=cdrom');
  });

  it('(j) the cloud-init drive has no remove (or edit) button', async () => {
    renderTab();
    const row = (await screen.findByText('CloudInit Drive')).closest('tr')!;
    expect(within(row).queryByRole('button')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Remove CD/DVD drive ide3' })).not.toBeInTheDocument();
  });

  it('(k) token mode: add and remove are disabled with the read-only tooltip', async () => {
    mockUseAuthMe.mockReturnValue(authData('token'));
    renderTab();
    await screen.findByText('Processors');

    for (const name of ['Add CD/DVD drive', 'Remove CD/DVD drive ide2']) {
      const button = screen.getByRole('button', { name });
      expect(button, name).toBeDisabled();
      expect(button, name).toHaveAttribute('title', 'Read-only: signed in with a service token');
    }
  });

  it('(l) both need VM.Config.CDROM (VM.Config.Disk alone is not enough)', async () => {
    mockUsePermissions.mockReturnValue(permissionsData({ 'VM.Config.Disk': true }));
    renderTab();
    await screen.findByText('Processors');

    for (const name of ['Add CD/DVD drive', 'Remove CD/DVD drive ide2']) {
      const button = screen.getByRole('button', { name });
      expect(button, name).toBeDisabled();
      expect(button, name).toHaveAttribute('title', "You don't have VM.Config.CDROM on this guest");
    }
    cleanup();

    mockUsePermissions.mockReturnValue(permissionsData({ 'VM.Config.CDROM': true }));
    renderTab();
    await screen.findByText('Processors');
    expect(screen.getByRole('button', { name: 'Add CD/DVD drive' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Remove CD/DVD drive ide2' })).toBeEnabled();
    // ...and the disk buttons stay gated on their own privilege.
    expect(screen.getByRole('button', { name: 'Add disk' })).toBeDisabled();
  });
});
