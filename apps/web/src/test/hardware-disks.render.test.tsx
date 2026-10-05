import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClientProvider } from '@tanstack/react-query';

import { HardwareTab } from '@/pages/vm/tabs/HardwareTab';
import { createQueryClient } from '@/api/queryClient';
import { getFixtureGuestConfig, patchFixtureGuestConfig } from '@/api/fixtures';
import type { AuthIdentity } from '@/api/client-types';
import type { GuestPermissions } from '@/api/actionHooks';
import type { ClusterResource, GuestConfig } from '@/api/types';

/**
 * The Hardware tab's disk lifecycle (T52): add a disk / mount point, detach a disk, remove an
 * unused volume. Same harness as `hardware-tab-edit.render.test.tsx`: `useAuthMe`,
 * `useClusterResources` and `usePermissions` are mocked so each test controls the gate and the
 * storages; `@/api/disks`'s network functions are mocked so the exact request each dialog builds
 * can be asserted; the guest config comes from the real fixture client. The last tests flip
 * `USE_FIXTURES` on and run the real fixture flow instead.
 */
const mockUseAuthMe = vi.fn();
const mockUseClusterResources = vi.fn();
const mockUsePermissions = vi.fn();
const mockGetPendingConfig = vi.fn();
const mockAddDisk = vi.fn();
const mockDetachDisk = vi.fn();
const mockRemoveUnusedDisk = vi.fn();
const mockGetStorageFormats = vi.fn();

const state = vi.hoisted(() => ({
  fixtures: false,
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
  return { ...actual, getPendingConfig: (...args: unknown[]) => mockGetPendingConfig(...args) };
});

vi.mock('@/api/disks', async () => {
  const actual = await vi.importActual<typeof import('@/api/disks')>('@/api/disks');
  state.disks = actual;
  return {
    ...actual,
    addDisk: (...args: unknown[]) => mockAddDisk(...args),
    detachDisk: (...args: unknown[]) => mockDetachDisk(...args),
    removeUnusedDisk: (...args: unknown[]) => mockRemoveUnusedDisk(...args),
    getStorageFormats: (...args: unknown[]) => mockGetStorageFormats(...args),
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
  { id: 'storage/pve1/isos', type: 'storage', node: 'pve1', status: 'available', storage: 'isos', plugintype: 'dir', content: 'iso' },
  {
    id: 'storage/pve2/local',
    type: 'storage',
    node: 'pve2',
    status: 'available',
    storage: 'local',
    plugintype: 'dir',
    content: 'iso,vztmpl,backup,rootdir',
    disk: 10 * GIB,
    maxdisk: 40 * GIB,
  },
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

describe('Hardware tab disk lifecycle', () => {
  let snapshot100: GuestConfig | undefined;
  let snapshot200: GuestConfig | undefined;

  beforeEach(() => {
    snapshot100 = getFixtureGuestConfig(100);
    snapshot200 = getFixtureGuestConfig(200);
    state.fixtures = false;
    mockUseAuthMe.mockReturnValue(authData('session'));
    mockUsePermissions.mockReturnValue(permissionsData(true));
    mockUseClusterResources.mockReturnValue({ data: STORAGES, isLoading: false });
    mockGetPendingConfig.mockResolvedValue([]);
    mockGetStorageFormats.mockResolvedValue({});
    mockAddDisk.mockResolvedValue({ ok: true, slot: 'scsi2', pending: [] });
    mockDetachDisk.mockResolvedValue({ ok: true, unusedSlot: 'unused0', pending: [] });
    mockRemoveUnusedDisk.mockResolvedValue({ ok: true });
  });

  afterEach(() => {
    state.fixtures = false;
    restoreConfig(100, snapshot100);
    restoreConfig(200, snapshot200);
    vi.clearAllMocks();
  });

  it('(a) token mode: add, detach and remove are all disabled with the read-only tooltip', async () => {
    patchFixtureGuestConfig('pve1', 'qemu', 100, { unused0: 'tank:vm-100-disk-7' });
    mockUseAuthMe.mockReturnValue(authData('token'));

    renderTab();
    await screen.findByText('Processors');

    for (const name of ['Add disk', 'Detach scsi0', 'Detach scsi1', 'Remove unused0']) {
      const button = screen.getByRole('button', { name });
      expect(button, name).toBeDisabled();
      expect(button, name).toHaveAttribute('title', 'Read-only: signed in with a service token');
    }
  });

  it('(a2) without VM.Config.Disk all three are disabled with the privilege tooltip', async () => {
    patchFixtureGuestConfig('pve1', 'qemu', 100, { unused0: 'tank:vm-100-disk-7' });
    mockUsePermissions.mockReturnValue(permissionsData({ 'VM.Config.CPU': true }));

    renderTab();
    await screen.findByText('Processors');

    for (const name of ['Add disk', 'Detach scsi1', 'Remove unused0']) {
      const button = screen.getByRole('button', { name });
      expect(button, name).toBeDisabled();
      expect(button, name).toHaveAttribute('title', "You don't have VM.Config.Disk on this guest");
    }
  });

  it('(a3) lxc: the header button is "Add mount point" and gated the same way', async () => {
    mockUseAuthMe.mockReturnValue(authData('token'));
    renderTab(LXC);
    await screen.findByText('Memory');
    const add = screen.getByRole('button', { name: 'Add mount point' });
    expect(add).toBeDisabled();
    expect(add).toHaveAttribute('title', 'Read-only: signed in with a service token');
    expect(screen.getByRole('button', { name: 'Detach mp0' })).toBeDisabled();
    // The root disk cannot be detached.
    expect(screen.queryByRole('button', { name: 'Detach rootfs' })).not.toBeInTheDocument();
  });

  it('(a4) add is disabled with its own tooltip when no storage on the node can hold disks', async () => {
    mockUseClusterResources.mockReturnValue({
      data: STORAGES.filter((s) => s.storage === 'isos'),
      isLoading: false,
    });
    renderTab();
    await screen.findByText('Processors');
    const add = screen.getByRole('button', { name: 'Add disk' });
    expect(add).toBeDisabled();
    expect(add).toHaveAttribute('title', 'No storage on this node can hold disk images');
    // Detach is unaffected by the storage list.
    expect(screen.getByRole('button', { name: 'Detach scsi1' })).toBeEnabled();
  });

  it('(b) qemu add: defaults submit scsi / first image storage / 32 GiB / backup on, nothing else', async () => {
    renderTab();
    const dialog = await openDialog('Add disk');

    expect(within(dialog).getByLabelText('Bus')).toHaveValue('scsi');
    expect(within(dialog).getByLabelText('Storage')).toHaveValue('local-lvm');
    // Only image-capable storages of this node, with their free space (maxdisk - disk).
    expect(within(within(dialog).getByLabelText('Storage')).getAllByRole('option').map((o) => o.textContent)).toEqual([
      'local-lvm (80.0 GiB free)',
      'local (150.0 GiB free)',
    ]);
    expect(within(dialog).getByLabelText('Size (GiB)')).toHaveValue(32);
    expect(within(dialog).getByRole('checkbox', { name: 'Include in backup' })).toBeChecked();
    // local-lvm is raw-only: no format choice, just the fixed format.
    expect(within(dialog).queryByLabelText('Format')).not.toBeInTheDocument();
    expect(within(dialog).getByTestId('add-disk-fixed-format')).toHaveTextContent('raw');

    fireEvent.click(within(dialog).getByRole('button', { name: 'Add' }));

    await waitFor(() => expect(mockAddDisk).toHaveBeenCalledTimes(1));
    expect(mockAddDisk.mock.calls[0]!.slice(0, 3)).toEqual(['pve1', 'qemu', 100]);
    // No undefined keys: a default left alone is simply not sent.
    expect(mockAddDisk.mock.calls[0]![3]).toStrictEqual({
      bus: 'scsi',
      storage: 'local-lvm',
      sizeGiB: 32,
      backup: true,
    });
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });

  it('(b2) qemu add: a directory storage offers its formats; chosen options are sent; virtio hides SSD', async () => {
    renderTab();
    const dialog = await openDialog('Add disk');

    fireEvent.change(within(dialog).getByLabelText('Storage'), { target: { value: 'local' } });
    const format = within(dialog).getByLabelText('Format');
    expect(within(format).getAllByRole('option').map((o) => o.textContent)).toEqual([
      'Default (qcow2)',
      'qcow2',
      'raw',
      'vmdk',
    ]);
    fireEvent.change(format, { target: { value: 'vmdk' } });
    fireEvent.change(within(dialog).getByLabelText('Size (GiB)'), { target: { value: '100' } });
    fireEvent.change(within(dialog).getByLabelText('Cache'), { target: { value: 'writeback' } });
    fireEvent.click(within(dialog).getByRole('checkbox', { name: 'Discard (TRIM)' }));
    fireEvent.click(within(dialog).getByRole('checkbox', { name: 'SSD emulation' }));
    fireEvent.click(within(dialog).getByRole('checkbox', { name: 'Include in backup' }));

    fireEvent.change(within(dialog).getByLabelText('Bus'), { target: { value: 'virtio' } });
    expect(within(dialog).queryByRole('checkbox', { name: 'SSD emulation' })).not.toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole('checkbox', { name: 'IO thread' }));

    fireEvent.click(within(dialog).getByRole('button', { name: 'Add' }));
    await waitFor(() => expect(mockAddDisk).toHaveBeenCalledTimes(1));
    expect(mockAddDisk.mock.calls[0]![3]).toStrictEqual({
      bus: 'virtio',
      storage: 'local',
      sizeGiB: 100,
      backup: false,
      format: 'vmdk',
      discard: true,
      iothread: true,
      cache: 'writeback',
    });
  });

  it('(b3) qemu add: the node\'s own format list wins over inference, and a bad size blocks Add', async () => {
    mockGetStorageFormats.mockResolvedValue({ 'local-lvm': { formats: ['raw', 'qcow2'], default: 'raw' } });
    renderTab();
    const dialog = await openDialog('Add disk');
    const format = await within(dialog).findByLabelText('Format');
    expect(within(format).getAllByRole('option').map((o) => o.textContent)).toEqual(['Default (raw)', 'raw', 'qcow2']);

    for (const value of ['0', '-4', '1.5', 'abc', '65537']) {
      fireEvent.change(within(dialog).getByLabelText('Size (GiB)'), { target: { value } });
      expect(within(dialog).getByRole('button', { name: 'Add' }), value).toBeDisabled();
    }
    fireEvent.change(within(dialog).getByLabelText('Size (GiB)'), { target: { value: '1' } });
    expect(within(dialog).getByRole('button', { name: 'Add' })).toBeEnabled();
  });

  it('(b4) qemu add: a full bus is greyed out, and a server error stays inline', async () => {
    const full: Record<string, string> = {};
    for (let n = 0; n < 4; n++) full[`ide${n}`] = `local:vm-100-disk-${50 + n},size=1G`;
    patchFixtureGuestConfig('pve1', 'qemu', 100, full);
    const { GuestActionError } = await import('@/api/actions');
    mockAddDisk.mockRejectedValue(new GuestActionError(400, 'scsi2: unable to create image'));

    renderTab();
    const dialog = await openDialog('Add disk');
    expect(within(dialog).getByRole('option', { name: 'IDE (full)' })).toBeDisabled();

    fireEvent.click(within(dialog).getByRole('button', { name: 'Add' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('scsi2: unable to create image');
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });

  it('(c) lxc add: submits storage, size, mount point and backup only', async () => {
    mockAddDisk.mockResolvedValue({ ok: true, slot: 'mp1', pending: [] });
    renderTab(LXC);
    const dialog = await openDialog('Add mount point');

    expect(within(dialog).queryByLabelText('Bus')).not.toBeInTheDocument();
    expect(within(dialog).queryByLabelText('Cache')).not.toBeInTheDocument();
    expect(within(dialog).queryByLabelText('Format')).not.toBeInTheDocument();
    expect(within(dialog).getByLabelText('Storage')).toHaveValue('local');
    expect(within(dialog).getByLabelText('Size (GiB)')).toHaveValue(8);
    expect(within(dialog).getByRole('checkbox', { name: 'Include in backup' })).toBeChecked();

    fireEvent.change(within(dialog).getByLabelText('Mount point'), { target: { value: '/data' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Add' }));

    await waitFor(() => expect(mockAddDisk).toHaveBeenCalledTimes(1));
    expect(mockAddDisk.mock.calls[0]!.slice(0, 3)).toEqual(['pve2', 'lxc', 200]);
    expect(mockAddDisk.mock.calls[0]![3]).toStrictEqual({
      storage: 'local',
      sizeGiB: 8,
      mountPoint: '/data',
      backup: true,
    });
  });

  it('(c2) lxc add: read-only and ACL are sent when ticked; a bad path blocks Add', async () => {
    renderTab(LXC);
    const dialog = await openDialog('Add mount point');

    for (const path of ['data', '/a/../b', '/a,b', '/my data', '']) {
      fireEvent.change(within(dialog).getByLabelText('Mount point'), { target: { value: path } });
      expect(within(dialog).getByRole('button', { name: 'Add' }), path).toBeDisabled();
    }
    fireEvent.change(within(dialog).getByLabelText('Mount point'), { target: { value: '/srv/share' } });
    fireEvent.click(within(dialog).getByRole('checkbox', { name: 'Read-only' }));
    fireEvent.click(within(dialog).getByRole('checkbox', { name: 'ACL' }));
    fireEvent.click(within(dialog).getByRole('checkbox', { name: 'Include in backup' }));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Add' }));

    await waitFor(() => expect(mockAddDisk).toHaveBeenCalledTimes(1));
    expect(mockAddDisk.mock.calls[0]![3]).toStrictEqual({
      storage: 'local',
      sizeGiB: 8,
      mountPoint: '/srv/share',
      backup: false,
      readOnly: true,
      acl: true,
    });
  });

  it('(d) detach: confirm names the unused slot, then calls detachDisk', async () => {
    renderTab();
    const dialog = await openDialog('Detach scsi1', 'alertdialog');

    expect(within(dialog).getByText('Detach scsi1? The disk is kept as unused0 until you remove it.')).toBeInTheDocument();
    expect(mockDetachDisk).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Detach' }));

    await waitFor(() => expect(mockDetachDisk).toHaveBeenCalledWith('pve1', 'qemu', 100, 'scsi1'));
    expect(mockDetachDisk).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument());
  });

  it('(d2) detach: the confirm names the next free unused slot, and Cancel sends nothing', async () => {
    patchFixtureGuestConfig('pve1', 'qemu', 100, { unused0: 'tank:vm-100-disk-7', unused1: 'tank:vm-100-disk-8' });
    renderTab();
    const dialog = await openDialog('Detach scsi0', 'alertdialog');
    expect(within(dialog).getByText(/kept as unused2 until you remove it/)).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument());
    expect(mockDetachDisk).not.toHaveBeenCalled();
  });

  it('(d3) detach: a lxc mount point can be detached; a server error stays inline', async () => {
    const { GuestActionError } = await import('@/api/actions');
    mockDetachDisk.mockRejectedValue(new GuestActionError(400, 'mp0: volume is busy'));
    renderTab(LXC);
    const dialog = await openDialog('Detach mp0', 'alertdialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Detach' }));
    await waitFor(() => expect(mockDetachDisk).toHaveBeenCalledWith('pve2', 'lxc', 200, 'mp0'));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('mp0: volume is busy');
    expect(screen.getByRole('alertdialog')).toBeInTheDocument();
  });

  it('(d4) detach: a lxc bind mount says it has no volume instead of promising an unused slot', async () => {
    patchFixtureGuestConfig('pve2', 'lxc', 200, { mp2: '/host/data,mp=/data' });
    renderTab(LXC);
    const dialog = await openDialog('Detach mp2', 'alertdialog');
    expect(
      within(dialog).getByText(
        'Detach mp2? A bind mount has no volume; the mount point is simply removed from the container.',
      ),
    ).toBeInTheDocument();
    expect(within(dialog).queryByText(/kept as unused/)).not.toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Detach' }));
    await waitFor(() => expect(mockDetachDisk).toHaveBeenCalledWith('pve2', 'lxc', 200, 'mp2'));
  });

  it('(e) remove unused: destroys only after the slot name is typed', async () => {
    patchFixtureGuestConfig('pve1', 'qemu', 100, { unused0: 'tank:vm-100-disk-7' });
    renderTab();

    expect(await screen.findByText('Unused Disk (unused0)')).toBeInTheDocument();
    // An unused volume is not a "Hard Disk" row and cannot be detached or grown.
    expect(screen.queryByText('Hard Disk (unused0)')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Detach unused0' })).not.toBeInTheDocument();

    const dialog = await openDialog('Remove unused0', 'alertdialog');
    expect(within(dialog).getByText(/This destroys the volume permanently/)).toBeInTheDocument();
    const remove = within(dialog).getByRole('button', { name: 'Remove' });
    expect(remove).toBeDisabled();

    const input = within(dialog).getByLabelText('Type unused0 to confirm');
    fireEvent.change(input, { target: { value: 'unused' } });
    expect(remove).toBeDisabled();
    fireEvent.change(input, { target: { value: 'unused1' } });
    expect(remove).toBeDisabled();
    fireEvent.click(remove);
    expect(mockRemoveUnusedDisk).not.toHaveBeenCalled();

    fireEvent.change(input, { target: { value: 'unused0' } });
    expect(remove).toBeEnabled();
    fireEvent.click(remove);

    await waitFor(() => expect(mockRemoveUnusedDisk).toHaveBeenCalledWith('pve1', 'qemu', 100, 'unused0'));
    expect(mockRemoveUnusedDisk).toHaveBeenCalledTimes(1);
  });

  it('(e2) remove unused: a lxc unused volume gets its own row and action', async () => {
    patchFixtureGuestConfig('pve2', 'lxc', 200, { unused0: 'tank:subvol-200-disk-9' });
    renderTab(LXC);
    expect(await screen.findByText('Unused Disk (unused0)')).toBeInTheDocument();
    const dialog = await openDialog('Remove unused0', 'alertdialog');
    fireEvent.change(within(dialog).getByLabelText('Type unused0 to confirm'), { target: { value: 'unused0' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Remove' }));
    await waitFor(() => expect(mockRemoveUnusedDisk).toHaveBeenCalledWith('pve2', 'lxc', 200, 'unused0'));
  });

  it('(f) fixture mode: a new disk shows up as a row, detach moves it to an unused row, remove deletes it', async () => {
    state.fixtures = true;
    const actual = state.disks!;
    mockAddDisk.mockImplementation(actual.addDisk);
    mockDetachDisk.mockImplementation(actual.detachDisk);
    mockRemoveUnusedDisk.mockImplementation(actual.removeUnusedDisk);

    renderTab();
    expect(await screen.findByText('Hard Disk (scsi1)')).toBeInTheDocument();
    expect(screen.queryByText('Hard Disk (scsi2)')).not.toBeInTheDocument();

    // add
    const dialog = await openDialog('Add disk');
    fireEvent.change(within(dialog).getByLabelText('Size (GiB)'), { target: { value: '12' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Add' }));
    const newRow = (await screen.findByText('Hard Disk (scsi2)')).closest('tr')!;
    expect(within(newRow).getByTestId('volume-id')).toHaveTextContent('local-lvm:vm-100-disk-5');
    expect(within(newRow).getByText(/12\.0 GiB/)).toBeInTheDocument();
    expect(getFixtureGuestConfig(100)?.scsi2).toBe('local-lvm:vm-100-disk-5,size=12G');

    // detach
    const detach = await openDialog('Detach scsi1', 'alertdialog');
    fireEvent.click(within(detach).getByRole('button', { name: 'Detach' }));
    const unusedRow = (await screen.findByText('Unused Disk (unused0)')).closest('tr')!;
    expect(within(unusedRow).getByTestId('volume-id')).toHaveTextContent('tank:vm-100-disk-4');
    await waitFor(() => expect(screen.queryByText('Hard Disk (scsi1)')).not.toBeInTheDocument());

    // remove
    const remove = await openDialog('Remove unused0', 'alertdialog');
    fireEvent.change(within(remove).getByLabelText('Type unused0 to confirm'), { target: { value: 'unused0' } });
    fireEvent.click(within(remove).getByRole('button', { name: 'Remove' }));
    await waitFor(() => expect(screen.queryByText('Unused Disk (unused0)')).not.toBeInTheDocument());
    expect(getFixtureGuestConfig(100)).not.toHaveProperty('unused0');
  });

  it('(f2) fixture mode: a new lxc mount point shows up with its path', async () => {
    state.fixtures = true;
    mockAddDisk.mockImplementation(state.disks!.addDisk);

    renderTab(LXC);
    const dialog = await openDialog('Add mount point');
    fireEvent.change(within(dialog).getByLabelText('Mount point'), { target: { value: '/srv/new' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Add' }));

    const row = (await screen.findByText('Mount Point (mp1)')).closest('tr')!;
    expect(row).toHaveTextContent('→ /srv/new');
  });
});
