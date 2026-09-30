import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, renderHook, screen, waitFor, within } from '@testing-library/react';
import { QueryClientProvider } from '@tanstack/react-query';

import { HardwareTab } from '@/pages/vm/tabs/HardwareTab';
import { createQueryClient } from '@/api/queryClient';
import { useResizeDisk } from '@/api/hardwareHooks';
import { addFixtureStorageContent, patchFixtureGuestConfig } from '@/api/fixtures';
import type { AuthIdentity } from '@/api/client-types';
import type { GuestPermissions } from '@/api/actionHooks';
import type { ClusterResource } from '@/api/types';

/**
 * The Hardware tab's edit affordances (T48): per-row pencils gated on session mode + the PVE
 * privilege each edit needs, the four edit dialogs, and the pending-restart banner/badges.
 * `useAuthMe`/`useClusterResources`/`usePermissions` are mocked so each test controls the gate and
 * the storages directly; the guest config and storage content come from the real fixture client,
 * and `@/api/hardware`'s network functions are mocked so the exact request each dialog builds can
 * be asserted. The last tests flip `USE_FIXTURES` on and use the real fixture flow instead.
 */
const mockUseAuthMe = vi.fn();
const mockUseClusterResources = vi.fn();
const mockUsePermissions = vi.fn();
const mockUpdateHardware = vi.fn();
const mockResizeDisk = vi.fn();
const mockGetPendingConfig = vi.fn();

const state = vi.hoisted(() => ({
  fixtures: false,
  actual: undefined as typeof import('@/api/hardware') | undefined,
}));

// `USE_FIXTURES` is true by default in this test env (`.env.test`), which would short-circuit the
// session-mode gate to "always enabled" before the mocked `useAuthMe` ever mattered. A getter, so
// the fixture-flow tests can flip it per test.
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
  state.actual = actual;
  return {
    ...actual,
    updateHardware: (...args: unknown[]) => mockUpdateHardware(...args),
    resizeDisk: (...args: unknown[]) => mockResizeDisk(...args),
    getPendingConfig: (...args: unknown[]) => mockGetPendingConfig(...args),
    getCpuModels: () => Promise.resolve(actual.FALLBACK_CPU_MODELS),
  };
});

function authData(mode: AuthIdentity['mode']) {
  return { data: { username: 'root@pam', realm: 'pam', capabilities: {}, mode } };
}

function permissionsData(privs: Record<string, boolean> | true) {
  const value: GuestPermissions = { can: (p: string) => privs === true || privs[p] === true };
  return { data: value };
}

const STORAGES: ClusterResource[] = [
  { id: 'storage/pve1/local', type: 'storage', node: 'pve1', status: 'available', storage: 'local', content: 'iso,vztmpl,backup' },
  { id: 'storage/pve1/tank', type: 'storage', node: 'pve1', status: 'available', storage: 'tank', content: 'images,rootdir' },
  { id: 'storage/pve2/local', type: 'storage', node: 'pve2', status: 'available', storage: 'local', content: 'iso,vztmpl,backup' },
];

function renderTab(guest: { node: string; type: 'qemu' | 'lxc'; vmid: number } = { node: 'pve1', type: 'qemu', vmid: 100 }) {
  const queryClient = createQueryClient();
  render(
    <QueryClientProvider client={queryClient}>
      <HardwareTab node={guest.node} type={guest.type} vmid={guest.vmid} />
    </QueryClientProvider>,
  );
}

async function openDialog(pencilName: string) {
  fireEvent.click(await screen.findByRole('button', { name: pencilName }));
  return screen.findByRole('dialog');
}

describe('Hardware tab editing', () => {
  beforeEach(() => {
    state.fixtures = false;
    mockUseAuthMe.mockReturnValue(authData('session'));
    mockUsePermissions.mockReturnValue(permissionsData(true));
    mockUseClusterResources.mockReturnValue({ data: STORAGES, isLoading: false });
    mockUpdateHardware.mockResolvedValue({ ok: true, changed: [], pending: [] });
    mockResizeDisk.mockResolvedValue({ upid: 'UPID:pve1:00000001:00000000:00000000:resize:100:root@pam:' });
    mockGetPendingConfig.mockResolvedValue([]);
  });

  afterEach(() => {
    state.fixtures = false;
    patchFixtureGuestConfig('pve1', 'qemu', 100, { balloon: 0 });
    vi.clearAllMocks();
  });

  it('(a) token mode: every pencil is disabled with the read-only tooltip', async () => {
    mockUseAuthMe.mockReturnValue(authData('token'));

    renderTab();
    await screen.findByText('Processors');

    const pencils = screen.getAllByRole('button', { name: /^Edit / });
    // memory, processors, scsi0, scsi1, ide2 (ide3 is cloud-init, not a drive to edit)
    expect(pencils.length).toBeGreaterThanOrEqual(5);
    for (const pencil of pencils) {
      expect(pencil).toBeDisabled();
      expect(pencil).toHaveAttribute('title', 'Read-only: signed in with a service token');
    }
  });

  it('(b) per-privilege gating: CPU needs VM.Config.CPU, memory needs VM.Config.Memory', async () => {
    mockUsePermissions.mockReturnValue(permissionsData({ 'VM.Config.Memory': true }));

    renderTab();
    await screen.findByText('Processors');

    const cpu = screen.getByRole('button', { name: 'Edit processors' });
    expect(cpu).toBeDisabled();
    expect(cpu).toHaveAttribute('title', "You don't have VM.Config.CPU on this guest");

    expect(screen.getByRole('button', { name: 'Edit memory' })).toBeEnabled();

    const disk = screen.getByRole('button', { name: 'Edit disk scsi0' });
    expect(disk).toBeDisabled();
    expect(disk).toHaveAttribute('title', "You don't have VM.Config.Disk on this guest");

    const cdrom = screen.getByRole('button', { name: 'Edit CD/DVD drive ide2' });
    expect(cdrom).toBeDisabled();
    expect(cdrom).toHaveAttribute('title', "You don't have VM.Config.CDROM on this guest");
  });

  it('(c) CPU dialog: submit sends sockets, cores and the chosen CPU type exactly', async () => {
    renderTab();
    const dialog = await openDialog('Edit processors');

    expect(within(dialog).getByLabelText('Cores')).toHaveValue(4);
    fireEvent.change(within(dialog).getByLabelText('Sockets'), { target: { value: '2' } });
    const select = within(dialog).getByLabelText('CPU type');
    // Grouped by vendor, with "host" explained.
    expect(within(dialog).getByRole('group', { name: 'Intel' })).toBeInTheDocument();
    expect(within(dialog).getByRole('group', { name: 'AMD' })).toBeInTheDocument();
    expect(within(dialog).getByText(/passes the node's physical CPU through/)).toBeInTheDocument();
    fireEvent.change(select, { target: { value: 'x86-64-v3' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));

    await waitFor(() =>
      expect(mockUpdateHardware).toHaveBeenCalledWith('pve1', 'qemu', 100, {
        sockets: 2,
        cores: 4,
        cpu: 'x86-64-v3',
      }),
    );
    expect(mockUpdateHardware).toHaveBeenCalledTimes(1);
  });

  it('(c2) CPU dialog: an unchanged CPU type is not sent, and invalid cores disable Save', async () => {
    renderTab();
    const dialog = await openDialog('Edit processors');

    fireEvent.change(within(dialog).getByLabelText('Cores'), { target: { value: '0' } });
    expect(within(dialog).getByRole('button', { name: 'Save' })).toBeDisabled();
    fireEvent.change(within(dialog).getByLabelText('Cores'), { target: { value: '6' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));

    await waitFor(() =>
      expect(mockUpdateHardware).toHaveBeenCalledWith('pve1', 'qemu', 100, { sockets: 1, cores: 6 }),
    );
  });

  it('(c3) a server error stays inline and the dialog stays open', async () => {
    const { GuestActionError } = await import('@/api/actions');
    mockUpdateHardware.mockRejectedValue(new GuestActionError(400, 'cpu: unknown cpu model'));

    renderTab();
    const dialog = await openDialog('Edit processors');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));

    expect(await within(dialog).findByRole('alert')).toHaveTextContent('cpu: unknown cpu model');
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });

  it('(d) memory dialog: 8 GiB converts to 8192 MiB and the disabled balloon (0) is sent', async () => {
    // The fixture guest starts with ballooning already disabled; give it a minimum so that
    // setting it to 0 is a real change (only changed fields are sent).
    patchFixtureGuestConfig('pve1', 'qemu', 100, { balloon: 2048 });
    renderTab();
    const dialog = await openDialog('Edit memory');

    expect(within(dialog).getByLabelText('Memory (MiB)')).toHaveValue(4096);
    expect(within(dialog).getByLabelText('Memory (GiB)')).toHaveValue(4);
    expect(within(dialog).getByText(/0 = ballooning disabled/)).toBeInTheDocument();

    fireEvent.change(within(dialog).getByLabelText('Memory (GiB)'), { target: { value: '8' } });
    expect(within(dialog).getByLabelText('Memory (MiB)')).toHaveValue(8192);
    fireEvent.change(within(dialog).getByLabelText('Minimum memory / balloon (MiB)'), { target: { value: '0' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));

    await waitFor(() =>
      expect(mockUpdateHardware).toHaveBeenCalledWith('pve1', 'qemu', 100, { memory: 8192, balloon: 0 }),
    );
  });

  it('(d3) memory dialog: only a changed balloon is sent, without the untouched memory', async () => {
    patchFixtureGuestConfig('pve1', 'qemu', 100, { balloon: 2048 });
    renderTab();
    const dialog = await openDialog('Edit memory');

    expect(within(dialog).getByRole('button', { name: 'Save' })).toBeDisabled();
    fireEvent.change(within(dialog).getByLabelText('Minimum memory / balloon (MiB)'), { target: { value: '0' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(mockUpdateHardware).toHaveBeenCalledWith('pve1', 'qemu', 100, { balloon: 0 }));
    expect(mockUpdateHardware).toHaveBeenCalledTimes(1);
  });

  it('(d4) memory dialog: a changed memory alone does not resend the unchanged balloon', async () => {
    renderTab();
    const dialog = await openDialog('Edit memory');

    fireEvent.change(within(dialog).getByLabelText('Memory (MiB)'), { target: { value: '6144' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(mockUpdateHardware).toHaveBeenCalledWith('pve1', 'qemu', 100, { memory: 6144 }));
  });

  it('(d2) memory dialog: a balloon above the memory disables Save', async () => {
    renderTab();
    const dialog = await openDialog('Edit memory');

    fireEvent.change(within(dialog).getByLabelText('Minimum memory / balloon (MiB)'), { target: { value: '8192' } });
    expect(within(dialog).getByRole('button', { name: 'Save' })).toBeDisabled();
    fireEvent.change(within(dialog).getByLabelText('Minimum memory / balloon (MiB)'), { target: { value: '2048' } });
    expect(within(dialog).getByRole('button', { name: 'Save' })).toBeEnabled();
  });

  it('(e) CD-ROM dialog: lists ISOs from the storage content and sends the chosen one', async () => {
    renderTab();
    const dialog = await openDialog('Edit CD/DVD drive ide2');

    // Only iso-capable storages of this node, ISOs only (no templates/backups, no pve2 entries).
    const option = await within(dialog).findByRole('option', { name: /ubuntu-24.04.1-live-server-amd64.iso/ });
    expect(within(dialog).getAllByRole('option').map((o) => o.getAttribute('value'))).toEqual([
      '',
      'local:iso/debian-12.7.0-amd64-netinst.iso',
      'local:iso/ubuntu-24.04.1-live-server-amd64.iso',
      'local:iso/virtio-win-0.1.240.iso',
    ]);
    expect(within(dialog).getByLabelText('ISO image')).toHaveValue('local:iso/debian-12.7.0-amd64-netinst.iso');

    fireEvent.change(within(dialog).getByLabelText('ISO image'), { target: { value: option.getAttribute('value') } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));

    await waitFor(() =>
      expect(mockUpdateHardware).toHaveBeenCalledWith('pve1', 'qemu', 100, {
        cdrom: { slot: 'ide2', iso: 'local:iso/ubuntu-24.04.1-live-server-amd64.iso' },
      }),
    );
  });

  it('(e2) CD-ROM dialog: "No media" sends iso: null', async () => {
    renderTab();
    const dialog = await openDialog('Edit CD/DVD drive ide2');
    await within(dialog).findByRole('option', { name: /virtio-win/ });

    fireEvent.change(within(dialog).getByLabelText('ISO image'), { target: { value: '' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));

    await waitFor(() =>
      expect(mockUpdateHardware).toHaveBeenCalledWith('pve1', 'qemu', 100, { cdrom: { slot: 'ide2', iso: null } }),
    );
  });

  it('(e3) CD-ROM dialog: an ISO with an upper-case extension is listed and can be sent', async () => {
    addFixtureStorageContent('pve1', 'local', {
      volid: 'local:iso/Win11.ISO',
      content: 'iso',
      format: 'iso',
      size: 5368709120,
    });

    renderTab();
    const dialog = await openDialog('Edit CD/DVD drive ide2');
    await within(dialog).findByRole('option', { name: /Win11\.ISO/ });

    fireEvent.change(within(dialog).getByLabelText('ISO image'), { target: { value: 'local:iso/Win11.ISO' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));

    await waitFor(() =>
      expect(mockUpdateHardware).toHaveBeenCalledWith('pve1', 'qemu', 100, {
        cdrom: { slot: 'ide2', iso: 'local:iso/Win11.ISO' },
      }),
    );
  });

  it('(f) resize dialog: shows the current size and sends the relative grow', async () => {
    renderTab();
    const dialog = await openDialog('Edit disk scsi0');

    expect(within(dialog).getByText('32.0 GiB')).toBeInTheDocument();
    expect(within(dialog).getByText(/Disks can only grow; extend the filesystem inside the guest afterwards/)).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: 'Resize' })).toBeDisabled();

    fireEvent.change(within(dialog).getByLabelText('Add (GiB)'), { target: { value: '10' } });
    expect(within(dialog).getByText('New size: 42 GiB')).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Resize' }));

    await waitFor(() =>
      expect(mockResizeDisk).toHaveBeenCalledWith('pve1', 'qemu', 100, { disk: 'scsi0', size: '+10G' }),
    );
  });

  it('(f2) resize dialog: zero or negative amounts cannot be submitted', async () => {
    renderTab();
    const dialog = await openDialog('Edit disk scsi1');

    for (const value of ['0', '-5', 'abc']) {
      fireEvent.change(within(dialog).getByLabelText('Add (GiB)'), { target: { value } });
      expect(within(dialog).getByRole('button', { name: 'Resize' })).toBeDisabled();
    }
  });

  it('(g) pending changes: the banner lists the keys and the affected rows are badged', async () => {
    mockGetPendingConfig.mockResolvedValue([
      { key: 'memory', value: 4096, pending: 8192 },
      { key: 'cores', value: 4, pending: 8 },
      { key: 'name', value: 'web-prod-01' },
    ]);

    renderTab();
    const banner = await screen.findByTestId('hardware-pending-banner');
    expect(banner).toHaveTextContent('Changes pending a restart: memory, cores');

    const memoryRow = screen.getByText('Memory').closest('tr')!;
    const cpuRow = screen.getByText('Processors').closest('tr')!;
    const biosRow = screen.getByText('BIOS').closest('tr')!;
    expect(within(memoryRow).getByText('pending')).toBeInTheDocument();
    expect(within(cpuRow).getByText('pending')).toBeInTheDocument();
    expect(within(biosRow).queryByText('pending')).not.toBeInTheDocument();
  });

  it('(g2) no pending changes: no banner and no badges', async () => {
    renderTab();
    await screen.findByText('Processors');
    await waitFor(() => expect(mockGetPendingConfig).toHaveBeenCalled());
    expect(screen.queryByTestId('hardware-pending-banner')).not.toBeInTheDocument();
    expect(screen.queryByText('pending')).not.toBeInTheDocument();
  });

  it('(i) lxc: memory dialog edits memory + swap, rootfs resizes, cores edits cores only', async () => {
    renderTab({ node: 'pve2', type: 'lxc', vmid: 200 });

    const memory = await openDialog('Edit memory');
    expect(within(memory).queryByLabelText('Minimum memory / balloon (MiB)')).not.toBeInTheDocument();
    expect(within(memory).getByLabelText('Swap (MiB)')).toHaveValue(512);
    fireEvent.change(within(memory).getByLabelText('Swap (MiB)'), { target: { value: '1024' } });
    fireEvent.click(within(memory).getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(mockUpdateHardware).toHaveBeenCalledWith('pve2', 'lxc', 200, { swap: 1024 }),
    );
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());

    const cores = await openDialog('Edit cores');
    expect(within(cores).queryByLabelText('Sockets')).not.toBeInTheDocument();
    expect(within(cores).queryByLabelText('CPU type')).not.toBeInTheDocument();
    fireEvent.change(within(cores).getByLabelText('Cores'), { target: { value: '4' } });
    fireEvent.click(within(cores).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(mockUpdateHardware).toHaveBeenCalledWith('pve2', 'lxc', 200, { cores: 4 }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());

    const root = await openDialog('Edit disk rootfs');
    fireEvent.change(within(root).getByLabelText('Add (GiB)'), { target: { value: '2' } });
    fireEvent.click(within(root).getByRole('button', { name: 'Resize' }));
    await waitFor(() =>
      expect(mockResizeDisk).toHaveBeenCalledWith('pve2', 'lxc', 200, { disk: 'rootfs', size: '+2G' }),
    );
  });

  it('(j) useResizeDisk clears its delayed re-reads when its owner unmounts', async () => {
    const queryClient = createQueryClient();
    const scheduled: Array<{ id: unknown; delay: number }> = [];
    const realSetTimeout = globalThis.setTimeout;
    const setSpy = vi.spyOn(globalThis, 'setTimeout').mockImplementation(((fn: () => void, delay?: number) => {
      const id = realSetTimeout(fn, delay);
      if (delay === 2000 || delay === 6000) scheduled.push({ id, delay });
      return id;
    }) as typeof setTimeout);
    const clearSpy = vi.spyOn(globalThis, 'clearTimeout');

    const { result, unmount } = renderHook(() => useResizeDisk(), {
      wrapper: ({ children }) => <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>,
    });
    await act(async () => {
      await result.current.mutateAsync({
        node: 'pve1',
        type: 'qemu',
        vmid: 100,
        body: { disk: 'scsi0', size: '+1G' },
      });
    });
    expect(scheduled.map((s) => s.delay)).toEqual([2000, 6000]);

    unmount();
    for (const { id } of scheduled) expect(clearSpy).toHaveBeenCalledWith(id);

    setSpy.mockRestore();
    clearSpy.mockRestore();
  });

  it('(h) fixture mode: after updateHardware the tab shows the new cores value and a pending banner', async () => {
    state.fixtures = true;
    const actual = state.actual!;
    mockUpdateHardware.mockImplementation(actual.updateHardware);
    mockGetPendingConfig.mockImplementation(actual.getPendingConfig);

    renderTab();
    expect(await screen.findByText('1 socket(s) × 4 core(s)')).toBeInTheDocument();

    const dialog = await openDialog('Edit processors');
    fireEvent.change(within(dialog).getByLabelText('Cores'), { target: { value: '8' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));

    expect(await screen.findByText('1 socket(s) × 8 core(s)')).toBeInTheDocument();
    // Guest 100 is running in the fixtures, so the change is held back until a restart.
    expect(await screen.findByTestId('hardware-pending-banner')).toHaveTextContent(
      'Changes pending a restart: cores',
    );
  });
});
