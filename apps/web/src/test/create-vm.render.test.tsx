import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClientProvider, type QueryClient } from '@tanstack/react-query';
import {
  Outlet,
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from '@tanstack/react-router';

import { routeTree } from '@/routeTree.gen';
import { CreateVmDialog } from '@/components/create/CreateVmDialog';
import { createQueryClient } from '@/api/queryClient';
import { TASKS_QUERY_KEY } from '@/api/liveState';
import { GuestActionError } from '@/api/actions';
import { fixtureClient, getFixtureGuestByVmid, getFixtureGuestConfig } from '@/api/fixtures';
import { useCreateStore } from '@/store/createStore';
import type { AuthIdentity } from '@/api/client-types';
import type { CreateVmBody } from '@/api/createVm';
import type { PveTask } from '@/api/types';

/**
 * The Create VM wizard (T61). Lookups (`@/api/create`, bridges, storage formats, CPU models) and the
 * create request are mocked so each test controls the data and asserts the exact request body; only
 * the last tests switch `USE_FIXTURES` on and run the real fixture `createVm`. `useAuthMe` is mocked
 * to switch between a signed-in session and the shared service token. The dialog is rendered inside
 * a small router so the post-create navigation can be asserted.
 */
const GIB = 1024 ** 3;

const mockUseAuthMe = vi.fn();
const mockCreateVm = vi.fn();
const mockGetNextId = vi.fn();
const mockListNodes = vi.fn();
const mockListIsos = vi.fn();
const mockListStorages = vi.fn();
const mockGetBridges = vi.fn();
const mockGetStorageFormats = vi.fn();
const mockToastSuccess = vi.fn();
const mockToastError = vi.fn();

const state = vi.hoisted(() => ({
  fixtures: false,
  actualCreateVm: undefined as typeof import('@/api/createVm') | undefined,
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
  return { ...actual, useAuthMe: () => mockUseAuthMe() };
});

vi.mock('sonner', async () => {
  const actual = await vi.importActual<typeof import('sonner')>('sonner');
  return {
    ...actual,
    toast: {
      success: (...args: unknown[]) => mockToastSuccess(...args),
      error: (...args: unknown[]) => mockToastError(...args),
    },
  };
});

vi.mock('@/api/create', async () => {
  const actual = await vi.importActual<typeof import('@/api/create')>('@/api/create');
  return {
    ...actual,
    getNextId: () => mockGetNextId(),
    listNodes: () => mockListNodes(),
    listIsos: (...args: unknown[]) => mockListIsos(...args),
    listStoragesWithContent: (...args: unknown[]) => mockListStorages(...args),
  };
});

vi.mock('@/api/network', async () => {
  const actual = await vi.importActual<typeof import('@/api/network')>('@/api/network');
  return { ...actual, getBridges: (...args: unknown[]) => mockGetBridges(...args) };
});

vi.mock('@/api/disks', async () => {
  const actual = await vi.importActual<typeof import('@/api/disks')>('@/api/disks');
  return { ...actual, getStorageFormats: (...args: unknown[]) => mockGetStorageFormats(...args) };
});

vi.mock('@/api/hardware', async () => {
  const actual = await vi.importActual<typeof import('@/api/hardware')>('@/api/hardware');
  return { ...actual, getCpuModels: () => Promise.resolve(actual.FALLBACK_CPU_MODELS) };
});

vi.mock('@/api/createVm', async () => {
  const actual = await vi.importActual<typeof import('@/api/createVm')>('@/api/createVm');
  state.actualCreateVm = actual;
  return {
    ...actual,
    // Fixture-mode tests run the real implementation; every other test records the request.
    createVm: (...args: Parameters<typeof actual.createVm>) =>
      state.fixtures ? actual.createVm(...args) : mockCreateVm(...args),
  };
});

const NODES = [
  { name: 'pve1', status: 'online' },
  { name: 'pve2', status: 'online' },
];
const ISO_STORAGES = [{ id: 'local', plugintype: 'dir', freeBytes: 100 * GIB }];
const IMAGE_STORAGES = [
  { id: 'local-zfs', plugintype: 'zfspool', freeBytes: 500 * GIB },
  { id: 'tank', plugintype: 'zfspool', freeBytes: 2000 * GIB },
];
const ISOS = [
  { volid: 'local:iso/debian-12.iso', size: 600 * 1024 ** 2 },
  { volid: 'local:iso/win11.iso', size: 5 * GIB },
  { volid: 'local:iso/ubuntu 24.04.iso', size: 2 * GIB },
  // A name the create route would refuse (`,` would break the ide2 property string).
  { volid: 'local:iso/bad,name.iso', size: 1024 },
];
const BRIDGES = [
  { iface: 'vmbr0', type: 'bridge', active: true },
  { iface: 'vmbr1', type: 'bridge', active: true },
];

function authData(mode: AuthIdentity['mode']) {
  return { data: { username: 'root@pam', realm: 'pam', capabilities: {}, mode } };
}

function renderApp(): { router: ReturnType<typeof createRouter>; queryClient: QueryClient } {
  const queryClient = createQueryClient();
  const rootRoute = createRootRoute({
    component: () => (
      <>
        <CreateVmDialog />
        <Outlet />
      </>
    ),
  });
  const indexRoute = createRoute({ getParentRoute: () => rootRoute, path: '/', component: () => <div>home</div> });
  const vmRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/vm/$node/$type/$vmid',
    validateSearch: (search: Record<string, unknown>) => ({ tab: typeof search.tab === 'string' ? search.tab : undefined }),
    component: () => <div>vm page</div>,
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([indexRoute, vmRoute]),
    history: createMemoryHistory({ initialEntries: ['/'] }),
  });
  render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  return { router: router as unknown as ReturnType<typeof createRouter>, queryClient };
}

/** Renders the app and opens the wizard the way the entry points do. */
async function openWizard(node?: string) {
  const app = renderApp();
  await screen.findByText('home');
  act(() => {
    if (node === undefined) useCreateStore.getState().openCreate('qemu');
    else useCreateStore.getState().openCreate('qemu', node);
  });
  const dialog = await screen.findByTestId('create-vm-dialog');
  return { ...app, dialog };
}

/** Like `openWizard`, but inside the real app shell (inventory tree, Guests page) in fixture mode. */
async function openWizardInShell(node: string) {
  const queryClient = createQueryClient();
  const router = createRouter({ routeTree, history: createMemoryHistory({ initialEntries: ['/guests'] }) });
  render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  await screen.findByRole('heading', { name: 'Guests' }, { timeout: 10_000 });
  act(() => {
    useCreateStore.getState().openCreate('qemu', node);
  });
  await screen.findByTestId('create-vm-dialog');
  return { router };
}

const nextButton = () => screen.getByRole('button', { name: 'Next' });
const clickNext = () => fireEvent.click(nextButton());
const setText = (label: string, value: string) =>
  fireEvent.change(screen.getByLabelText(label), { target: { value } });
const checkbox = (name: string) => screen.getByRole('checkbox', { name });

async function expectStep(name: string) {
  return screen.findByRole('region', { name });
}

/** Moves from the current step to `name` by pressing Next. */
async function advanceTo(name: string) {
  clickNext();
  await expectStep(name);
}

/** Fills the General step with a valid name once the node and next id have loaded. */
async function fillGeneral(name: string) {
  await screen.findByDisplayValue('150');
  setText('Name', name);
}

describe('Create VM wizard', () => {
  beforeEach(() => {
    state.fixtures = false;
    useCreateStore.setState({ open: null });
    mockUseAuthMe.mockReturnValue(authData('session'));
    mockGetNextId.mockResolvedValue(150);
    mockListNodes.mockResolvedValue(NODES);
    mockListStorages.mockImplementation((_node: string, content: string) =>
      Promise.resolve(content === 'iso' ? ISO_STORAGES : content === 'images' ? IMAGE_STORAGES : []),
    );
    mockListIsos.mockResolvedValue(ISOS);
    mockGetBridges.mockResolvedValue(BRIDGES);
    mockGetStorageFormats.mockResolvedValue({});
    mockCreateVm.mockImplementation((_node: string, body: CreateVmBody) =>
      Promise.resolve({ upid: `UPID:pve1:0000ABCD:00000000:00000000:qmcreate:${body.vmid}:root@pam:`, vmid: body.vmid }),
    );
  });

  afterEach(() => {
    vi.clearAllMocks();
    state.fixtures = false;
    useCreateStore.setState({ open: null });
  });

  it('opens from the store with the launching node preselected and the next VM id prefilled', async () => {
    await openWizard('pve2');

    expect(await screen.findByDisplayValue('150')).toBeInTheDocument();
    expect(screen.getByLabelText('Node')).toHaveValue('pve2');
    expect(screen.getByText(/Creates a new VM on pve2/)).toBeInTheDocument();
    expect(await expectStep('General')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Back' })).toBeDisabled();
  });

  it('keeps the prefilled VM id editable', async () => {
    await openWizard('pve1');
    const vmid = await screen.findByLabelText('VM ID');
    await waitFor(() => expect(vmid).toHaveValue('150'));

    fireEvent.change(vmid, { target: { value: '321' } });

    expect(vmid).toHaveValue('321');
  });

  it('picks the first online node when it was opened from the top bar without one', async () => {
    await openWizard();
    await waitFor(() => expect(screen.getByLabelText('Node')).toHaveValue('pve1'));
  });

  it('blocks Next on an invalid name and on an out-of-range VM id, and unblocks when fixed', async () => {
    await openWizard('pve1');
    await fillGeneral('bad_name');

    expect(nextButton()).toBeDisabled();
    expect(screen.getByText(/Use letters, digits and hyphens/)).toBeInTheDocument();

    setText('Name', 'good-name');
    await waitFor(() => expect(nextButton()).toBeEnabled());

    setText('VM ID', '99');
    expect(nextButton()).toBeDisabled();
    expect(screen.getByText(/Enter a whole number between 100/)).toBeInTheDocument();

    setText('VM ID', '150');
    await waitFor(() => expect(nextButton()).toBeEnabled());
  });

  it('lists the ISO images of the first ISO storage on the OS step and requires choosing one', async () => {
    await openWizard('pve1');
    await fillGeneral('web-01');
    await advanceTo('OS');

    expect(await screen.findByRole('option', { name: /debian-12\.iso/ })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: /win11\.iso/ })).toBeInTheDocument();
    expect(screen.getByLabelText('ISO storage')).toHaveValue('local');
    expect(mockListIsos).toHaveBeenCalledWith('pve1', 'local');
    expect(nextButton()).toBeDisabled();

    fireEvent.change(screen.getByLabelText('ISO image'), { target: { value: 'local:iso/debian-12.iso' } });
    await waitFor(() => expect(nextButton()).toBeEnabled());
  });

  it('shows an ISO whose name the create route would refuse as disabled, and keeps Next blocked if it is selected anyway', async () => {
    await openWizard('pve1');
    await fillGeneral('web-01');
    await advanceTo('OS');
    await screen.findByRole('option', { name: /debian-12\.iso/ });

    const bad = screen.getByRole('option', { name: /bad,name\.iso/ });
    expect(bad).toBeDisabled();
    expect(bad).toHaveAttribute('title', "This file name contains characters Proxion can't send to Proxmox");
    for (const good of [/debian-12\.iso/, /win11\.iso/, /ubuntu 24\.04\.iso/]) {
      const option = screen.getByRole('option', { name: good });
      expect(option).toBeEnabled();
      expect(option).not.toHaveAttribute('title');
    }

    // jsdom lets a script select a disabled option; the step must still refuse it.
    fireEvent.change(screen.getByLabelText('ISO image'), { target: { value: 'local:iso/bad,name.iso' } });
    await waitFor(() => expect(nextButton()).toBeDisabled());
    expect(screen.getByRole('alert')).toHaveTextContent("This file name contains characters Proxion can't send to Proxmox");

    fireEvent.change(screen.getByLabelText('ISO image'), { target: { value: 'local:iso/ubuntu 24.04.iso' } });
    await waitFor(() => expect(nextButton()).toBeEnabled());
  });

  it('"Do not use any media" hides the ISO pickers and unblocks Next', async () => {
    await openWizard('pve1');
    await fillGeneral('web-01');
    await advanceTo('OS');
    await screen.findByRole('option', { name: /debian-12\.iso/ });

    fireEvent.click(screen.getByLabelText('Do not use any media'));

    expect(screen.queryByLabelText('ISO image')).not.toBeInTheDocument();
    expect(nextButton()).toBeEnabled();
  });

  it('defaults the guest agent on for Linux and off after choosing Windows', async () => {
    await openWizard('pve1');
    await fillGeneral('web-01');
    await advanceTo('OS');

    expect(checkbox('QEMU guest agent')).toBeChecked();
    fireEvent.change(screen.getByLabelText('Guest OS type'), { target: { value: 'win10' } });
    expect(checkbox('QEMU guest agent')).not.toBeChecked();
  });

  it('OVMF reveals the EFI storage picker, filled from the image-capable storages', async () => {
    await openWizard('pve1');
    await fillGeneral('web-01');
    await advanceTo('OS');
    fireEvent.click(screen.getByLabelText('Do not use any media'));
    await advanceTo('System');

    expect(screen.getByLabelText('Machine')).toHaveValue('q35');
    expect(screen.getByLabelText('BIOS')).toHaveValue('seabios');
    expect(screen.queryByLabelText('EFI storage')).not.toBeInTheDocument();

    fireEvent.change(screen.getByLabelText('BIOS'), { target: { value: 'ovmf' } });

    const efi = await screen.findByLabelText('EFI storage');
    await waitFor(() => expect(efi).toHaveValue('local-zfs'));
    expect(within(efi).getAllByRole('option').map((o) => (o as HTMLOptionElement).value)).toEqual(['local-zfs', 'tank']);
  });

  it('choosing Windows 11 turns the TPM on and shows its storage picker', async () => {
    await openWizard('pve1');
    await fillGeneral('win11-box');
    await advanceTo('OS');
    fireEvent.click(screen.getByLabelText('Do not use any media'));
    fireEvent.change(screen.getByLabelText('Guest OS type'), { target: { value: 'win11' } });
    await advanceTo('System');

    expect(checkbox('Add TPM')).toBeChecked();
    expect(await screen.findByLabelText('TPM storage')).toHaveValue('local-zfs');
    expect(screen.getByText(/Windows 11 needs OVMF/)).toBeInTheDocument();
  });

  it('keeps the TPM off for Linux', async () => {
    await openWizard('pve1');
    await fillGeneral('web-01');
    await advanceTo('OS');
    fireEvent.click(screen.getByLabelText('Do not use any media'));
    await advanceTo('System');

    expect(checkbox('Add TPM')).not.toBeChecked();
    expect(screen.queryByLabelText('TPM storage')).not.toBeInTheDocument();
  });

  it('sends the exact body for a full Linux VM and shows the summary first', async () => {
    await openWizard('pve1');
    await fillGeneral('web-01');
    setText('Resource pool (optional)', 'dev');
    setText('Tags (optional)', 'prod, web');
    fireEvent.click(checkbox('Start after created'));
    await advanceTo('OS');

    await screen.findByRole('option', { name: /debian-12\.iso/ });
    fireEvent.change(screen.getByLabelText('ISO image'), { target: { value: 'local:iso/debian-12.iso' } });
    await advanceTo('System');
    await advanceTo('Disks');

    await waitFor(() => expect(screen.getByLabelText('Storage')).toHaveValue('local-zfs'));
    expect(screen.getByTestId('create-vm-fixed-format')).toHaveTextContent('raw');
    setText('Disk size (GiB)', '64');
    fireEvent.click(checkbox('Discard (TRIM)'));
    fireEvent.click(checkbox('IO thread'));
    fireEvent.change(screen.getByLabelText('Cache'), { target: { value: 'writeback' } });
    await advanceTo('CPU');

    setText('Sockets', '2');
    setText('Cores', '4');
    fireEvent.change(screen.getByLabelText('CPU type'), { target: { value: 'host' } });
    await advanceTo('Memory');

    setText('Memory (MiB)', '4096');
    setText('Minimum memory (MiB, optional)', '1024');
    await advanceTo('Network');

    await waitFor(() => expect(screen.getByLabelText('Bridge')).toHaveValue('vmbr0'));
    setText('VLAN tag (optional)', '20');
    await advanceTo('Confirm');

    const summary = within(screen.getByTestId('create-vm-summary'));
    expect(summary.getByText('web-01')).toBeInTheDocument();
    expect(summary.getByText('local:iso/debian-12.iso')).toBeInTheDocument();
    expect(summary.getByText('scsi0: 64 GiB on local-zfs (discard, iothread, cache writeback)')).toBeInTheDocument();
    expect(summary.getByText('2 sockets x 4 cores, host')).toBeInTheDocument();
    expect(summary.getByText('net0: virtio on vmbr0, VLAN 20, firewall on, MAC automatic')).toBeInTheDocument();
    expect(mockCreateVm).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Create' }));

    await waitFor(() => expect(mockCreateVm).toHaveBeenCalledTimes(1));
    expect(mockCreateVm.mock.calls[0]![0]).toBe('pve1');
    expect(mockCreateVm.mock.calls[0]![1]).toStrictEqual({
      vmid: 150,
      name: 'web-01',
      pool: 'dev',
      tags: ['prod', 'web'],
      start: true,
      os: { media: 'iso', storage: 'local', volid: 'local:iso/debian-12.iso' },
      ostype: 'l26',
      agent: true,
      system: { machine: 'q35', bios: 'seabios', scsihw: 'virtio-scsi-single' },
      disk: { bus: 'scsi', storage: 'local-zfs', sizeGiB: 64, discard: true, iothread: true, cache: 'writeback' },
      cpu: { sockets: 2, cores: 4, type: 'host' },
      memory: { memoryMiB: 4096, balloonMiB: 1024 },
      net: { model: 'virtio', bridge: 'vmbr0', tag: 20, firewall: true },
    });
  });

  it('sends the exact body for a Windows 11 VM with OVMF, an EFI disk and a TPM', async () => {
    await openWizard('pve1');
    await fillGeneral('win11-box');
    await advanceTo('OS');
    await screen.findByRole('option', { name: /win11\.iso/ });
    fireEvent.change(screen.getByLabelText('ISO image'), { target: { value: 'local:iso/win11.iso' } });
    fireEvent.change(screen.getByLabelText('Guest OS type'), { target: { value: 'win11' } });
    await advanceTo('System');
    fireEvent.change(screen.getByLabelText('BIOS'), { target: { value: 'ovmf' } });
    await waitFor(() => expect(screen.getByLabelText('EFI storage')).toHaveValue('local-zfs'));
    fireEvent.change(screen.getByLabelText('TPM storage'), { target: { value: 'tank' } });
    fireEvent.change(screen.getByLabelText('Display'), { target: { value: 'std' } });
    await advanceTo('Disks');
    await advanceTo('CPU');
    await advanceTo('Memory');
    await advanceTo('Network');
    await advanceTo('Confirm');
    fireEvent.click(screen.getByRole('button', { name: 'Create' }));

    await waitFor(() => expect(mockCreateVm).toHaveBeenCalledTimes(1));
    expect(mockCreateVm.mock.calls[0]![1]).toStrictEqual({
      vmid: 150,
      name: 'win11-box',
      start: false,
      os: { media: 'iso', storage: 'local', volid: 'local:iso/win11.iso' },
      ostype: 'win11',
      agent: false,
      system: {
        machine: 'q35',
        bios: 'ovmf',
        efiStorage: 'local-zfs',
        tpm: true,
        tpmStorage: 'tank',
        scsihw: 'virtio-scsi-single',
        vga: 'std',
      },
      disk: { bus: 'scsi', storage: 'local-zfs', sizeGiB: 32 },
      cpu: { sockets: 1, cores: 2, type: 'x86-64-v2-AES' },
      memory: { memoryMiB: 2048 },
      net: { model: 'virtio', bridge: 'vmbr0', firewall: true },
    });
  });

  it('sends the exact body for "no media, no disk, no network"', async () => {
    await openWizard('pve1');
    await fillGeneral('bare');
    await advanceTo('OS');
    fireEvent.click(screen.getByLabelText('Do not use any media'));
    await advanceTo('System');
    await advanceTo('Disks');
    fireEvent.click(checkbox('No disk'));
    expect(screen.queryByLabelText('Disk size (GiB)')).not.toBeInTheDocument();
    await advanceTo('CPU');
    await advanceTo('Memory');
    await advanceTo('Network');
    fireEvent.click(checkbox('No network device'));
    expect(screen.queryByLabelText('Bridge')).not.toBeInTheDocument();
    await advanceTo('Confirm');

    const summary = within(screen.getByTestId('create-vm-summary'));
    expect(summary.getAllByText('None')).toHaveLength(3);
    fireEvent.click(screen.getByRole('button', { name: 'Create' }));

    await waitFor(() => expect(mockCreateVm).toHaveBeenCalledTimes(1));
    expect(mockCreateVm.mock.calls[0]![1]).toStrictEqual({
      vmid: 150,
      name: 'bare',
      start: false,
      os: { media: 'none' },
      ostype: 'l26',
      agent: true,
      system: { machine: 'q35', bios: 'seabios', scsihw: 'virtio-scsi-single' },
      disk: null,
      cpu: { sockets: 1, cores: 2, type: 'x86-64-v2-AES' },
      memory: { memoryMiB: 2048 },
      net: null,
    });
  });

  /** Opens the Disks step of a media-less VM, runs `setup` there, then creates and returns the disk. */
  async function createWithDisk(setup: () => void): Promise<CreateVmBody['disk']> {
    await openWizard('pve1');
    await fillGeneral('bus-test');
    await advanceTo('OS');
    fireEvent.click(screen.getByLabelText('Do not use any media'));
    await advanceTo('System');
    await advanceTo('Disks');
    await waitFor(() => expect(screen.getByLabelText('Storage')).toHaveValue('local-zfs'));
    setup();
    await advanceTo('CPU');
    await advanceTo('Memory');
    await advanceTo('Network');
    await advanceTo('Confirm');
    fireEvent.click(screen.getByRole('button', { name: 'Create' }));
    await waitFor(() => expect(mockCreateVm).toHaveBeenCalledTimes(1));
    return (mockCreateVm.mock.calls[0]![1] as CreateVmBody).disk;
  }

  it('drops ssd from the request once the bus is switched to virtio (which has no ssd option)', async () => {
    const disk = await createWithDisk(() => {
      fireEvent.click(checkbox('SSD emulation'));
      fireEvent.change(screen.getByLabelText('Bus'), { target: { value: 'virtio' } });
      expect(screen.queryByRole('checkbox', { name: 'SSD emulation' })).not.toBeInTheDocument();
    });
    expect(disk).toStrictEqual({ bus: 'virtio', storage: 'local-zfs', sizeGiB: 32 });
  });

  it('drops iothread from the request once the bus is switched to sata (ssd stays, sata supports it)', async () => {
    const disk = await createWithDisk(() => {
      fireEvent.click(checkbox('SSD emulation'));
      fireEvent.click(checkbox('IO thread'));
      fireEvent.change(screen.getByLabelText('Bus'), { target: { value: 'sata' } });
      expect(screen.queryByRole('checkbox', { name: 'IO thread' })).not.toBeInTheDocument();
    });
    expect(disk).toStrictEqual({ bus: 'sata', storage: 'local-zfs', sizeGiB: 32, ssd: true });
  });

  it('Back keeps what was entered', async () => {
    await openWizard('pve1');
    await fillGeneral('keeper');
    await advanceTo('OS');

    fireEvent.click(screen.getByRole('button', { name: 'Back' }));

    await expectStep('General');
    expect(screen.getByLabelText('Name')).toHaveValue('keeper');
  });

  it('lets the step list jump back but not ahead of an incomplete step', async () => {
    await openWizard('pve1');
    await fillGeneral('keeper');
    await advanceTo('OS');
    const steps = within(screen.getByRole('navigation', { name: 'Create VM steps' }));

    expect(steps.getByRole('button', { name: /General$/ })).toBeEnabled();
    // The OS step is incomplete (no ISO chosen yet), so nothing after it can be jumped to.
    expect(steps.getByRole('button', { name: /Confirm$/ })).toBeDisabled();
    fireEvent.click(steps.getByRole('button', { name: /General$/ }));
    await expectStep('General');
  });

  it('shows a read-only notice and disables Create in token mode', async () => {
    mockUseAuthMe.mockReturnValue(authData('token'));
    await openWizard('pve1');
    await fillGeneral('web-01');
    await advanceTo('OS');
    fireEvent.click(screen.getByLabelText('Do not use any media'));
    await advanceTo('System');
    await advanceTo('Disks');
    await advanceTo('CPU');
    await advanceTo('Memory');
    await advanceTo('Network');
    await waitFor(() => expect(screen.getByLabelText('Bridge')).toHaveValue('vmbr0'));
    await advanceTo('Confirm');

    expect(screen.getByRole('status')).toHaveTextContent('Read-only: signed in with a service token');
    const create = screen.getByRole('button', { name: 'Create' });
    expect(create).toBeDisabled();
    expect(create).toHaveAttribute('title', 'Read-only: signed in with a service token');
    fireEvent.click(create);
    expect(mockCreateVm).not.toHaveBeenCalled();
  });

  it('shows the server error inline and stays open', async () => {
    mockCreateVm.mockRejectedValue(new GuestActionError(409, 'VM ID 150 is already in use'));
    await openWizard('pve1');
    await fillGeneral('web-01');
    await advanceTo('OS');
    fireEvent.click(screen.getByLabelText('Do not use any media'));
    await advanceTo('System');
    await advanceTo('Disks');
    await advanceTo('CPU');
    await advanceTo('Memory');
    await advanceTo('Network');
    await advanceTo('Confirm');
    fireEvent.click(screen.getByRole('button', { name: 'Create' }));

    expect(await screen.findByText('VM ID 150 is already in use')).toBeInTheDocument();
    expect(screen.getByTestId('create-vm-dialog')).toBeInTheDocument();
    expect(useCreateStore.getState().open).toEqual({ kind: 'qemu', node: 'pve1' });
    expect(mockToastSuccess).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Create' })).toBeEnabled();
  });

  it('on success closes the wizard, toasts, and navigates to the new VM only after the task finishes', async () => {
    const { router, queryClient } = await openWizard('pve1');
    await fillGeneral('web-01');
    await advanceTo('OS');
    fireEvent.click(screen.getByLabelText('Do not use any media'));
    await advanceTo('System');
    await advanceTo('Disks');
    await advanceTo('CPU');
    await advanceTo('Memory');
    await advanceTo('Network');
    await advanceTo('Confirm');
    fireEvent.click(screen.getByRole('button', { name: 'Create' }));

    await waitFor(() => expect(mockToastSuccess).toHaveBeenCalledWith('Creating VM 150…'));
    await waitFor(() => expect(screen.queryByTestId('create-vm-dialog')).not.toBeInTheDocument());
    expect(useCreateStore.getState().open).toBeNull();
    expect(router.state.location.pathname).toBe('/');
    expect(mockToastSuccess).not.toHaveBeenCalledWith('VM 150 created');

    const upid = 'UPID:pve1:0000ABCD:00000000:00000000:qmcreate:150:root@pam:';
    const finished: PveTask = {
      upid,
      node: 'pve1',
      pid: 1,
      pstart: 1,
      starttime: 1,
      type: 'qmcreate',
      id: '150',
      user: 'root@pam',
      endtime: 2,
      status: 'OK',
    };
    act(() => {
      queryClient.setQueryData(TASKS_QUERY_KEY, [finished]);
    });

    await waitFor(() => expect(router.state.location.pathname).toBe('/vm/pve1/qemu/150'));
    expect(router.state.location.search).toEqual({ tab: 'summary' });
    expect(mockToastSuccess).toHaveBeenCalledWith('VM 150 created');
  });

  it('toasts the task error instead of navigating when the create task fails', async () => {
    const { router, queryClient } = await openWizard('pve1');
    await fillGeneral('web-01');
    await advanceTo('OS');
    fireEvent.click(screen.getByLabelText('Do not use any media'));
    await advanceTo('System');
    await advanceTo('Disks');
    await advanceTo('CPU');
    await advanceTo('Memory');
    await advanceTo('Network');
    await advanceTo('Confirm');
    fireEvent.click(screen.getByRole('button', { name: 'Create' }));
    await waitFor(() => expect(mockToastSuccess).toHaveBeenCalledWith('Creating VM 150…'));

    const failed: PveTask = {
      upid: 'UPID:pve1:0000ABCD:00000000:00000000:qmcreate:150:root@pam:',
      node: 'pve1',
      pid: 1,
      pstart: 1,
      starttime: 1,
      type: 'qmcreate',
      id: '150',
      user: 'root@pam',
      endtime: 2,
      status: 'unable to create VM 150: storage is full',
    };
    act(() => {
      queryClient.setQueryData(TASKS_QUERY_KEY, [failed]);
    });

    await waitFor(() =>
      expect(mockToastError).toHaveBeenCalledWith('VM 150 could not be created: unable to create VM 150: storage is full'),
    );
    expect(router.state.location.pathname).toBe('/');
  });

  it('fixture round trip: the new guest appears in the cluster list, with its composed config, and the app navigates to it', async () => {
    state.fixtures = true;
    const { router } = await openWizardInShell('pve1');
    await fillGeneral('demo-vm');
    await advanceTo('OS');
    await screen.findByRole('option', { name: /debian-12\.iso/ });
    fireEvent.change(screen.getByLabelText('ISO image'), { target: { value: 'local:iso/debian-12.iso' } });
    await advanceTo('System');
    await advanceTo('Disks');
    await waitFor(() => expect(screen.getByLabelText('Storage')).toHaveValue('local-zfs'));
    await advanceTo('CPU');
    await advanceTo('Memory');
    await advanceTo('Network');
    await waitFor(() => expect(screen.getByLabelText('Bridge')).toHaveValue('vmbr0'));
    await advanceTo('Confirm');

    expect(getFixtureGuestByVmid(150)).toBeUndefined();
    fireEvent.click(screen.getByRole('button', { name: 'Create' }));

    await waitFor(() => expect(router.state.location.pathname).toBe('/vm/pve1/qemu/150'));
    expect(mockCreateVm).not.toHaveBeenCalled();

    const created = getFixtureGuestByVmid(150);
    expect(created).toMatchObject({
      type: 'qemu',
      node: 'pve1',
      vmid: 150,
      name: 'demo-vm',
      status: 'stopped',
      maxcpu: 2,
      maxmem: 2048 * 1024 ** 2,
      maxdisk: 32 * GIB,
    });
    const listed = await fixtureClient.getClusterResources();
    expect(listed.some((r) => r.type === 'qemu' && r.vmid === 150 && r.name === 'demo-vm')).toBe(true);

    const config = getFixtureGuestConfig(150);
    expect(config).toMatchObject({
      name: 'demo-vm',
      ostype: 'l26',
      machine: 'q35',
      bios: 'seabios',
      scsihw: 'virtio-scsi-single',
      agent: 'enabled=1',
      cores: 2,
      sockets: 1,
      cpu: 'x86-64-v2-AES',
      memory: 2048,
      scsi0: 'local-zfs:vm-150-disk-2,size=32G',
      ide2: 'local:iso/debian-12.iso,media=cdrom',
      boot: 'order=scsi0;ide2;net0',
    });
    expect(config?.net0).toMatch(/^virtio=BC:24:11:[0-9A-F]{2}:[0-9A-F]{2}:[0-9A-F]{2},bridge=vmbr0,firewall=1$/);
    expect(mockToastSuccess).toHaveBeenCalledWith('VM 150 created');

    // The UI shows it: the inventory rail lists the new VM, and so does the Guests table.
    expect(await screen.findAllByText('demo-vm', {}, { timeout: 10_000 })).not.toHaveLength(0);
    await act(async () => {
      await router.navigate({ to: '/guests' });
    });
    const table = await screen.findByRole('table', {}, { timeout: 10_000 });
    const row = (await within(table).findByText('demo-vm', {}, { timeout: 10_000 })).closest('tr')!;
    expect(within(row).getByText('150')).toBeInTheDocument();
  });

  it('fixture mode rejects a VM id that is already taken', async () => {
    const actual = state.actualCreateVm!;
    state.fixtures = true;
    const body: CreateVmBody = {
      vmid: 100,
      name: 'dupe',
      start: false,
      os: { media: 'none' },
      ostype: 'l26',
      agent: false,
      system: { machine: 'q35', bios: 'seabios', scsihw: 'virtio-scsi-single' },
      disk: null,
      cpu: { sockets: 1, cores: 1, type: 'host' },
      memory: { memoryMiB: 512 },
      net: null,
    };

    await expect(actual.createVm('pve1', body)).rejects.toMatchObject({ status: 409 });
  });

  it('composeCreateVmConfig mirrors the server composition for a full body', () => {
    const actual = state.actualCreateVm!;
    const body: CreateVmBody = {
      vmid: 105,
      name: 'win11-test',
      tags: ['prod', 'web'],
      start: true,
      os: { media: 'iso', storage: 'local', volid: 'local:iso/win11.iso' },
      ostype: 'win11',
      agent: true,
      system: {
        machine: 'q35',
        bios: 'ovmf',
        efiStorage: 'local-zfs',
        tpm: true,
        tpmStorage: 'local-zfs',
        scsihw: 'virtio-scsi-single',
        vga: 'std',
      },
      disk: { bus: 'scsi', storage: 'local-zfs', sizeGiB: 64, format: 'raw', discard: true, ssd: true, iothread: true, cache: 'none' },
      cpu: { sockets: 1, cores: 4, type: 'host', numa: true },
      memory: { memoryMiB: 8192, balloonMiB: 2048 },
      net: { model: 'virtio', bridge: 'vmbr0', tag: 20, firewall: true, macaddr: 'BC:24:11:64:00:01', mtu: 1500 },
    };

    expect(actual.composeCreateVmConfig(body)).toStrictEqual({
      name: 'win11-test',
      ostype: 'win11',
      bios: 'ovmf',
      scsihw: 'virtio-scsi-single',
      cores: 4,
      sockets: 1,
      cpu: 'host',
      memory: 8192,
      machine: 'q35',
      agent: 'enabled=1',
      numa: 1,
      balloon: 2048,
      vga: 'std',
      tags: 'prod;web',
      efidisk0: 'local-zfs:vm-105-disk-0,efitype=4m,pre-enrolled-keys=1,size=4M',
      tpmstate0: 'local-zfs:vm-105-disk-1,size=4M,version=v2.0',
      scsi0: 'local-zfs:vm-105-disk-2,format=raw,discard=on,ssd=1,iothread=1,cache=none,size=64G',
      ide2: 'local:iso/win11.iso,media=cdrom',
      net0: 'virtio=BC:24:11:64:00:01,bridge=vmbr0,tag=20,firewall=1,mtu=1500',
      boot: 'order=scsi0;ide2;net0',
    });
  });
});
