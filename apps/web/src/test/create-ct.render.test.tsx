import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClientProvider } from '@tanstack/react-query';
import {
  Outlet,
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from '@tanstack/react-router';

import { CreateCtDialog } from '@/components/create/CreateCtDialog';
import { createQueryClient } from '@/api/queryClient';
import { GuestActionError } from '@/api/actions';
import { getFixtureGuestByVmid, getFixtureGuestConfig, getFixtureNextId, removeFixtureGuest } from '@/api/fixtures';
import { useCreateStore } from '@/store/createStore';
import type { AuthIdentity } from '@/api/client-types';
import type { GuestPermissions } from '@/api/actionHooks';

/**
 * The Create CT wizard (T62): eight steps in a dialog, one `POST .../lxc/create`. `useAuthMe` and
 * the two permission hooks are mocked so each test controls the gate; `USE_FIXTURES` is a getter so
 * the same file runs both the session/token gating (real mode, with the reads and `createCt` mocked
 * so the exact request can be asserted) and the fixture round trip (real fixture reads and writes).
 * A tiny code-built router stands in for the app shell: the dialog is mounted next to an outlet, and
 * the new container's route is a marker page.
 */
const mockUseAuthMe = vi.fn();
const mockUsePermissions = vi.fn();
const mockUseStoragePermissions = vi.fn();
const mockCreateCt = vi.fn();
const mockGetNextId = vi.fn();
const mockListNodes = vi.fn();
const mockListStorages = vi.fn();
const mockListTemplates = vi.fn();
const mockGetBridges = vi.fn();

const state = vi.hoisted(() => ({ fixtures: false }));

// Test-only literal: it exists to prove the password never reaches a request log or a fixture.
const PASSWORD = 'Sup3r-S3cret-Pa55word!';
const KEY_ED = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl admin@lab';
const DEBIAN = 'local:vztmpl/debian-12-standard_12.7-1_amd64.tar.zst';
const UBUNTU = 'local:vztmpl/ubuntu-24.04-standard_24.04-2_amd64.tar.zst';
const FIND_TIMEOUT_MS = 5000;

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
  return {
    ...actual,
    usePermissions: (vmid: number) => mockUsePermissions(vmid),
    useStoragePermissions: (storage: string) => mockUseStoragePermissions(storage),
  };
});

// Fixture mode reads the bundled fixtures; real mode answers from the mocks below.
vi.mock('@/api/create', async () => {
  const actual = await vi.importActual<typeof import('@/api/create')>('@/api/create');
  return {
    ...actual,
    getNextId: () => (state.fixtures ? actual.getNextId() : mockGetNextId()),
    listNodes: () => (state.fixtures ? actual.listNodes() : mockListNodes()),
    listStoragesWithContent: (node: string, content: Parameters<typeof actual.listStoragesWithContent>[1]) =>
      state.fixtures ? actual.listStoragesWithContent(node, content) : mockListStorages(node, content),
    listContainerTemplates: (node: string, storage: string) =>
      state.fixtures ? actual.listContainerTemplates(node, storage) : mockListTemplates(node, storage),
  };
});

vi.mock('@/api/network', async () => {
  const actual = await vi.importActual<typeof import('@/api/network')>('@/api/network');
  return { ...actual, getBridges: (node: string) => (state.fixtures ? actual.getBridges(node) : mockGetBridges(node)) };
});

vi.mock('@/api/createCt', async () => {
  const actual = await vi.importActual<typeof import('@/api/createCt')>('@/api/createCt');
  return {
    ...actual,
    createCt: (node: string, body: Parameters<typeof actual.createCt>[1]) =>
      state.fixtures ? actual.createCt(node, body) : mockCreateCt(node, body),
  };
});

function authData(mode: AuthIdentity['mode']) {
  return { data: { username: 'root@pam', realm: 'pam', capabilities: {}, mode } };
}

function permissionsData(privs: Record<string, boolean> | true) {
  const value: GuestPermissions = { can: (p: string) => privs === true || privs[p] === true };
  return { data: value };
}

const GIB = 1024 * 1024 * 1024;
const BRIDGES = [
  { iface: 'vmbr0', type: 'bridge', active: true },
  { iface: 'vmbr1', type: 'bridge', active: true, comments: 'Storage network' },
];

let router: ReturnType<typeof makeRouter>;

function makeRouter() {
  const rootRoute = createRootRoute({
    component: () => (
      <>
        <Outlet />
        <CreateCtDialog />
      </>
    ),
  });
  const indexRoute = createRoute({ getParentRoute: () => rootRoute, path: '/', component: () => <p>home</p> });
  const vmRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/vm/$node/$type/$vmid',
    component: () => <p data-testid="vm-page">container page</p>,
  });
  return createRouter({
    routeTree: rootRoute.addChildren([indexRoute, vmRoute]),
    history: createMemoryHistory({ initialEntries: ['/'] }),
  });
}

async function openWizard(node: string | undefined = 'pve1') {
  useCreateStore.setState({ open: node === undefined ? { kind: 'lxc' } : { kind: 'lxc', node } });
  router = makeRouter();
  render(
    <QueryClientProvider client={createQueryClient()}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  return screen.findByTestId('create-ct-dialog', {}, { timeout: FIND_TIMEOUT_MS });
}

function typeInto(label: string, value: string) {
  fireEvent.change(screen.getByLabelText(label), { target: { value } });
}

function nextButton() {
  return screen.getByRole('button', { name: 'Next' });
}

async function goNext() {
  await waitFor(() => expect(nextButton()).toBeEnabled());
  fireEvent.click(nextButton());
}

async function onStep(name: string) {
  await screen.findByRole('heading', { name, level: 3 }, { timeout: FIND_TIMEOUT_MS });
}

/** Fills the General step with a hostname and the test password (CT ID is prefilled). */
async function fillGeneral(over: { hostname?: string; password?: string; confirm?: string; keys?: string } = {}) {
  await waitFor(() => expect(screen.getByLabelText('CT ID')).not.toHaveValue(''));
  typeInto('Hostname', over.hostname ?? 'web01');
  const password = over.password ?? PASSWORD;
  if (password !== '') typeInto('Password', password);
  const confirm = over.confirm ?? password;
  if (confirm !== '') typeInto('Confirm password', confirm);
  if (over.keys !== undefined) typeInto('SSH public keys', over.keys);
}

async function pickTemplate(volid: string) {
  await onStep('Template');
  await waitFor(() => expect(screen.getByLabelText('Storage')).toHaveValue('local'));
  await screen.findByRole('option', { name: /debian-12/ });
  fireEvent.change(screen.getByLabelText('Template'), { target: { value: volid } });
}

/** Walks from the filled General step to the Network step with the defaults of every step between. */
async function toNetworkStep() {
  await goNext();
  await pickTemplate(DEBIAN);
  await goNext();
  await onStep('Disks');
  await waitFor(() => expect(screen.getByLabelText('Storage')).toHaveValue('local-lvm'));
  await goNext();
  await onStep('CPU');
  await goNext();
  await onStep('Memory');
  await goNext();
  await onStep('Network');
  await waitFor(() => expect(screen.getByLabelText('Bridge')).toHaveValue('vmbr0'));
}

async function toConfirmStep() {
  await goNext(); // Network -> DNS
  await onStep('DNS');
  await goNext();
  await onStep('Confirm');
}

describe('Create CT wizard', () => {
  beforeEach(() => {
    state.fixtures = false;
    useCreateStore.setState({ open: null });
    mockUseAuthMe.mockReturnValue(authData('session'));
    mockUsePermissions.mockReturnValue(permissionsData(true));
    mockUseStoragePermissions.mockReturnValue(permissionsData(true));
    mockGetNextId.mockResolvedValue(150);
    mockListNodes.mockResolvedValue([
      { name: 'pve1', status: 'online' },
      { name: 'pve2', status: 'online' },
    ]);
    mockListStorages.mockImplementation((_node: string, content: string) =>
      Promise.resolve(content === 'vztmpl' ? [{ id: 'local' }] : [{ id: 'local-lvm', freeBytes: 50 * GIB }, { id: 'tank' }]),
    );
    mockListTemplates.mockResolvedValue([
      { volid: UBUNTU, size: 150 * 1024 * 1024 },
      { volid: DEBIAN, size: 120 * 1024 * 1024 },
    ]);
    mockGetBridges.mockResolvedValue(BRIDGES);
    mockCreateCt.mockResolvedValue({ upid: 'UPID:pve1:00000001:00000000:00000000:vzcreate:150:root@pam:', vmid: 150 });
  });

  afterEach(() => {
    cleanup();
    state.fixtures = false;
    // The fixture round trip adds a container to the shared in-memory fixtures.
    removeFixtureGuest('pve1', 'lxc', 306);
    useCreateStore.setState({ open: null });
    vi.clearAllMocks();
  });

  it('(a) preselects the node the wizard was opened from and shows it in the header', async () => {
    const dialog = await openWizard('pve1');
    expect(within(dialog).getByText('Create container')).toBeInTheDocument();
    await waitFor(() => expect(screen.getByLabelText('Node')).toHaveValue('pve1'));
    expect(within(dialog).getByText('Node: pve1')).toBeInTheDocument();
  });

  it('(a2) opened without a node, it picks the first node of the cluster', async () => {
    await openWizard(undefined);
    await waitFor(() => expect(screen.getByLabelText('Node')).toHaveValue('pve1'));
  });

  it('(b) prefills the CT ID with the next free id', async () => {
    await openWizard();
    await waitFor(() => expect(screen.getByLabelText('CT ID')).toHaveValue('150'));
  });

  it('(c) a password mismatch blocks Next until the two match', async () => {
    await openWizard();
    await fillGeneral({ confirm: `${PASSWORD}x` });
    expect(screen.getByText('The passwords do not match.')).toBeInTheDocument();
    expect(nextButton()).toBeDisabled();

    typeInto('Confirm password', PASSWORD);
    expect(screen.queryByText('The passwords do not match.')).not.toBeInTheDocument();
    expect(nextButton()).toBeEnabled();
  });

  it('(c2) needs a root password or an SSH key, and a bad hostname or key is flagged', async () => {
    await openWizard();
    await fillGeneral({ password: '', confirm: '' });
    expect(nextButton()).toBeDisabled();
    expect(screen.getByText(/Set a root password or add an SSH public key/)).toBeInTheDocument();

    typeInto('SSH public keys', 'not a key');
    expect(screen.getByText('Enter OpenSSH public keys, one per line.')).toBeInTheDocument();
    expect(nextButton()).toBeDisabled();

    typeInto('SSH public keys', KEY_ED);
    expect(nextButton()).toBeEnabled();

    typeInto('Hostname', 'bad host name');
    expect(screen.getByText('Use letters, digits and hyphens; dots separate labels.')).toBeInTheDocument();
    expect(nextButton()).toBeDisabled();
  });

  it('(d) the Template step lists the templates of the storage, sorted by name, and needs one', async () => {
    await openWizard();
    await fillGeneral();
    await goNext();
    await onStep('Template');
    await screen.findByRole('option', { name: /debian-12/ });

    const options = within(screen.getByLabelText('Template')).getAllByRole('option');
    expect(options.map((o) => o.textContent)).toStrictEqual([
      'Select a template...',
      'debian-12-standard_12.7-1_amd64.tar.zst (120.0 MiB)',
      'ubuntu-24.04-standard_24.04-2_amd64.tar.zst (150.0 MiB)',
    ]);
    expect(nextButton()).toBeDisabled();
    fireEvent.change(screen.getByLabelText('Template'), { target: { value: DEBIAN } });
    expect(nextButton()).toBeEnabled();
  });

  it('(d2) a disk size out of range blocks Next on the Disks step', async () => {
    await openWizard();
    await fillGeneral();
    await goNext();
    await pickTemplate(DEBIAN);
    await goNext();
    await onStep('Disks');
    await waitFor(() => expect(screen.getByLabelText('Storage')).toHaveValue('local-lvm'));
    expect(screen.getByRole('option', { name: 'local-lvm (50.0 GiB free)' })).toBeInTheDocument();
    typeInto('Disk size (GiB)', '0');
    expect(screen.getByText('The size must be 1 to 65536 GiB.')).toBeInTheDocument();
    expect(nextButton()).toBeDisabled();
    typeInto('Disk size (GiB)', '8');
    expect(nextButton()).toBeEnabled();
  });

  it('(e) sends the exact body for a default DHCP container', async () => {
    await openWizard();
    await fillGeneral();
    await toNetworkStep();
    await toConfirmStep();

    const summary = within(screen.getByTestId('ct-summary'));
    expect(summary.getByText('••••••')).toBeInTheDocument();
    expect(screen.queryByText(PASSWORD)).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Create' }));
    await waitFor(() => expect(mockCreateCt).toHaveBeenCalledTimes(1));
    expect(mockCreateCt.mock.calls[0]![0]).toBe('pve1');
    expect(mockCreateCt.mock.calls[0]![1]).toStrictEqual({
      vmid: 150,
      hostname: 'web01',
      start: false,
      unprivileged: true,
      nesting: true,
      password: PASSWORD,
      template: { storage: 'local', volid: DEBIAN },
      rootfs: { storage: 'local-lvm', sizeGiB: 8 },
      cpu: { cores: 1 },
      memory: { memoryMiB: 512, swapMiB: 512 },
      net: { name: 'eth0', bridge: 'vmbr0', ip: 'dhcp', firewall: true },
    });
    // Success closes the dialog.
    await waitFor(() => expect(screen.queryByTestId('create-ct-dialog')).not.toBeInTheDocument());
    expect(useCreateStore.getState().open).toBeNull();
  });

  it('(f) sends the exact body for a static IP with DNS, SSH keys and the advanced options', async () => {
    await openWizard();
    await fillGeneral({ password: '', keys: KEY_ED });
    typeInto('Resource pool', 'lab');
    typeInto('Tags', 'prod, web');
    fireEvent.click(screen.getByLabelText('Unprivileged container'));
    fireEvent.click(screen.getByLabelText('Nesting'));
    fireEvent.click(screen.getByLabelText('Start after created'));

    await goNext();
    await pickTemplate(UBUNTU);
    await goNext();
    await onStep('Disks');
    await waitFor(() => expect(screen.getByLabelText('Storage')).toHaveValue('local-lvm'));
    typeInto('Disk size (GiB)', '32');
    fireEvent.click(screen.getByLabelText('ACL'));
    fireEvent.click(screen.getByLabelText('Quota'));
    await goNext();
    await onStep('CPU');
    typeInto('Cores', '4');
    typeInto('CPU limit', '1.5');
    typeInto('CPU units', '2048');
    await goNext();
    await onStep('Memory');
    typeInto('Memory (MiB)', '2048');
    typeInto('Swap (MiB)', '0');
    await goNext();
    await onStep('Network');
    await waitFor(() => expect(screen.getByLabelText('Bridge')).toHaveValue('vmbr0'));
    fireEvent.change(screen.getByLabelText('Bridge'), { target: { value: 'vmbr1' } });
    fireEvent.change(screen.getByLabelText('IPv4'), { target: { value: 'static' } });
    expect(nextButton()).toBeDisabled();
    typeInto('IPv4 address (CIDR)', '10.0.0.5/24');
    typeInto('IPv4 gateway', '10.0.0.1');
    fireEvent.change(screen.getByLabelText('IPv6'), { target: { value: 'auto' } });
    typeInto('VLAN tag', '20');
    fireEvent.click(screen.getByLabelText('Firewall'));
    await goNext();
    await onStep('DNS');
    typeInto('DNS domain', 'lab.example.com');
    typeInto('DNS servers', '1.1.1.1, 9.9.9.9');
    await goNext();
    await onStep('Confirm');

    fireEvent.click(screen.getByRole('button', { name: 'Create' }));
    await waitFor(() => expect(mockCreateCt).toHaveBeenCalledTimes(1));
    expect(mockCreateCt.mock.calls[0]![1]).toStrictEqual({
      vmid: 150,
      hostname: 'web01',
      pool: 'lab',
      tags: ['prod', 'web'],
      start: true,
      unprivileged: false,
      nesting: false,
      sshKeys: [KEY_ED],
      template: { storage: 'local', volid: UBUNTU },
      rootfs: { storage: 'local-lvm', sizeGiB: 32, acl: true, quota: true },
      cpu: { cores: 4, cpulimit: 1.5, cpuunits: 2048 },
      memory: { memoryMiB: 2048, swapMiB: 0 },
      net: {
        name: 'eth0',
        bridge: 'vmbr1',
        ip: '10.0.0.5/24',
        gw: '10.0.0.1',
        ip6: 'auto',
        tag: 20,
        firewall: false,
      },
      dns: { nameserver: ['1.1.1.1', '9.9.9.9'], searchdomain: 'lab.example.com' },
    });
  });

  it('(g) "No network device" sends net: null and skips the NIC validation', async () => {
    await openWizard();
    await fillGeneral();
    await toNetworkStep();
    fireEvent.change(screen.getByLabelText('IPv4'), { target: { value: 'static' } });
    expect(nextButton()).toBeDisabled();
    fireEvent.click(screen.getByLabelText('No network device'));
    expect(screen.getByLabelText('Bridge')).toBeDisabled();
    expect(nextButton()).toBeEnabled();
    await toConfirmStep();
    expect(within(screen.getByTestId('ct-summary')).getByText('No network device')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Create' }));
    await waitFor(() => expect(mockCreateCt).toHaveBeenCalledTimes(1));
    const body = mockCreateCt.mock.calls[0]![1] as { net: unknown; dns?: unknown };
    expect(body.net).toBeNull();
    expect(body).not.toHaveProperty('dns');
  });

  it('(h) Back keeps what was entered, and the rail jumps back to an earlier step', async () => {
    await openWizard();
    await fillGeneral({ hostname: 'kept-host' });
    await goNext();
    await pickTemplate(DEBIAN);
    fireEvent.click(screen.getByRole('button', { name: 'Back' }));
    await onStep('General');
    expect(screen.getByLabelText('Hostname')).toHaveValue('kept-host');
    expect(screen.getByLabelText('Password')).toHaveValue(PASSWORD);
    // A later step stays out of reach while an earlier one is incomplete (the template is picked,
    // but the rail only lets you jump ahead once every step before the target is valid).
    expect(screen.getByRole('button', { name: /Confirm/ })).toBeDisabled();
  });

  it('(i) token mode: Create is disabled with the read-only tooltip and nothing is sent', async () => {
    mockUseAuthMe.mockReturnValue(authData('token'));
    await openWizard();
    await fillGeneral();
    await toNetworkStep();
    await toConfirmStep();

    const create = screen.getByRole('button', { name: 'Create' });
    expect(create).toBeDisabled();
    expect(create).toHaveAttribute('title', 'Read-only: signed in with a service token');
    fireEvent.click(create);
    expect(mockCreateCt).not.toHaveBeenCalled();
  });

  it('(i2) a session without VM.Allocate or without Datastore.AllocateSpace gets the privilege tooltip', async () => {
    mockUsePermissions.mockReturnValue(permissionsData({ 'VM.Audit': true }));
    await openWizard();
    await fillGeneral();
    await toNetworkStep();
    await toConfirmStep();
    const create = screen.getByRole('button', { name: 'Create' });
    expect(create).toBeDisabled();
    expect(create).toHaveAttribute('title', "You don't have VM.Allocate on this guest");
    expect(mockUsePermissions).toHaveBeenCalledWith(150);

    cleanup();
    vi.clearAllMocks();
    mockUsePermissions.mockReturnValue(permissionsData(true));
    mockUseStoragePermissions.mockReturnValue(permissionsData({ 'Datastore.Audit': true }));
    await openWizard();
    await fillGeneral();
    await toNetworkStep();
    await toConfirmStep();
    const again = screen.getByRole('button', { name: 'Create' });
    expect(again).toBeDisabled();
    expect(again).toHaveAttribute('title', "You don't have Datastore.AllocateSpace on local-lvm");
    expect(mockUseStoragePermissions).toHaveBeenCalledWith('local-lvm');
  });

  it("(j) a server error is shown inline, the dialog stays open and the password is not echoed", async () => {
    mockCreateCt.mockRejectedValue(new GuestActionError(409, 'That CT ID is already in use'));
    await openWizard();
    await fillGeneral();
    await toNetworkStep();
    await toConfirmStep();

    fireEvent.click(screen.getByRole('button', { name: 'Create' }));
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('That CT ID is already in use');
    expect(screen.getByTestId('create-ct-dialog')).toBeInTheDocument();
    expect(screen.getByTestId('create-ct-dialog')).not.toHaveTextContent(PASSWORD);
    expect(useCreateStore.getState().open).toEqual({ kind: 'lxc', node: 'pve1' });
    // The attempt can be corrected and repeated.
    expect(screen.getByRole('button', { name: 'Create' })).toBeEnabled();
  });

  it('(k) Cancel closes the wizard and clears the store', async () => {
    const dialog = await openWizard();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByTestId('create-ct-dialog')).not.toBeInTheDocument());
    expect(useCreateStore.getState().open).toBeNull();
  });

  describe('fixture mode', () => {
    beforeEach(() => {
      state.fixtures = true;
    });

    it('(l) fixture round trip: the new container appears in the fixtures with a composed config', async () => {
      expect(getFixtureNextId()).toBe(306);
      await openWizard();
      await waitFor(() => expect(screen.getByLabelText('CT ID')).toHaveValue('306'));
      typeInto('Hostname', 'fixture-ct');
      typeInto('Password', PASSWORD);
      typeInto('Confirm password', PASSWORD);
      await goNext();
      await onStep('Template');
      await waitFor(() => expect(screen.getByLabelText('Storage')).toHaveValue('local'));
      await screen.findByRole('option', { name: /debian-12/ });
      fireEvent.change(screen.getByLabelText('Template'), { target: { value: DEBIAN } });
      await goNext();
      await onStep('Disks');
      await waitFor(() => expect(screen.getByLabelText('Storage')).toHaveValue('local-zfs'));
      await goNext();
      await onStep('CPU');
      await goNext();
      await onStep('Memory');
      await goNext();
      await onStep('Network');
      await waitFor(() => expect(screen.getByLabelText('Bridge')).toHaveValue('vmbr0'));
      await toConfirmStep();

      fireEvent.click(screen.getByRole('button', { name: 'Create' }));
      await waitFor(() => expect(getFixtureGuestByVmid(306)).toBeDefined());
      expect(getFixtureGuestByVmid(306)).toMatchObject({
        id: 'lxc/306',
        type: 'lxc',
        node: 'pve1',
        vmid: 306,
        name: 'fixture-ct',
        status: 'stopped',
      });
      expect(getFixtureGuestConfig(306)).toStrictEqual({
        hostname: 'fixture-ct',
        cores: 1,
        memory: 512,
        swap: 512,
        unprivileged: 1,
        features: 'nesting=1',
        rootfs: 'local-zfs:subvol-306-disk-0,size=8G',
        net0: 'name=eth0,bridge=vmbr0,ip=dhcp,firewall=1',
      });
    });

    it('(m) after creating, the app navigates to the new container (Summary tab)', async () => {
      await openWizard();
      await waitFor(() => expect(screen.getByLabelText('CT ID')).toHaveValue('306'));
      typeInto('Hostname', 'nav-ct');
      typeInto('SSH public keys', KEY_ED);
      await goNext();
      await onStep('Template');
      await waitFor(() => expect(screen.getByLabelText('Storage')).toHaveValue('local'));
      await screen.findByRole('option', { name: /debian-12/ });
      fireEvent.change(screen.getByLabelText('Template'), { target: { value: DEBIAN } });
      await goNext();
      await onStep('Disks');
      await waitFor(() => expect(screen.getByLabelText('Storage')).toHaveValue('local-zfs'));
      await goNext();
      await goNext();
      await goNext();
      await onStep('Network');
      await waitFor(() => expect(screen.getByLabelText('Bridge')).toHaveValue('vmbr0'));
      await toConfirmStep();

      fireEvent.click(screen.getByRole('button', { name: 'Create' }));
      await screen.findByTestId('vm-page', {}, { timeout: FIND_TIMEOUT_MS });
      expect(router.state.location.pathname).toBe('/vm/pve1/lxc/306');
      expect(router.state.location.search).toEqual({ tab: 'summary' });
    });

    it('(n) the password never appears in the fixture guest config or resource row', async () => {
      await openWizard();
      await waitFor(() => expect(screen.getByLabelText('CT ID')).toHaveValue('306'));
      typeInto('Hostname', 'secret-ct');
      typeInto('Password', PASSWORD);
      typeInto('Confirm password', PASSWORD);
      await goNext();
      await onStep('Template');
      await waitFor(() => expect(screen.getByLabelText('Storage')).toHaveValue('local'));
      await screen.findByRole('option', { name: /debian-12/ });
      fireEvent.change(screen.getByLabelText('Template'), { target: { value: DEBIAN } });
      await goNext();
      await onStep('Disks');
      await waitFor(() => expect(screen.getByLabelText('Storage')).toHaveValue('local-zfs'));
      await goNext();
      await goNext();
      await goNext();
      await onStep('Network');
      await waitFor(() => expect(screen.getByLabelText('Bridge')).toHaveValue('vmbr0'));
      await toConfirmStep();
      fireEvent.click(screen.getByRole('button', { name: 'Create' }));
      await waitFor(() => expect(getFixtureGuestConfig(306)).toBeDefined());

      const stored = JSON.stringify({ config: getFixtureGuestConfig(306), row: getFixtureGuestByVmid(306) });
      expect(stored).not.toContain(PASSWORD);
      expect(Object.keys(getFixtureGuestConfig(306) ?? {})).not.toContain('password');
    });
  });
});
