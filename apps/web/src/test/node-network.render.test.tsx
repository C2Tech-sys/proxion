import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClientProvider } from '@tanstack/react-query';

import { NetworkTab } from '@/pages/node/tabs/NetworkTab';
import { Toaster } from '@/components/ui/sonner';
import { createQueryClient } from '@/api/queryClient';
import { GuestActionError } from '@/api/actions';
import { getFixtureNodeNetwork, resetFixtureNodeNetwork } from '@/api/fixtures';
import { parseNodeNetwork, type NodeNetwork } from '@/api/nodeNetwork';
import type { AuthIdentity } from '@/api/client-types';
import type { GuestPermissions } from '@/api/actionHooks';

/**
 * The node Network tab (T69): interface table, Create menu, per-row edit/delete, the pending-changes
 * banner and the Apply / Revert flow, plus the gating on session mode + `Sys.Modify`. `useAuthMe` /
 * `useNodePermissions` are mocked so each test controls the gate; outside the last two tests the
 * `@/api/nodeNetwork` request functions are mocked so the exact request each dialog builds can be
 * asserted. The fixture round-trip tests flip `USE_FIXTURES` on and run the real fixture client.
 */
const mockUseAuthMe = vi.fn();
const mockUseNodePermissions = vi.fn();
const mockGetNodeNetwork = vi.fn();
const mockCreate = vi.fn();
const mockUpdate = vi.fn();
const mockDelete = vi.fn();
const mockApply = vi.fn();
const mockRevert = vi.fn();

const state = vi.hoisted(() => ({ fixtures: false }));

// A getter, so the fixture round-trip tests can flip it per test (`USE_FIXTURES` is true by default
// in this test env, which would short-circuit the session gate to "always enabled").
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
  return { ...actual, useNodePermissions: (node: string) => mockUseNodePermissions(node) };
});

vi.mock('@/api/nodeNetwork', async () => {
  const actual = await vi.importActual<typeof import('@/api/nodeNetwork')>('@/api/nodeNetwork');
  return {
    ...actual,
    getNodeNetwork: (...args: Parameters<typeof actual.getNodeNetwork>) =>
      state.fixtures ? actual.getNodeNetwork(...args) : mockGetNodeNetwork(...args),
    createNodeNetIface: (...args: Parameters<typeof actual.createNodeNetIface>) =>
      state.fixtures ? actual.createNodeNetIface(...args) : mockCreate(...args),
    updateNodeNetIface: (...args: Parameters<typeof actual.updateNodeNetIface>) =>
      state.fixtures ? actual.updateNodeNetIface(...args) : mockUpdate(...args),
    deleteNodeNetIface: (...args: Parameters<typeof actual.deleteNodeNetIface>) =>
      state.fixtures ? actual.deleteNodeNetIface(...args) : mockDelete(...args),
    applyNodeNetwork: (...args: Parameters<typeof actual.applyNodeNetwork>) =>
      state.fixtures ? actual.applyNodeNetwork(...args) : mockApply(...args),
    revertNodeNetwork: (...args: Parameters<typeof actual.revertNodeNetwork>) =>
      state.fixtures ? actual.revertNodeNetwork(...args) : mockRevert(...args),
  };
});

function authData(mode: AuthIdentity['mode']) {
  return { data: { username: 'root@pam', realm: 'pam', capabilities: {}, mode } };
}

function permissionsData(privs: Record<string, boolean> | true) {
  const value: GuestPermissions = { can: (p: string) => privs === true || privs[p] === true };
  return { data: value };
}

/** The demo's pve1 interfaces, as the tab's query returns them, optionally with a staged diff. */
function networkData(changes = ''): NodeNetwork {
  return { ...parseNodeNetwork(getFixtureNodeNetwork('pve1')), changes };
}

const DIFF = '--- /etc/network/interfaces\n+++ /etc/network/interfaces.new\n+auto vmbr2\n+iface vmbr2 inet manual';

function renderTab() {
  const queryClient = createQueryClient();
  render(
    <QueryClientProvider client={queryClient}>
      <NetworkTab node="pve1" />
      <Toaster />
    </QueryClientProvider>,
  );
}

function openMenu(trigger: HTMLElement) {
  // Radix's DropdownMenu trigger opens on `pointerdown`, not `click`.
  fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false, pointerType: 'mouse' });
  fireEvent.pointerUp(trigger, { button: 0, ctrlKey: false, pointerType: 'mouse' });
  fireEvent.click(trigger);
}

async function openCreateDialog(label: 'Linux Bridge' | 'Linux Bond' | 'Linux VLAN') {
  openMenu(await screen.findByRole('button', { name: /^Create/ }));
  fireEvent.click(await screen.findByRole('menuitem', { name: label }));
  return screen.findByRole('dialog');
}

async function openRowDialog(buttonName: string) {
  fireEvent.click(await screen.findByRole('button', { name: buttonName }));
  return screen.findByRole('dialog');
}

describe('Node Network tab', () => {
  beforeEach(() => {
    state.fixtures = false;
    // jsdom doesn't implement the Pointer Events API Radix's DropdownMenu relies on.
    if (!Element.prototype.hasPointerCapture) Element.prototype.hasPointerCapture = () => false;
    if (!Element.prototype.setPointerCapture) Element.prototype.setPointerCapture = () => {};
    if (!Element.prototype.releasePointerCapture) Element.prototype.releasePointerCapture = () => {};
    if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = () => {};
    mockUseAuthMe.mockReturnValue(authData('session'));
    mockUseNodePermissions.mockReturnValue(permissionsData(true));
    mockGetNodeNetwork.mockImplementation(() => Promise.resolve(networkData()));
    mockCreate.mockResolvedValue(undefined);
    mockUpdate.mockResolvedValue(undefined);
    mockDelete.mockResolvedValue(undefined);
    mockApply.mockResolvedValue({ upid: 'UPID:pve1:0000A11E:00000000:00000000:srvreload:networking:root@pam:' });
    mockRevert.mockResolvedValue(undefined);
  });

  afterEach(() => {
    state.fixtures = false;
    resetFixtureNodeNetwork();
    vi.clearAllMocks();
  });

  it('(a) renders the fixture interfaces sorted physical, bridges, bonds, VLANs', async () => {
    renderTab();
    await screen.findByTestId('node-network-row-vmbr0');

    const rows = screen.getAllByTestId(/^node-network-row-/).map((row) => row.getAttribute('data-testid'));
    expect(rows).toStrictEqual([
      'node-network-row-eno1',
      'node-network-row-eno2',
      'node-network-row-vmbr0',
      'node-network-row-vmbr1',
      'node-network-row-bond0',
      'node-network-row-vmbr1.20',
    ]);

    const bridge = within(screen.getByTestId('node-network-row-vmbr0'));
    expect(bridge.getByText('Linux Bridge')).toBeInTheDocument();
    expect(bridge.getByText('eno1')).toBeInTheDocument();
    expect(bridge.getByText('10.0.0.11/24')).toBeInTheDocument();
    expect(bridge.getByText('10.0.0.1')).toBeInTheDocument();
    expect(bridge.getByText('LAN')).toBeInTheDocument();
    const bond = within(screen.getByTestId('node-network-row-bond0'));
    expect(bond.getByText('active-backup')).toBeInTheDocument();
    expect(bond.getByText('eno2')).toBeInTheDocument();
    // No staged changes: no banner.
    expect(screen.queryByTestId('node-network-pending')).not.toBeInTheDocument();
    // Physical interfaces cannot be deleted; bridges can.
    expect(screen.queryByRole('button', { name: 'Delete eno1' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Delete vmbr1' })).toBeInTheDocument();
  });

  it('(b) create bridge sends the exact body', async () => {
    renderTab();
    const dialog = await openCreateDialog('Linux Bridge');

    expect(within(dialog).getByRole('heading', { name: 'Create: Linux Bridge' })).toBeInTheDocument();
    // The next free vmbr name is prefilled.
    expect(within(dialog).getByLabelText('Name')).toHaveValue('vmbr2');
    fireEvent.change(within(dialog).getByLabelText('Bridge ports'), { target: { value: 'eno2' } });
    fireEvent.change(within(dialog).getByLabelText('IPv4/CIDR'), { target: { value: '10.10.0.2/24' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Create' }));

    await waitFor(() =>
      expect(mockCreate).toHaveBeenCalledWith('pve1', {
        type: 'bridge',
        iface: 'vmbr2',
        autostart: true,
        bridge_ports: 'eno2',
        cidr: '10.10.0.2/24',
      }),
    );
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(await screen.findByText('vmbr2 created; apply the configuration to activate it')).toBeInTheDocument();
  });

  it('(c) create bond sends slaves, mode and hash policy', async () => {
    renderTab();
    const dialog = await openCreateDialog('Linux Bond');

    const create = within(dialog).getByRole('button', { name: 'Create' });
    expect(within(dialog).getByLabelText('Name')).toHaveValue('bond1');
    expect(create).toBeDisabled(); // slaves are required
    fireEvent.change(within(dialog).getByLabelText('Slaves'), { target: { value: 'eno3 eno4' } });
    fireEvent.change(within(dialog).getByLabelText('Mode'), { target: { value: '802.3ad' } });
    fireEvent.change(within(dialog).getByLabelText('Hash policy'), { target: { value: 'layer2+3' } });
    expect(create).toBeEnabled();
    fireEvent.click(create);

    await waitFor(() =>
      expect(mockCreate).toHaveBeenCalledWith('pve1', {
        type: 'bond',
        iface: 'bond1',
        autostart: true,
        slaves: 'eno3 eno4',
        bond_mode: '802.3ad',
        bond_xmit_hash_policy: 'layer2+3',
      }),
    );
  });

  it('(d) create VLAN derives the name and sends vlan-id and vlan-raw-device', async () => {
    renderTab();
    const dialog = await openCreateDialog('Linux VLAN');

    const create = within(dialog).getByRole('button', { name: 'Create' });
    expect(create).toBeDisabled(); // a VLAN ID is required
    fireEvent.change(within(dialog).getByLabelText('VLAN ID'), { target: { value: '30' } });
    expect(within(dialog).getByLabelText('VLAN raw device')).toHaveValue('vmbr0');
    expect(within(dialog).getByLabelText('Name')).toHaveValue('vmbr0.30');
    fireEvent.change(within(dialog).getByLabelText('IPv4/CIDR'), { target: { value: '10.30.0.5/24' } });
    fireEvent.click(create);

    await waitFor(() =>
      expect(mockCreate).toHaveBeenCalledWith('pve1', {
        type: 'vlan',
        iface: 'vmbr0.30',
        autostart: true,
        'vlan-id': 30,
        'vlan-raw-device': 'vmbr0',
        cidr: '10.30.0.5/24',
      }),
    );
  });

  it('(e) editing a bridge and clearing the gateway sends gateway: null (only what changed)', async () => {
    renderTab();
    const dialog = await openRowDialog('Edit vmbr0');

    expect(within(dialog).getByLabelText('Name')).toBeDisabled();
    expect(within(dialog).getByLabelText('Name')).toHaveValue('vmbr0');
    expect(within(dialog).getByLabelText('Gateway (IPv4)')).toHaveValue('10.0.0.1');
    expect(within(dialog).getByLabelText('Bridge ports')).toHaveValue('eno1');
    const save = within(dialog).getByRole('button', { name: 'Save' });
    expect(save).toBeDisabled(); // nothing changed yet
    fireEvent.change(within(dialog).getByLabelText('Gateway (IPv4)'), { target: { value: '' } });
    expect(save).toBeEnabled();
    fireEvent.click(save);

    await waitFor(() => expect(mockUpdate).toHaveBeenCalledWith('pve1', 'vmbr0', { gateway: null }));
  });

  it('(f) a physical interface dialog hides the bridge, bond and VLAN fields and edits addressing only', async () => {
    renderTab();
    const dialog = await openRowDialog('Edit eno2');

    expect(within(dialog).queryByLabelText('Bridge ports')).not.toBeInTheDocument();
    expect(within(dialog).queryByLabelText('VLAN aware')).not.toBeInTheDocument();
    expect(within(dialog).queryByLabelText('Slaves')).not.toBeInTheDocument();
    expect(within(dialog).queryByLabelText('VLAN ID')).not.toBeInTheDocument();
    expect(within(dialog).getByLabelText('Autostart')).toBeInTheDocument();
    expect(within(dialog).getByLabelText('MTU')).toBeInTheDocument();

    const save = within(dialog).getByRole('button', { name: 'Save' });
    fireEvent.change(within(dialog).getByLabelText('Gateway (IPv4)'), { target: { value: '10.30.0.1' } });
    expect(save).toBeDisabled(); // a gateway needs an address
    expect(within(dialog).getByText('A gateway needs an IPv4/CIDR address.')).toBeInTheDocument();
    fireEvent.change(within(dialog).getByLabelText('IPv4/CIDR'), { target: { value: '10.30.0.5/24' } });
    fireEvent.change(within(dialog).getByLabelText('MTU'), { target: { value: '9000' } });
    fireEvent.click(save);

    await waitFor(() =>
      expect(mockUpdate).toHaveBeenCalledWith('pve1', 'eno2', {
        cidr: '10.30.0.5/24',
        gateway: '10.30.0.1',
        mtu: 9000,
      }),
    );
  });

  it('(g) delete asks for the interface name before it calls the server', async () => {
    renderTab();
    fireEvent.click(await screen.findByRole('button', { name: 'Delete vmbr1.20' }));
    const dialog = await screen.findByRole('alertdialog');

    expect(within(dialog).getByText('Delete vmbr1.20?')).toBeInTheDocument();
    const confirm = within(dialog).getByRole('button', { name: 'Delete vmbr1.20' });
    expect(confirm).toBeDisabled();
    const input = within(dialog).getByLabelText('Type the interface name to confirm');
    fireEvent.change(input, { target: { value: 'vmbr1' } });
    expect(confirm).toBeDisabled();
    fireEvent.change(input, { target: { value: 'vmbr1.20' } });
    expect(confirm).toBeEnabled();
    fireEvent.click(confirm);

    await waitFor(() => expect(mockDelete).toHaveBeenCalledWith('pve1', 'vmbr1.20'));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument());
  });

  it('(h) staged changes show the yellow banner with the diff in a <pre>', async () => {
    mockGetNodeNetwork.mockImplementation(() => Promise.resolve(networkData(DIFF)));
    renderTab();

    const banner = await screen.findByTestId('node-network-pending');
    const diff = within(banner).getByTestId('node-network-pending-diff');
    expect(diff.tagName).toBe('PRE');
    expect(diff).toHaveTextContent('+auto vmbr2');
    expect(diff).toHaveTextContent('+++ /etc/network/interfaces.new');
    expect(within(banner).getByRole('button', { name: 'Apply configuration' })).toBeEnabled();
    expect(within(banner).getByRole('button', { name: 'Revert' })).toBeEnabled();
  });

  it('(i) apply needs the typed word, states the lock-out risk, makes the exact call and toasts the task', async () => {
    mockGetNodeNetwork.mockImplementation(() => Promise.resolve(networkData(DIFF)));
    renderTab();

    fireEvent.click(await screen.findByRole('button', { name: 'Apply configuration' }));
    const dialog = await screen.findByRole('alertdialog');

    expect(
      within(dialog).getByText(
        'Applying can disconnect this node from the network if the configuration is wrong; have console access ready.',
      ),
    ).toBeInTheDocument();
    const confirm = within(dialog).getByRole('button', { name: 'Apply network configuration' });
    expect(confirm).toBeDisabled();
    const input = within(dialog).getByLabelText('Type APPLY to confirm');
    fireEvent.change(input, { target: { value: 'apply' } });
    expect(confirm).toBeDisabled();
    fireEvent.change(input, { target: { value: 'APPLY' } });
    expect(confirm).toBeEnabled();
    fireEvent.click(confirm);

    await waitFor(() => expect(mockApply).toHaveBeenCalledWith('pve1'));
    expect(mockApply).toHaveBeenCalledTimes(1);
    expect(await screen.findByText('Applying network configuration — task 0000A11E')).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument());
  });

  it('(j) revert makes the exact call', async () => {
    mockGetNodeNetwork.mockImplementation(() => Promise.resolve(networkData(DIFF)));
    renderTab();

    fireEvent.click(await screen.findByRole('button', { name: 'Revert' }));

    await waitFor(() => expect(mockRevert).toHaveBeenCalledWith('pve1'));
    expect(mockRevert).toHaveBeenCalledTimes(1);
    expect(await screen.findByText('Pending network changes reverted')).toBeInTheDocument();
  });

  it('(k) token mode: create, edit, delete, apply and revert are all disabled with the read-only tooltip', async () => {
    mockUseAuthMe.mockReturnValue(authData('token'));
    mockGetNodeNetwork.mockImplementation(() => Promise.resolve(networkData(DIFF)));
    renderTab();
    await screen.findByTestId('node-network-row-vmbr0');

    for (const name of [/^Create/, 'Edit vmbr0', 'Edit eno1', 'Delete vmbr1', 'Apply configuration', 'Revert']) {
      const button = screen.getByRole('button', { name });
      expect(button).toBeDisabled();
      expect(button).toHaveAttribute('title', 'Read-only: signed in with a service token');
    }
  });

  it('(l) a session without Sys.Modify gets the privilege tooltip on every write control', async () => {
    mockUseNodePermissions.mockReturnValue(permissionsData({ 'Sys.Audit': true }));
    mockGetNodeNetwork.mockImplementation(() => Promise.resolve(networkData(DIFF)));
    renderTab();
    await screen.findByTestId('node-network-row-vmbr0');

    for (const name of [/^Create/, 'Edit vmbr0', 'Delete vmbr1', 'Apply configuration', 'Revert']) {
      const button = screen.getByRole('button', { name });
      expect(button).toBeDisabled();
      expect(button).toHaveAttribute('title', "You don't have Sys.Modify on this node");
    }
  });

  it('(m) a server error stays inline and the dialog stays open', async () => {
    mockCreate.mockRejectedValue(new GuestActionError(400, 'interface vmbr2 already exists'));
    renderTab();
    const dialog = await openCreateDialog('Linux Bridge');

    fireEvent.click(within(dialog).getByRole('button', { name: 'Create' }));

    expect(await within(dialog).findByRole('alert')).toHaveTextContent('interface vmbr2 already exists');
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });

  it('(n) fixture round trip: a write stages a diff, Revert discards it, Apply commits it', async () => {
    state.fixtures = true;
    renderTab();
    await screen.findByTestId('node-network-row-vmbr0');
    expect(screen.queryByTestId('node-network-pending')).not.toBeInTheDocument();

    // Create vmbr2: the row appears and the banner shows the staged diff.
    const dialog = await openCreateDialog('Linux Bridge');
    fireEvent.change(within(dialog).getByLabelText('Bridge ports'), { target: { value: 'eno2' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Create' }));
    expect(await screen.findByTestId('node-network-row-vmbr2')).toBeInTheDocument();
    expect(screen.getByTestId('node-network-pending-diff')).toHaveTextContent('+iface vmbr2 inet manual');

    // Revert: the staged bridge and the banner are gone.
    fireEvent.click(screen.getByRole('button', { name: 'Revert' }));
    await waitFor(() => expect(screen.queryByTestId('node-network-row-vmbr2')).not.toBeInTheDocument());
    expect(screen.queryByTestId('node-network-pending')).not.toBeInTheDocument();

    // Edit vmbr0's comment, then apply: the banner clears and the new comment stays.
    const edit = await openRowDialog('Edit vmbr0');
    fireEvent.change(within(edit).getByLabelText('Comment'), { target: { value: 'uplink' } });
    fireEvent.click(within(edit).getByRole('button', { name: 'Save' }));
    await screen.findByTestId('node-network-pending');
    expect(screen.getByTestId('node-network-pending-diff')).toHaveTextContent('-#LAN');
    expect(screen.getByTestId('node-network-pending-diff')).toHaveTextContent('+#uplink');

    fireEvent.click(screen.getByRole('button', { name: 'Apply configuration' }));
    const applyDialog = await screen.findByRole('alertdialog');
    fireEvent.change(within(applyDialog).getByLabelText('Type APPLY to confirm'), { target: { value: 'APPLY' } });
    fireEvent.click(within(applyDialog).getByRole('button', { name: 'Apply network configuration' }));

    await waitFor(() => expect(screen.queryByTestId('node-network-pending')).not.toBeInTheDocument());
    expect(within(screen.getByTestId('node-network-row-vmbr0')).getByText('uplink')).toBeInTheDocument();
    expect(await screen.findByText('Network configuration applied')).toBeInTheDocument();
  });

  it('(o) fixture round trip: deleting a VLAN stages the removal in the diff', async () => {
    state.fixtures = true;
    renderTab();

    fireEvent.click(await screen.findByRole('button', { name: 'Delete vmbr1.20' }));
    const dialog = await screen.findByRole('alertdialog');
    fireEvent.change(within(dialog).getByLabelText('Type the interface name to confirm'), {
      target: { value: 'vmbr1.20' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete vmbr1.20' }));

    await waitFor(() => expect(screen.queryByTestId('node-network-row-vmbr1.20')).not.toBeInTheDocument());
    expect(await screen.findByTestId('node-network-pending-diff')).toHaveTextContent('-iface vmbr1.20 inet static');
  });
});
