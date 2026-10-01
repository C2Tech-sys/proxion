import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClientProvider } from '@tanstack/react-query';

import { HardwareTab } from '@/pages/vm/tabs/HardwareTab';
import { createQueryClient } from '@/api/queryClient';
import { getFixtureGuestConfig, patchFixtureGuestConfig } from '@/api/fixtures';
import type { AuthIdentity } from '@/api/client-types';
import type { GuestPermissions } from '@/api/actionHooks';

/**
 * The Hardware tab's network-device controls (T50): an "Add network device" button in the network
 * section header, an edit pencil and a remove (trash) action on each NIC row, both dialogs, and the
 * gating on session mode + `VM.Config.Network`. `useAuthMe`/`usePermissions` are mocked so each
 * test controls the gate; the guest config comes from the real fixture client, and
 * `@/api/network`'s request functions are mocked so the exact request each dialog builds can be
 * asserted. The last test flips `USE_FIXTURES` on and runs the real fixture flow instead.
 */
const mockUseAuthMe = vi.fn();
const mockUsePermissions = vi.fn();
const mockUpsertNic = vi.fn();
const mockDeleteNic = vi.fn();
const mockGetNextNicSlot = vi.fn();
const mockGetBridges = vi.fn();

const state = vi.hoisted(() => ({
  fixtures: false,
  actual: undefined as typeof import('@/api/network') | undefined,
}));

// `USE_FIXTURES` is true by default in this test env (`.env.test`), which would short-circuit the
// session-mode gate to "always enabled" before the mocked `useAuthMe` ever mattered. A getter, so
// the fixture-flow test can flip it per test.
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

vi.mock('@/api/network', async () => {
  const actual = await vi.importActual<typeof import('@/api/network')>('@/api/network');
  state.actual = actual;
  return {
    ...actual,
    upsertNic: (...args: unknown[]) => mockUpsertNic(...args),
    deleteNic: (...args: unknown[]) => mockDeleteNic(...args),
    getNextNicSlot: (...args: unknown[]) => mockGetNextNicSlot(...args),
    getBridges: (...args: unknown[]) => mockGetBridges(...args),
  };
});

function authData(mode: AuthIdentity['mode']) {
  return { data: { username: 'root@pam', realm: 'pam', capabilities: {}, mode } };
}

function permissionsData(privs: Record<string, boolean> | true) {
  const value: GuestPermissions = { can: (p: string) => privs === true || privs[p] === true };
  return { data: value };
}

const BRIDGES = [
  { iface: 'vmbr0', type: 'bridge', active: true },
  { iface: 'vmbr1', type: 'bridge', active: true },
];

function renderTab(guest: { node: string; type: 'qemu' | 'lxc'; vmid: number } = { node: 'pve1', type: 'qemu', vmid: 100 }) {
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

describe('Hardware tab network devices', () => {
  beforeEach(() => {
    state.fixtures = false;
    mockUseAuthMe.mockReturnValue(authData('session'));
    mockUsePermissions.mockReturnValue(permissionsData(true));
    mockUpsertNic.mockResolvedValue({ ok: true, slot: 'net0', pending: [] });
    mockDeleteNic.mockResolvedValue({ ok: true, pending: [] });
    mockGetNextNicSlot.mockResolvedValue('net2');
    mockGetBridges.mockResolvedValue(BRIDGES);
  });

  afterEach(() => {
    state.fixtures = false;
    // Only the fixture-flow test adds a device to the shared in-memory config, and the mtu=1 test
    // rewrites net0.
    patchFixtureGuestConfig('pve1', 'qemu', 100, {
      net0: 'virtio=BC:24:11:64:00:01,bridge=vmbr0,firewall=1',
      net2: undefined,
    });
    vi.clearAllMocks();
  });

  it('(a) token mode: add, edit and remove are disabled with the read-only tooltip', async () => {
    mockUseAuthMe.mockReturnValue(authData('token'));

    renderTab();
    await screen.findByText('Network Device (net0)');

    for (const name of ['Add network device', 'Edit network device net0', 'Remove net0', 'Edit network device net1', 'Remove net1']) {
      const button = screen.getByRole('button', { name });
      expect(button).toBeDisabled();
      expect(button).toHaveAttribute('title', 'Read-only: signed in with a service token');
    }
  });

  it('(a2) a session without VM.Config.Network gets the privilege tooltip on all three', async () => {
    mockUsePermissions.mockReturnValue(permissionsData({ 'VM.Config.CPU': true }));

    renderTab();
    await screen.findByText('Network Device (net0)');

    for (const name of ['Add network device', 'Edit network device net0', 'Remove net0']) {
      const button = screen.getByRole('button', { name });
      expect(button).toBeDisabled();
      expect(button).toHaveAttribute('title', "You don't have VM.Config.Network on this guest");
    }
    // Other privileges are independent: this session does hold VM.Config.CPU.
    expect(screen.getByRole('button', { name: 'Edit processors' })).toBeEnabled();
  });

  it('(b) add on qemu: defaults to virtio on vmbr0, firewall on, MAC auto; submit sends exactly that', async () => {
    renderTab();
    const dialog = await openDialog('Add network device');

    // The next free slot comes from the server lookup.
    expect(await within(dialog).findByRole('heading', { name: 'Add network device (net2)' })).toBeInTheDocument();
    expect(mockGetNextNicSlot).toHaveBeenCalledWith('pve1', 'qemu', 100);
    await within(dialog).findByRole('option', { name: 'vmbr1' });

    expect(within(dialog).getByLabelText('Model')).toHaveValue('virtio');
    expect(within(dialog).getByLabelText('Bridge')).toHaveValue('vmbr0');
    expect(within(dialog).getByRole('checkbox', { name: 'Firewall' })).toBeChecked();
    expect(within(dialog).getByRole('checkbox', { name: 'Disconnect' })).not.toBeChecked();
    expect(within(dialog).getByTestId('nic-mac-display')).toHaveTextContent('Auto (generated by Proxmox)');
    expect(within(dialog).getByLabelText('VLAN tag')).toHaveValue(null);

    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));

    await waitFor(() =>
      expect(mockUpsertNic).toHaveBeenCalledWith('pve1', 'qemu', 100, 'net2', {
        model: 'virtio',
        bridge: 'vmbr0',
        firewall: true,
      }),
    );
    expect(mockUpsertNic).toHaveBeenCalledTimes(1);
    expect(mockUpsertNic.mock.calls[0]![4]).not.toHaveProperty('mac');
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });

  it('(b2) add on qemu: the MAC override, VLAN, rate, disconnect and MTU are all sent', async () => {
    renderTab();
    const dialog = await openDialog('Add network device');
    await within(dialog).findByRole('option', { name: 'vmbr1' });

    fireEvent.change(within(dialog).getByLabelText('Model'), { target: { value: 'e1000e' } });
    fireEvent.change(within(dialog).getByLabelText('Bridge'), { target: { value: 'vmbr1' } });
    fireEvent.change(within(dialog).getByLabelText('VLAN tag'), { target: { value: '20' } });
    fireEvent.change(within(dialog).getByLabelText('Rate limit (MB/s)'), { target: { value: '12.5' } });
    fireEvent.change(within(dialog).getByLabelText('MTU'), { target: { value: '1500' } });
    fireEvent.click(within(dialog).getByRole('checkbox', { name: 'Firewall' }));
    fireEvent.click(within(dialog).getByRole('checkbox', { name: 'Disconnect' }));
    fireEvent.click(within(dialog).getByRole('checkbox', { name: 'Override' }));
    fireEvent.change(within(dialog).getByLabelText('Custom MAC address'), { target: { value: 'BC:24:11:AA:BB:CC' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));

    await waitFor(() =>
      expect(mockUpsertNic).toHaveBeenCalledWith('pve1', 'qemu', 100, 'net2', {
        model: 'e1000e',
        bridge: 'vmbr1',
        mac: 'BC:24:11:AA:BB:CC',
        vlan: 20,
        rateMbps: 12.5,
        linkDown: true,
        mtu: 1500,
      }),
    );
  });

  it('(b3) inline validation mirrors the server and disables Save', async () => {
    renderTab();
    const dialog = await openDialog('Add network device');
    await within(dialog).findByRole('option', { name: 'vmbr1' });
    const save = within(dialog).getByRole('button', { name: 'Save' });
    expect(save).toBeEnabled();

    for (const value of ['0', '4095']) {
      fireEvent.change(within(dialog).getByLabelText('VLAN tag'), { target: { value } });
      expect(save).toBeDisabled();
      expect(within(dialog).getByText(/VLAN tag must be between 1 and 4094/)).toBeInTheDocument();
    }
    fireEvent.change(within(dialog).getByLabelText('VLAN tag'), { target: { value: '' } });
    expect(save).toBeEnabled();

    fireEvent.change(within(dialog).getByLabelText('Rate limit (MB/s)'), { target: { value: '0' } });
    expect(save).toBeDisabled();
    fireEvent.change(within(dialog).getByLabelText('Rate limit (MB/s)'), { target: { value: '' } });
    // qemu MTU is 1..65520 (1 = bridge MTU); 100 is fine, 0 and 65521 are not.
    fireEvent.change(within(dialog).getByLabelText('MTU'), { target: { value: '100' } });
    expect(save).toBeEnabled();
    for (const value of ['0', '65521']) {
      fireEvent.change(within(dialog).getByLabelText('MTU'), { target: { value } });
      expect(save).toBeDisabled();
    }
    fireEvent.change(within(dialog).getByLabelText('MTU'), { target: { value: '' } });
    expect(save).toBeEnabled();

    fireEvent.click(within(dialog).getByRole('checkbox', { name: 'Override' }));
    expect(save).toBeDisabled(); // an empty custom MAC is not a MAC
    fireEvent.change(within(dialog).getByLabelText('Custom MAC address'), { target: { value: '01:00:5E:00:00:01' } });
    expect(within(dialog).getByText(/Enter a unicast MAC/)).toBeInTheDocument();
    expect(save).toBeDisabled();
    fireEvent.change(within(dialog).getByLabelText('Custom MAC address'), { target: { value: 'BC:24:11:AA:BB:CC' } });
    expect(save).toBeEnabled();
  });

  it('(b4) an empty bridge list falls back to a free-text field', async () => {
    mockGetBridges.mockResolvedValue([]);

    renderTab();
    const dialog = await openDialog('Add network device');
    await within(dialog).findByRole('heading', { name: 'Add network device (net2)' });

    const bridge = await within(dialog).findByRole('textbox', { name: 'Bridge' });
    expect(bridge).toHaveValue('vmbr0');
    fireEvent.change(bridge, { target: { value: 'vmbr7' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(mockUpsertNic).toHaveBeenCalledWith('pve1', 'qemu', 100, 'net2', {
        model: 'virtio',
        bridge: 'vmbr7',
        firewall: true,
      }),
    );
  });

  it('(b5) a server error stays inline and the dialog stays open', async () => {
    const { GuestActionError } = await import('@/api/actions');
    mockUpsertNic.mockRejectedValue(new GuestActionError(403, 'Permission check failed (/sdn/zones/localnetwork/vmbr0, SDN.Use)'));

    renderTab();
    const dialog = await openDialog('Add network device');
    await within(dialog).findByRole('option', { name: 'vmbr1' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));

    expect(await within(dialog).findByRole('alert')).toHaveTextContent('SDN.Use');
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });

  it('(c) edit an existing NIC: prefilled from the config; a VLAN change sends the full state without the MAC', async () => {
    renderTab();
    const dialog = await openDialog('Edit network device net0');

    expect(within(dialog).getByRole('heading', { name: 'Edit network device (net0)' })).toBeInTheDocument();
    await within(dialog).findByRole('option', { name: 'vmbr1' });
    expect(within(dialog).getByLabelText('Model')).toHaveValue('virtio');
    expect(within(dialog).getByLabelText('Bridge')).toHaveValue('vmbr0');
    expect(within(dialog).getByRole('checkbox', { name: 'Firewall' })).toBeChecked();
    // The address is shown read-only and can't be overridden on an existing device.
    expect(within(dialog).getByTestId('nic-mac-display')).toHaveTextContent('BC:24:11:64:00:01');
    expect(within(dialog).queryByRole('checkbox', { name: 'Override' })).not.toBeInTheDocument();
    expect(mockGetNextNicSlot).not.toHaveBeenCalled();

    fireEvent.change(within(dialog).getByLabelText('VLAN tag'), { target: { value: '30' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));

    await waitFor(() =>
      expect(mockUpsertNic).toHaveBeenCalledWith('pve1', 'qemu', 100, 'net0', {
        model: 'virtio',
        bridge: 'vmbr0',
        firewall: true,
        vlan: 30,
      }),
    );
    expect(mockUpsertNic.mock.calls[0]![4]).not.toHaveProperty('mac');
  });

  it('(c3) a NIC already carrying mtu=1 (bridge MTU) opens with 1, stays savable, and the body keeps mtu: 1', async () => {
    patchFixtureGuestConfig('pve1', 'qemu', 100, { net0: 'virtio=BC:24:11:64:00:01,bridge=vmbr0,firewall=1,mtu=1' });

    renderTab();
    const dialog = await openDialog('Edit network device net0');
    await within(dialog).findByRole('option', { name: 'vmbr1' });

    expect(within(dialog).getByLabelText('MTU')).toHaveValue(1);
    expect(within(dialog).getByText(/1 = use the bridge MTU \(VirtIO only\)/)).toBeInTheDocument();
    expect(within(dialog).getByText(/Options not shown here \(queues, trunks/)).toBeInTheDocument();
    fireEvent.change(within(dialog).getByLabelText('Bridge'), { target: { value: 'vmbr1' } });
    const save = within(dialog).getByRole('button', { name: 'Save' });
    expect(save).toBeEnabled();
    fireEvent.click(save);

    await waitFor(() =>
      expect(mockUpsertNic).toHaveBeenCalledWith('pve1', 'qemu', 100, 'net0', {
        model: 'virtio',
        bridge: 'vmbr1',
        firewall: true,
        mtu: 1,
      }),
    );
    expect(mockUpsertNic.mock.calls[0]![4]).not.toHaveProperty('mac');
  });

  it('(c2) edit net1 (tagged): the existing VLAN is prefilled and kept', async () => {
    renderTab();
    const dialog = await openDialog('Edit network device net1');
    await within(dialog).findByRole('option', { name: 'vmbr1' });

    expect(within(dialog).getByLabelText('VLAN tag')).toHaveValue(20);
    fireEvent.change(within(dialog).getByLabelText('Bridge'), { target: { value: 'vmbr1' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));

    await waitFor(() =>
      expect(mockUpsertNic).toHaveBeenCalledWith('pve1', 'qemu', 100, 'net1', {
        model: 'virtio',
        bridge: 'vmbr1',
        firewall: true,
        vlan: 20,
      }),
    );
  });

  it('(d) lxc: a static IPv4 + gateway sends name, bridge, ip, gw and the kept firewall, without the MAC', async () => {
    renderTab({ node: 'pve2', type: 'lxc', vmid: 200 });
    const dialog = await openDialog('Edit network device net0');
    await within(dialog).findByRole('option', { name: 'vmbr1' });

    expect(within(dialog).getByLabelText('Interface name')).toHaveValue('eth0');
    expect(within(dialog).getByLabelText('Bridge')).toHaveValue('vmbr0');
    expect(within(dialog).getByLabelText('IPv4')).toHaveValue('dhcp');
    expect(within(dialog).getByLabelText('IPv6')).toHaveValue('none');
    expect(within(dialog).getByTestId('nic-mac-display')).toHaveTextContent('BC:24:11:C8:00:01');
    // lxc has no model / disconnect.
    expect(within(dialog).queryByLabelText('Model')).not.toBeInTheDocument();
    expect(within(dialog).queryByRole('checkbox', { name: 'Disconnect' })).not.toBeInTheDocument();

    fireEvent.change(within(dialog).getByLabelText('IPv4'), { target: { value: 'static' } });
    const save = within(dialog).getByRole('button', { name: 'Save' });
    expect(save).toBeDisabled(); // a static address is required
    fireEvent.change(within(dialog).getByLabelText('IPv4 address (CIDR)'), { target: { value: '10.0.0.5' } });
    expect(within(dialog).getByText(/Enter an address with prefix/)).toBeInTheDocument();
    expect(save).toBeDisabled();
    fireEvent.change(within(dialog).getByLabelText('IPv4 address (CIDR)'), { target: { value: '10.0.0.5/24' } });
    fireEvent.change(within(dialog).getByLabelText('IPv4 gateway'), { target: { value: '10.0.0.999' } });
    expect(save).toBeDisabled();
    fireEvent.change(within(dialog).getByLabelText('IPv4 gateway'), { target: { value: '10.0.0.1' } });
    expect(save).toBeEnabled();
    fireEvent.click(save);

    await waitFor(() =>
      expect(mockUpsertNic).toHaveBeenCalledWith('pve2', 'lxc', 200, 'net0', {
        name: 'eth0',
        bridge: 'vmbr0',
        ip: '10.0.0.5/24',
        gw: '10.0.0.1',
        firewall: true,
      }),
    );
    expect(mockUpsertNic.mock.calls[0]![4]).not.toHaveProperty('mac');
  });

  it('(d2) lxc: IPv6 modes (auto, static + gateway) and an add defaulting to eth<n> with DHCP', async () => {
    renderTab({ node: 'pve2', type: 'lxc', vmid: 200 });
    const edit = await openDialog('Edit network device net0');
    await within(edit).findByRole('option', { name: 'vmbr1' });

    fireEvent.change(within(edit).getByLabelText('IPv6'), { target: { value: 'static' } });
    fireEvent.change(within(edit).getByLabelText('IPv6 address (CIDR)'), { target: { value: 'fd00::5/64' } });
    fireEvent.change(within(edit).getByLabelText('IPv6 gateway'), { target: { value: 'fd00::1' } });
    fireEvent.click(within(edit).getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(mockUpsertNic).toHaveBeenCalledWith('pve2', 'lxc', 200, 'net0', {
        name: 'eth0',
        bridge: 'vmbr0',
        ip: 'dhcp',
        ip6: 'fd00::5/64',
        gw6: 'fd00::1',
        firewall: true,
      }),
    );
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());

    const add = await openDialog('Add network device');
    await within(add).findByRole('heading', { name: 'Add network device (net2)' });
    await within(add).findByRole('option', { name: 'vmbr1' });
    expect(within(add).getByLabelText('Interface name')).toHaveValue('eth2');
    expect(within(add).getByLabelText('IPv4')).toHaveValue('dhcp');
    fireEvent.change(within(add).getByLabelText('IPv6'), { target: { value: 'auto' } });
    fireEvent.click(within(add).getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(mockUpsertNic).toHaveBeenLastCalledWith('pve2', 'lxc', 200, 'net2', {
        name: 'eth2',
        bridge: 'vmbr0',
        ip: 'dhcp',
        ip6: 'auto',
        firewall: true,
      }),
    );
  });

  it('(e) remove: the confirm names the slot and deleteNic is called with it', async () => {
    renderTab();
    fireEvent.click(await screen.findByRole('button', { name: 'Remove net1' }));
    const dialog = await screen.findByRole('alertdialog');

    expect(within(dialog).getByText('Remove net1?')).toBeInTheDocument();
    expect(within(dialog).getByText('The guest loses this interface.')).toBeInTheDocument();
    // No typed confirmation, but nothing is sent until the destructive action is confirmed.
    expect(mockDeleteNic).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Remove net1' }));

    await waitFor(() => expect(mockDeleteNic).toHaveBeenCalledWith('pve1', 'qemu', 100, 'net1'));
    expect(mockDeleteNic).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument());
  });

  it('(e2) remove: cancel sends nothing, and a server error stays inline', async () => {
    renderTab();
    fireEvent.click(await screen.findByRole('button', { name: 'Remove net0' }));
    fireEvent.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument());
    expect(mockDeleteNic).not.toHaveBeenCalled();

    const { GuestActionError } = await import('@/api/actions');
    mockDeleteNic.mockRejectedValue(new GuestActionError(404, 'net0 does not exist on this guest'));
    fireEvent.click(screen.getByRole('button', { name: 'Remove net0' }));
    const dialog = await screen.findByRole('alertdialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Remove net0' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('net0 does not exist on this guest');
    expect(screen.getByRole('alertdialog')).toBeInTheDocument();
  });

  it('(f2) fixture mode: an edit keeps unmodeled options (queues, trunks) and the MAC, like the server', async () => {
    state.fixtures = true;
    mockUpsertNic.mockImplementation(state.actual!.upsertNic);
    mockGetBridges.mockImplementation(state.actual!.getBridges);
    patchFixtureGuestConfig('pve1', 'qemu', 100, {
      net0: 'virtio=BC:24:11:64:00:01,bridge=vmbr0,firewall=1,queues=4,trunks=10;20',
    });

    renderTab();
    const dialog = await openDialog('Edit network device net0');
    await within(dialog).findByRole('option', { name: /vmbr1/ });
    fireEvent.change(within(dialog).getByLabelText('Bridge'), { target: { value: 'vmbr1' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));

    await waitFor(() =>
      expect(getFixtureGuestConfig(100)?.net0).toBe(
        'virtio=BC:24:11:64:00:01,bridge=vmbr1,firewall=1,queues=4,trunks=10;20',
      ),
    );
  });

  it('(f) fixture mode: after add, the tab shows the new NIC row; remove takes it away again', async () => {
    state.fixtures = true;
    const actual = state.actual!;
    mockUpsertNic.mockImplementation(actual.upsertNic);
    mockDeleteNic.mockImplementation(actual.deleteNic);
    mockGetNextNicSlot.mockImplementation(actual.getNextNicSlot);
    mockGetBridges.mockImplementation(actual.getBridges);

    renderTab();
    await screen.findByText('Network Device (net1)');
    expect(screen.queryByText('Network Device (net2)')).not.toBeInTheDocument();

    const dialog = await openDialog('Add network device');
    await within(dialog).findByRole('heading', { name: 'Add network device (net2)' });
    await within(dialog).findByRole('option', { name: 'vmbr1 (Storage / backup network)' });
    fireEvent.change(within(dialog).getByLabelText('Bridge'), { target: { value: 'vmbr1' } });
    fireEvent.change(within(dialog).getByLabelText('VLAN tag'), { target: { value: '40' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));

    const row = (await screen.findByText('Network Device (net2)')).closest('tr')!;
    expect(row).toHaveTextContent('virtio');
    expect(row).toHaveTextContent('@ vmbr1 (VLAN 40), firewall');
    // PVE generates the MAC for a new device.
    expect(within(row).getByTestId('hardware-mac').textContent).toMatch(/virtio BC:24:11:[0-9A-F:]{8} @ vmbr1/);

    fireEvent.click(within(row).getByRole('button', { name: 'Remove net2' }));
    fireEvent.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Remove net2' }));
    await waitFor(() => expect(screen.queryByText('Network Device (net2)')).not.toBeInTheDocument());
  });
});
