import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClientProvider } from '@tanstack/react-query';

import { HardwareTab } from '@/pages/vm/tabs/HardwareTab';
import { createQueryClient } from '@/api/queryClient';
import {
  FIXTURE_QEMU_MACHINES,
  getFixtureGuestConfig,
  patchFixtureGuestConfig,
  resetFixtureFirmwarePending,
} from '@/api/fixtures';
import type { AuthIdentity } from '@/api/client-types';
import type { GuestPermissions } from '@/api/actionHooks';
import type { ClusterResource, GuestConfig } from '@/api/types';

/**
 * The Hardware tab's firmware rows (T72): BIOS, Machine, Display and SCSI Controller pencils plus
 * "Add EFI disk" / "Add TPM state" next to the Disks header. Same harness as
 * `hardware-disks.render.test.tsx`: `useAuthMe`, `useClusterResources`, `usePermissions` and
 * `useStoragePermissions` are mocked so each test controls the gate and the storages;
 * `@/api/firmware`'s network functions are mocked so the exact body each dialog builds can be
 * asserted; the guest config comes from the real fixture client. The last test flips
 * `USE_FIXTURES` on and runs the real fixture flow instead.
 *
 * Guest 100 has an OVMF BIOS, a pinned q35 machine, VirtIO SCSI single, an EFI disk and a TPM
 * state; guest 101 has none of the latter two.
 */
const mockUseAuthMe = vi.fn();
const mockUseClusterResources = vi.fn();
const mockUsePermissions = vi.fn();
const mockUseStoragePermissions = vi.fn();
const mockGetPendingConfig = vi.fn();
const mockUpdateFirmware = vi.fn();
const mockGetQemuMachines = vi.fn();

const state = vi.hoisted(() => ({
  fixtures: false,
  firmware: undefined as typeof import('@/api/firmware') | undefined,
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
  return {
    ...actual,
    usePermissions: (vmid: number) => mockUsePermissions(vmid),
    useStoragePermissions: (storage: string) => mockUseStoragePermissions(storage),
  };
});

vi.mock('@/api/hardware', async () => {
  const actual = await vi.importActual<typeof import('@/api/hardware')>('@/api/hardware');
  return { ...actual, getPendingConfig: (...args: unknown[]) => mockGetPendingConfig(...args) };
});

vi.mock('@/api/firmware', async () => {
  const actual = await vi.importActual<typeof import('@/api/firmware')>('@/api/firmware');
  state.firmware = actual;
  return {
    ...actual,
    updateFirmware: (...args: unknown[]) => mockUpdateFirmware(...args),
    getQemuMachines: (...args: unknown[]) => mockGetQemuMachines(...args),
  };
});

function authData(mode: AuthIdentity['mode']) {
  return { data: { username: 'root@pam', realm: 'pam', capabilities: {}, mode } };
}

function permissionsData(privs: Record<string, boolean> | true) {
  const value: GuestPermissions = { can: (p: string) => privs === true || privs[p] === true };
  return { data: value };
}

const GIB = 1024 ** 3;

const STORAGES: ClusterResource[] = [
  {
    id: 'storage/pve1/local-lvm',
    type: 'storage',
    node: 'pve1',
    status: 'available',
    storage: 'local-lvm',
    plugintype: 'lvmthin',
    content: 'images,rootdir',
    disk: 20 * GIB,
    maxdisk: 100 * GIB,
  },
  {
    id: 'storage/pve1/local',
    type: 'storage',
    node: 'pve1',
    status: 'available',
    storage: 'local',
    plugintype: 'dir',
    content: 'iso,vztmpl,backup,images,rootdir',
    disk: 50 * GIB,
    maxdisk: 200 * GIB,
  },
];

const WITH_FIRMWARE = { node: 'pve1', type: 'qemu', vmid: 100 } as const;
const WITHOUT_FIRMWARE = { node: 'pve1', type: 'qemu', vmid: 101 } as const;

function renderTab(guest: { node: string; type: 'qemu' | 'lxc'; vmid: number } = WITH_FIRMWARE) {
  const queryClient = createQueryClient();
  render(
    <QueryClientProvider client={queryClient}>
      <HardwareTab node={guest.node} type={guest.type} vmid={guest.vmid} />
    </QueryClientProvider>,
  );
}

async function openDialog(buttonName: string) {
  fireEvent.click(await screen.findByRole('button', { name: buttonName }));
  return screen.findByRole('dialog');
}

/** The table row whose first cell is `label`. */
function rowFor(label: string): HTMLElement {
  const row = screen.getByText(label).closest('tr');
  if (!row) throw new Error(`no row for ${label}`);
  return row;
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

describe('Hardware tab firmware rows', () => {
  let snapshot100: GuestConfig | undefined;
  let snapshot101: GuestConfig | undefined;

  beforeEach(() => {
    snapshot100 = getFixtureGuestConfig(100);
    snapshot101 = getFixtureGuestConfig(101);
    state.fixtures = false;
    mockUseAuthMe.mockReturnValue(authData('session'));
    mockUsePermissions.mockReturnValue(permissionsData(true));
    mockUseStoragePermissions.mockReturnValue(permissionsData(true));
    mockUseClusterResources.mockReturnValue({ data: STORAGES, isLoading: false });
    mockGetPendingConfig.mockResolvedValue([]);
    mockGetQemuMachines.mockResolvedValue(FIXTURE_QEMU_MACHINES);
    mockUpdateFirmware.mockResolvedValue({ ok: true, changed: [], pending: [] });
  });

  afterEach(() => {
    state.fixtures = false;
    restoreConfig(100, snapshot100);
    restoreConfig(101, snapshot101);
    resetFixtureFirmwarePending();
    vi.clearAllMocks();
  });

  it('(a) the four rows render the current fixture values', async () => {
    renderTab();
    await screen.findByText('Processors');

    expect(within(rowFor('BIOS')).getByText('OVMF (UEFI)')).toBeInTheDocument();
    expect(within(rowFor('Machine')).getByText('pc-q35-9.0')).toBeInTheDocument();
    expect(within(rowFor('SCSI Controller')).getByText('virtio-scsi-single')).toBeInTheDocument();
    expect(within(rowFor('Display')).getByText('default')).toBeInTheDocument();
    for (const name of ['Edit BIOS', 'Edit machine', 'Edit display', 'Edit SCSI controller']) {
      expect(screen.getByRole('button', { name }), name).toBeEnabled();
    }
  });

  it('(b) token mode: every firmware action is disabled with the read-only tooltip', async () => {
    mockUseAuthMe.mockReturnValue(authData('token'));
    renderTab(WITHOUT_FIRMWARE);
    await screen.findByText('Processors');

    for (const name of [
      'Edit BIOS',
      'Edit machine',
      'Edit display',
      'Edit SCSI controller',
      'Add EFI disk',
      'Add TPM state',
    ]) {
      const button = screen.getByRole('button', { name });
      expect(button, name).toBeDisabled();
      expect(button, name).toHaveAttribute('title', 'Read-only: signed in with a service token');
    }
  });

  it('(c) privileges are split: HWType for the four rows, Disk for the add actions', async () => {
    mockUsePermissions.mockReturnValue(permissionsData({ 'VM.Config.Disk': true }));
    renderTab(WITHOUT_FIRMWARE);
    await screen.findByText('Processors');

    for (const name of ['Edit BIOS', 'Edit machine', 'Edit display', 'Edit SCSI controller']) {
      const button = screen.getByRole('button', { name });
      expect(button, name).toBeDisabled();
      expect(button, name).toHaveAttribute('title', "You don't have VM.Config.HWType on this guest");
    }
    expect(screen.getByRole('button', { name: 'Add EFI disk' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Add TPM state' })).toBeEnabled();

    cleanup();
    mockUsePermissions.mockReturnValue(permissionsData({ 'VM.Config.HWType': true }));
    renderTab(WITHOUT_FIRMWARE);
    await screen.findByText('Processors');
    for (const name of ['Edit BIOS', 'Edit machine', 'Edit display', 'Edit SCSI controller']) {
      expect(screen.getByRole('button', { name }), name).toBeEnabled();
    }
    const noDisk = screen.getByRole('button', { name: 'Add EFI disk' });
    expect(noDisk).toBeDisabled();
    expect(noDisk).toHaveAttribute('title', "You don't have VM.Config.Disk on this guest");
  });

  it('(d) the EFI disk and TPM actions are hidden when efidisk0 / tpmstate0 exist, shown when absent', async () => {
    renderTab(WITH_FIRMWARE);
    await screen.findByText('Processors');
    expect(screen.queryByRole('button', { name: 'Add EFI disk' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Add TPM state' })).not.toBeInTheDocument();
    expect(screen.getByText('EFI Disk')).toBeInTheDocument();
    expect(screen.getByText('TPM State')).toBeInTheDocument();

    cleanup();
    patchFixtureGuestConfig('pve1', 'qemu', 100, { efidisk0: undefined });
    renderTab(WITH_FIRMWARE);
    expect(await screen.findByRole('button', { name: 'Add EFI disk' })).toBeEnabled();
    expect(screen.queryByRole('button', { name: 'Add TPM state' })).not.toBeInTheDocument();
  });

  it('(e) BIOS to OVMF with "Add EFI disk" sends one body with bios and efidisk', async () => {
    renderTab(WITHOUT_FIRMWARE);
    const dialog = await openDialog('Edit BIOS');

    expect(within(dialog).getByLabelText('BIOS')).toHaveValue('seabios');
    expect(within(dialog).queryByTestId('bios-efi-section')).not.toBeInTheDocument();
    fireEvent.change(within(dialog).getByLabelText('BIOS'), { target: { value: 'ovmf' } });

    const section = within(dialog).getByTestId('bios-efi-section');
    expect(within(section).getByRole('checkbox', { name: 'Add EFI disk' })).toBeChecked();
    expect(within(section).getByLabelText('Storage')).toHaveValue('local-lvm');
    expect(within(section).getByRole('checkbox', { name: 'Pre-enrolled keys' })).toBeChecked();
    expect(
      within(section).getByText(
        'Without an EFI disk Proxmox uses a temporary one and UEFI settings are lost on every stop.',
      ),
    ).toBeInTheDocument();

    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(mockUpdateFirmware).toHaveBeenCalledTimes(1));
    expect(mockUpdateFirmware.mock.calls[0]!.slice(0, 2)).toEqual(['pve1', 101]);
    expect(mockUpdateFirmware.mock.calls[0]![2]).toStrictEqual({
      bios: 'ovmf',
      efidisk: { storage: 'local-lvm', efitype: '4m', preEnrolledKeys: true },
    });
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });

  it('(f) BIOS to OVMF with the EFI disk unticked sends the bios alone; a guest with an EFI disk is offered none', async () => {
    renderTab(WITHOUT_FIRMWARE);
    const dialog = await openDialog('Edit BIOS');
    fireEvent.change(within(dialog).getByLabelText('BIOS'), { target: { value: 'ovmf' } });
    fireEvent.click(within(dialog).getByRole('checkbox', { name: 'Add EFI disk' }));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(mockUpdateFirmware).toHaveBeenCalledTimes(1));
    expect(mockUpdateFirmware.mock.calls[0]![2]).toStrictEqual({ bios: 'ovmf' });
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());

    cleanup();
    renderTab(WITH_FIRMWARE);
    const second = await openDialog('Edit BIOS');
    expect(within(second).getByLabelText('BIOS')).toHaveValue('ovmf');
    expect(within(second).getByRole('button', { name: 'Save' })).toBeDisabled();
    fireEvent.change(within(second).getByLabelText('BIOS'), { target: { value: 'seabios' } });
    expect(within(second).queryByTestId('bios-efi-section')).not.toBeInTheDocument();
    fireEvent.click(within(second).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(mockUpdateFirmware).toHaveBeenCalledTimes(2));
    expect(mockUpdateFirmware.mock.calls[1]![2]).toStrictEqual({ bios: 'seabios' });
  });

  it('(g) machine: q35 with a pinned version and vIOMMU sends exactly that', async () => {
    renderTab();
    const dialog = await openDialog('Edit machine');

    expect(within(dialog).getByRole('radio', { name: 'q35' })).toBeChecked();
    expect(within(dialog).getByLabelText('Version')).toHaveValue('9.0');
    expect(
      within(dialog).getByText('Changing the machine type under an installed OS can make it unbootable.'),
    ).toBeInTheDocument();
    // The node's list for q35, newest first, plus the version the guest is pinned to.
    await waitFor(() =>
      expect(within(within(dialog).getByLabelText('Version')).getAllByRole('option').map((o) => o.textContent)).toEqual([
        'Latest (default)',
        '9.0',
        '8.1',
        '8.0',
        '7.2',
      ]),
    );

    fireEvent.change(within(dialog).getByLabelText('Version'), { target: { value: '8.1' } });
    fireEvent.change(within(dialog).getByLabelText('vIOMMU'), { target: { value: 'intel' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(mockUpdateFirmware).toHaveBeenCalledTimes(1));
    expect(mockUpdateFirmware.mock.calls[0]!.slice(0, 2)).toEqual(['pve1', 100]);
    expect(mockUpdateFirmware.mock.calls[0]![2]).toStrictEqual({
      machine: { type: 'q35', version: '8.1', viommu: 'intel' },
    });
  });

  it('(h) machine: i440fx with "Latest (default)" sends just the type', async () => {
    renderTab();
    const dialog = await openDialog('Edit machine');

    fireEvent.click(within(dialog).getByRole('radio', { name: 'i440fx' }));
    expect(within(dialog).getByLabelText('Version')).toHaveValue('');
    // vIOMMU only exists on q35.
    expect(within(dialog).queryByLabelText('vIOMMU')).not.toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(mockUpdateFirmware).toHaveBeenCalledTimes(1));
    expect(mockUpdateFirmware.mock.calls[0]![2]).toStrictEqual({ machine: { type: 'i440fx' } });
  });

  it('(i) machine: "Reset to default" sends null', async () => {
    renderTab();
    const dialog = await openDialog('Edit machine');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Reset to default' }));

    await waitFor(() => expect(mockUpdateFirmware).toHaveBeenCalledTimes(1));
    expect(mockUpdateFirmware.mock.calls[0]![2]).toStrictEqual({ machine: null });
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });

  it('(j) display: type and video memory send exactly that; Default resets', async () => {
    renderTab();
    const dialog = await openDialog('Edit display');

    expect(within(dialog).getByLabelText('Display')).toHaveValue('');
    fireEvent.change(within(dialog).getByLabelText('Display'), { target: { value: 'virtio' } });
    fireEvent.change(within(dialog).getByLabelText('Video memory (MiB)'), { target: { value: '32' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(mockUpdateFirmware).toHaveBeenCalledTimes(1));
    expect(mockUpdateFirmware.mock.calls[0]![2]).toStrictEqual({ vga: { type: 'virtio', memory: 32 } });
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());

    // A serial terminal has no video memory; an existing vga can be reset to the default.
    cleanup();
    patchFixtureGuestConfig('pve1', 'qemu', 100, { vga: 'serial0' });
    renderTab();
    await waitFor(() => expect(within(rowFor('Display')).getByText('serial0')).toBeInTheDocument());
    const second = await openDialog('Edit display');
    expect(within(second).getByLabelText('Display')).toHaveValue('serial0');
    expect(within(second).queryByLabelText('Video memory (MiB)')).not.toBeInTheDocument();
    fireEvent.change(within(second).getByLabelText('Display'), { target: { value: '' } });
    fireEvent.click(within(second).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(mockUpdateFirmware).toHaveBeenCalledTimes(2));
    expect(mockUpdateFirmware.mock.calls[1]![2]).toStrictEqual({ vga: null });
  });

  it('(k) SCSI controller sends the chosen model', async () => {
    renderTab();
    const dialog = await openDialog('Edit SCSI controller');

    expect(within(dialog).getByLabelText('SCSI controller')).toHaveValue('virtio-scsi-single');
    expect(within(dialog).getByRole('button', { name: 'Save' })).toBeDisabled();
    fireEvent.change(within(dialog).getByLabelText('SCSI controller'), { target: { value: 'pvscsi' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(mockUpdateFirmware).toHaveBeenCalledTimes(1));
    expect(mockUpdateFirmware.mock.calls[0]![2]).toStrictEqual({ scsihw: 'pvscsi' });
  });

  it('(l) Add TPM state and Add EFI disk send exactly their bodies', async () => {
    renderTab(WITHOUT_FIRMWARE);
    const tpm = await openDialog('Add TPM state');
    expect(within(tpm).getByLabelText('Version')).toHaveValue('v2.0');
    fireEvent.click(within(tpm).getByRole('button', { name: 'Add' }));
    await waitFor(() => expect(mockUpdateFirmware).toHaveBeenCalledTimes(1));
    expect(mockUpdateFirmware.mock.calls[0]!.slice(0, 2)).toEqual(['pve1', 101]);
    expect(mockUpdateFirmware.mock.calls[0]![2]).toStrictEqual({
      tpmstate: { storage: 'local-lvm', version: 'v2.0' },
    });
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());

    const efi = await openDialog('Add EFI disk');
    fireEvent.change(within(efi).getByLabelText('Storage'), { target: { value: 'local' } });
    fireEvent.click(within(efi).getByRole('checkbox', { name: 'Pre-enrolled keys' }));
    fireEvent.click(within(efi).getByRole('button', { name: 'Add' }));
    await waitFor(() => expect(mockUpdateFirmware).toHaveBeenCalledTimes(2));
    expect(mockUpdateFirmware.mock.calls[1]![2]).toStrictEqual({
      efidisk: { storage: 'local', efitype: '4m', preEnrolledKeys: false },
    });
  });

  it('(m) without Datastore.AllocateSpace on the storage the add is blocked with a hint', async () => {
    mockUseStoragePermissions.mockReturnValue(permissionsData({ 'Datastore.Audit': true }));
    renderTab(WITHOUT_FIRMWARE);
    const dialog = await openDialog('Add TPM state');

    expect(within(dialog).getByTestId('storage-permission-hint')).toHaveTextContent(
      "You don't have Datastore.AllocateSpace on local-lvm",
    );
    expect(within(dialog).getByRole('button', { name: 'Add' })).toBeDisabled();
    expect(mockUpdateFirmware).not.toHaveBeenCalled();
  });

  it('(n) fixture round trip: adding an EFI disk updates the config and shows the pending banner', async () => {
    state.fixtures = true;
    mockUpdateFirmware.mockImplementation((...args: unknown[]) =>
      (state.firmware!.updateFirmware as (...a: unknown[]) => Promise<unknown>)(...args),
    );
    mockGetPendingConfig.mockResolvedValue([]);

    renderTab(WITHOUT_FIRMWARE);
    await screen.findByText('Processors');
    expect(screen.queryByText('EFI Disk')).not.toBeInTheDocument();
    expect(screen.queryByTestId('hardware-pending-banner')).not.toBeInTheDocument();

    const dialog = await openDialog('Add EFI disk');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Add' }));

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(await screen.findByText('EFI Disk')).toBeInTheDocument();
    expect(getFixtureGuestConfig(101)?.efidisk0).toMatch(/^local-lvm:vm-101-disk-8,efitype=4m,pre-enrolled-keys=1/);
    const banner = await screen.findByTestId('hardware-pending-banner');
    expect(banner).toHaveTextContent('efidisk0');
    // The action goes away once the guest has the disk.
    expect(screen.queryByRole('button', { name: 'Add EFI disk' })).not.toBeInTheDocument();
  });
});
