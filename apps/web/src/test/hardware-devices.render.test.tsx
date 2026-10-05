import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClientProvider } from '@tanstack/react-query';

import { HardwareTab } from '@/pages/vm/tabs/HardwareTab';
import { createQueryClient } from '@/api/queryClient';
import {
  fixtureHostPci,
  fixtureHostUsb,
  fixturePciMappings,
  fixtureUsbMappings,
  getFixtureGuestConfig,
  patchFixtureGuestConfig,
  setFixtureHostListsForbidden,
} from '@/api/fixtures';
import type { AuthIdentity } from '@/api/client-types';
import type { GuestPermissions } from '@/api/actionHooks';

/**
 * The Hardware tab's USB / PCI / serial device controls (T55): a "Devices" header row with an
 * "Add device" menu, an edit pencil (not for serial) and a remove trash on each device row, the
 * dialogs, and the gating on session mode + `VM.Config.HWType`. `useAuthMe`/`usePermissions` are
 * mocked so each test controls the gate; the guest config comes from the real fixture client, and
 * `@/api/devices`' request functions are mocked so the exact request each dialog builds can be
 * asserted. The last test flips `USE_FIXTURES` on and runs the real fixture flow instead.
 */
const mockUseAuthMe = vi.fn();
const mockUsePermissions = vi.fn();
const mockUpsertDevice = vi.fn();
const mockDeleteDevice = vi.fn();
const mockGetNextDeviceSlot = vi.fn();
const mockListHostUsb = vi.fn();
const mockListHostPci = vi.fn();
const mockListUsbMappings = vi.fn();
const mockListPciMappings = vi.fn();

const state = vi.hoisted(() => ({
  fixtures: false,
  actual: undefined as typeof import('@/api/devices') | undefined,
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

vi.mock('@/api/devices', async () => {
  const actual = await vi.importActual<typeof import('@/api/devices')>('@/api/devices');
  state.actual = actual;
  return {
    ...actual,
    upsertDevice: (...args: unknown[]) => mockUpsertDevice(...args),
    deleteDevice: (...args: unknown[]) => mockDeleteDevice(...args),
    getNextDeviceSlot: (...args: unknown[]) => mockGetNextDeviceSlot(...args),
    listHostUsb: (...args: unknown[]) => mockListHostUsb(...args),
    listHostPci: (...args: unknown[]) => mockListHostPci(...args),
    listUsbMappings: (...args: unknown[]) => mockListUsbMappings(...args),
    listPciMappings: (...args: unknown[]) => mockListPciMappings(...args),
  };
});

function authData(mode: AuthIdentity['mode']) {
  return { data: { username: 'root@pam', realm: 'pam', capabilities: {}, mode } };
}

function permissionsData(privs: Record<string, boolean> | true) {
  const value: GuestPermissions = { can: (p: string) => privs === true || privs[p] === true };
  return { data: value };
}

const USB0 = 'host=1d6b:0003,usb3=1';
const PCI0 = '0000:01:00.0,pcie=1,rombar=0,x-vga=1';

function renderTab() {
  const queryClient = createQueryClient();
  render(
    <QueryClientProvider client={queryClient}>
      <HardwareTab node="pve1" type="qemu" vmid={100} />
    </QueryClientProvider>,
  );
}

async function openAddMenu(item: 'USB device' | 'PCI device' | 'Serial port') {
  const trigger = await screen.findByRole('button', { name: 'Add device' });
  fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false, pointerType: 'mouse' });
  fireEvent.pointerUp(trigger, { button: 0, ctrlKey: false, pointerType: 'mouse' });
  fireEvent.click(trigger);
  fireEvent.click(await screen.findByRole('menuitem', { name: item }));
}

async function openDialog(buttonName: string) {
  fireEvent.click(await screen.findByRole('button', { name: buttonName }));
  return screen.findByRole('dialog');
}

describe('Hardware tab USB / PCI / serial devices', () => {
  beforeEach(() => {
    if (!Element.prototype.hasPointerCapture) Element.prototype.hasPointerCapture = () => false;
    if (!Element.prototype.setPointerCapture) Element.prototype.setPointerCapture = () => {};
    if (!Element.prototype.releasePointerCapture) Element.prototype.releasePointerCapture = () => {};
    if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = () => {};

    state.fixtures = false;
    // The shared fixture guest has no devices of its own: give it one of each kind.
    patchFixtureGuestConfig('pve1', 'qemu', 100, { usb0: USB0, hostpci0: PCI0, serial0: 'socket' });
    mockUseAuthMe.mockReturnValue(authData('session'));
    mockUsePermissions.mockReturnValue(permissionsData(true));
    mockUpsertDevice.mockResolvedValue({ ok: true, changed: ['usb1'], pending: [] });
    mockDeleteDevice.mockResolvedValue({ ok: true, pending: [] });
    mockGetNextDeviceSlot.mockImplementation((_node: string, _vmid: number, kind: string) =>
      Promise.resolve(kind === 'usb' ? 'usb1' : kind === 'pci' ? 'hostpci1' : 'serial1'),
    );
    mockListHostUsb.mockResolvedValue({ items: fixtureHostUsb, forbidden: false });
    mockListHostPci.mockResolvedValue({ items: fixtureHostPci, forbidden: false });
    mockListUsbMappings.mockResolvedValue({ items: fixtureUsbMappings, forbidden: false });
    mockListPciMappings.mockResolvedValue({ items: fixturePciMappings, forbidden: false });
  });

  afterEach(() => {
    state.fixtures = false;
    setFixtureHostListsForbidden(false);
    patchFixtureGuestConfig('pve1', 'qemu', 100, {
      usb0: undefined,
      usb1: undefined,
      hostpci0: undefined,
      serial0: undefined,
      serial1: undefined,
    });
    vi.clearAllMocks();
  });

  it('(a) token mode: add, edit and remove are disabled with the read-only tooltip', async () => {
    mockUseAuthMe.mockReturnValue(authData('token'));

    renderTab();
    await screen.findByText('USB Device (usb0)');

    for (const name of [
      'Add device',
      'Edit USB device usb0',
      'Edit PCI device hostpci0',
      'Remove usb0',
      'Remove hostpci0',
      'Remove serial0',
    ]) {
      const button = screen.getByRole('button', { name });
      expect(button).toBeDisabled();
      expect(button).toHaveAttribute('title', 'Read-only: signed in with a service token');
    }
  });

  it('(b) a session without VM.Config.HWType gets the privilege tooltip, other privileges are independent', async () => {
    mockUsePermissions.mockReturnValue(permissionsData({ 'VM.Config.CPU': true }));

    renderTab();
    await screen.findByText('USB Device (usb0)');

    for (const name of ['Add device', 'Edit USB device usb0', 'Remove usb0', 'Remove serial0']) {
      const button = screen.getByRole('button', { name });
      expect(button).toBeDisabled();
      expect(button).toHaveAttribute('title', "You don't have VM.Config.HWType on this guest");
    }
    expect(screen.getByRole('button', { name: 'Edit processors' })).toBeEnabled();
  });

  it('(c) rows list each device by slot; a serial port has remove but no edit pencil', async () => {
    renderTab();
    await screen.findByText('Devices');
    expect(screen.getByText('USB Device (usb0)').closest('tr')).toHaveTextContent('Host device 1d6b:0003, USB 3');
    expect(screen.getByText('PCI Device (hostpci0)').closest('tr')).toHaveTextContent(
      'Host device 0000:01:00.0, PCI-Express, ROM-Bar off, primary GPU',
    );
    expect(screen.getByText('Serial Port (serial0)').closest('tr')).toHaveTextContent('Socket');
    expect(screen.getByRole('button', { name: 'Remove serial0' })).toBeEnabled();
    expect(screen.queryByRole('button', { name: /^Edit .*serial0/ })).not.toBeInTheDocument();
  });

  it('(d) add USB from the host list: vendor id + USB 3 sends exactly that', async () => {
    renderTab();
    await openAddMenu('USB device');
    const dialog = await screen.findByRole('dialog');

    expect(await within(dialog).findByRole('heading', { name: 'Add USB device (usb1)' })).toBeInTheDocument();
    expect(mockGetNextDeviceSlot).toHaveBeenCalledWith('pve1', 100, 'usb');
    expect(within(dialog).getByText(/Raw USB\/PCI passthrough needs root@pam in Proxmox/)).toBeInTheDocument();
    await within(dialog).findByRole('option', { name: /1d6b:0003 — Linux Foundation 3.0 root hub/ });

    fireEvent.change(within(dialog).getByLabelText('Vendor/device ID'), { target: { value: '1d6b:0003' } });
    fireEvent.click(within(dialog).getByRole('checkbox', { name: 'USB 3' }));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Add USB device' }));

    await waitFor(() => expect(mockUpsertDevice).toHaveBeenCalledTimes(1));
    expect(mockUpsertDevice.mock.calls[0]!.slice(0, 3)).toStrictEqual(['pve1', 100, 'usb1']);
    expect(mockUpsertDevice.mock.calls[0]![3]).toStrictEqual({ kind: 'usb', source: 'vendor', id: '1d6b:0003', usb3: true });
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });

  it('(e) add USB by port picked from the list, and as a Spice port', async () => {
    renderTab();
    await openAddMenu('USB device');
    let dialog = await screen.findByRole('dialog');
    await within(dialog).findByRole('heading', { name: 'Add USB device (usb1)' });
    fireEvent.click(within(dialog).getByRole('radio', { name: 'USB port' }));
    await within(dialog).findByRole('option', { name: /2-1\.3 — SanDisk Corp\. Ultra/ });
    fireEvent.change(within(dialog).getByLabelText('Bus-port'), { target: { value: '2-1.3' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Add USB device' }));
    await waitFor(() => expect(mockUpsertDevice).toHaveBeenCalledTimes(1));
    expect(mockUpsertDevice.mock.calls[0]![3]).toStrictEqual({ kind: 'usb', source: 'port', port: '2-1.3' });
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());

    await openAddMenu('USB device');
    dialog = await screen.findByRole('dialog');
    await within(dialog).findByRole('heading', { name: 'Add USB device (usb1)' });
    fireEvent.click(within(dialog).getByRole('radio', { name: 'Spice port' }));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Add USB device' }));
    await waitFor(() => expect(mockUpsertDevice).toHaveBeenCalledTimes(2));
    expect(mockUpsertDevice.mock.calls[1]![3]).toStrictEqual({ kind: 'usb', source: 'spice' });
  });

  it('(f) add USB mapping: picks from the mapping list', async () => {
    renderTab();
    await openAddMenu('USB device');
    const dialog = await screen.findByRole('dialog');
    await within(dialog).findByRole('heading', { name: 'Add USB device (usb1)' });
    fireEvent.click(within(dialog).getByRole('radio', { name: 'Mapped device' }));
    await within(dialog).findByRole('option', { name: 'mykeyboard (Front-desk keyboard)' });
    fireEvent.change(within(dialog).getByLabelText('Mapping'), { target: { value: 'mykeyboard' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Add USB device' }));

    await waitFor(() => expect(mockUpsertDevice).toHaveBeenCalledTimes(1));
    expect(mockUpsertDevice.mock.calls[0]![3]).toStrictEqual({ kind: 'usb', source: 'mapping', mapping: 'mykeyboard' });
  });

  it('(g) add PCI raw from the host list (grouped by IOMMU group) with PCI-Express and primary GPU', async () => {
    renderTab();
    await openAddMenu('PCI device');
    const dialog = await screen.findByRole('dialog');

    expect(await within(dialog).findByRole('heading', { name: 'Add PCI device (hostpci1)' })).toBeInTheDocument();
    expect(mockGetNextDeviceSlot).toHaveBeenCalledWith('pve1', 100, 'pci');
    expect(within(dialog).getByText(/Raw USB\/PCI passthrough needs root@pam in Proxmox/)).toBeInTheDocument();
    await within(dialog).findByRole('option', { name: /0000:01:00\.0 — NVIDIA Corporation GA102 \[GeForce RTX 3090\]/ });
    expect(within(dialog).getByRole('group', { name: 'IOMMU group 1' })).toBeInTheDocument();
    // ROM-Bar defaults to on (PVE's default).
    expect(within(dialog).getByRole('checkbox', { name: 'ROM-Bar' })).toBeChecked();

    fireEvent.change(within(dialog).getByLabelText('Device'), { target: { value: '0000:01:00.0' } });
    fireEvent.click(within(dialog).getByRole('checkbox', { name: 'PCI-Express' }));
    fireEvent.click(within(dialog).getByRole('checkbox', { name: 'Primary GPU' }));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Add PCI device' }));

    await waitFor(() => expect(mockUpsertDevice).toHaveBeenCalledTimes(1));
    expect(mockUpsertDevice.mock.calls[0]!.slice(0, 3)).toStrictEqual(['pve1', 100, 'hostpci1']);
    expect(mockUpsertDevice.mock.calls[0]![3]).toStrictEqual({
      kind: 'pci',
      source: 'raw',
      id: '0000:01:00.0',
      pcie: true,
      xVga: true,
    });
  });

  it('(h) add PCI: all functions, ROM-Bar off and an MDev type are sent; a bad address blocks Add', async () => {
    renderTab();
    await openAddMenu('PCI device');
    const dialog = await screen.findByRole('dialog');
    await within(dialog).findByRole('option', { name: /0000:01:00\.0/ });

    const add = within(dialog).getByRole('button', { name: 'Add PCI device' });
    fireEvent.change(within(dialog).getByLabelText('Device'), { target: { value: '__manual__' } });
    fireEvent.change(within(dialog).getByLabelText('Device'), { target: { value: '01:0' } });
    expect(within(dialog).getByText('Enter a PCI address like 0000:01:00.0 or 01:00.')).toBeInTheDocument();
    expect(add).toBeDisabled();

    fireEvent.change(within(dialog).getByLabelText('Device'), { target: { value: '0000:01:00.0' } });
    expect(add).toBeEnabled();
    fireEvent.click(within(dialog).getByRole('checkbox', { name: 'All functions' }));
    fireEvent.click(within(dialog).getByRole('checkbox', { name: 'ROM-Bar' }));
    fireEvent.change(within(dialog).getByLabelText('MDev type'), { target: { value: 'nvidia-63' } });
    fireEvent.click(add);

    await waitFor(() => expect(mockUpsertDevice).toHaveBeenCalledTimes(1));
    expect(mockUpsertDevice.mock.calls[0]![3]).toStrictEqual({
      kind: 'pci',
      source: 'raw',
      id: '0000:01:00.0',
      allFunctions: true,
      rombar: false,
      mdev: 'nvidia-63',
    });
  });

  it('(i) add PCI mapping', async () => {
    renderTab();
    await openAddMenu('PCI device');
    const dialog = await screen.findByRole('dialog');
    await within(dialog).findByRole('heading', { name: 'Add PCI device (hostpci1)' });
    fireEvent.click(within(dialog).getByRole('radio', { name: 'Mapped device' }));
    await within(dialog).findByRole('option', { name: 'gpu0 (RTX 3090 (passthrough))' });
    fireEvent.change(within(dialog).getByLabelText('Mapping'), { target: { value: 'gpu0' } });
    fireEvent.click(within(dialog).getByRole('checkbox', { name: 'PCI-Express' }));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Add PCI device' }));

    await waitFor(() => expect(mockUpsertDevice).toHaveBeenCalledTimes(1));
    expect(mockUpsertDevice.mock.calls[0]![3]).toStrictEqual({
      kind: 'pci',
      source: 'mapping',
      mapping: 'gpu0',
      pcie: true,
    });
  });

  it('(j) add serial: a confirm naming the slot, sending a socket', async () => {
    renderTab();
    await openAddMenu('Serial port');
    const dialog = await screen.findByRole('alertdialog');

    expect(await within(dialog).findByText(/Add serial1 as a socket/)).toBeInTheDocument();
    expect(mockGetNextDeviceSlot).toHaveBeenCalledWith('pve1', 100, 'serial');
    expect(mockUpsertDevice).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Add serial port' }));

    await waitFor(() => expect(mockUpsertDevice).toHaveBeenCalledTimes(1));
    expect(mockUpsertDevice.mock.calls[0]!.slice(0, 3)).toStrictEqual(['pve1', 100, 'serial1']);
    expect(mockUpsertDevice.mock.calls[0]![3]).toStrictEqual({ kind: 'serial', target: 'socket' });
    await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument());
  });

  it('(k) edit USB prefills from the current value and sends the full desired state', async () => {
    renderTab();
    const dialog = await openDialog('Edit USB device usb0');

    expect(within(dialog).getByRole('heading', { name: 'Edit USB device (usb0)' })).toBeInTheDocument();
    expect(within(dialog).getByRole('radio', { name: 'USB vendor/device ID' })).toBeChecked();
    await within(dialog).findByRole('option', { name: /1d6b:0003/ });
    expect(within(dialog).getByLabelText('Vendor/device ID')).toHaveValue('1d6b:0003');
    expect(within(dialog).getByRole('checkbox', { name: 'USB 3' })).toBeChecked();
    // An edit never asks for a slot.
    expect(mockGetNextDeviceSlot).not.toHaveBeenCalled();

    fireEvent.click(within(dialog).getByRole('checkbox', { name: 'USB 3' }));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(mockUpsertDevice).toHaveBeenCalledTimes(1));
    expect(mockUpsertDevice.mock.calls[0]!.slice(0, 3)).toStrictEqual(['pve1', 100, 'usb0']);
    expect(mockUpsertDevice.mock.calls[0]![3]).toStrictEqual({ kind: 'usb', source: 'vendor', id: '1d6b:0003' });
  });

  it('(l) edit PCI prefills every flag from the current value', async () => {
    renderTab();
    const dialog = await openDialog('Edit PCI device hostpci0');

    expect(within(dialog).getByRole('heading', { name: 'Edit PCI device (hostpci0)' })).toBeInTheDocument();
    expect(within(dialog).getByRole('radio', { name: 'Raw device' })).toBeChecked();
    await within(dialog).findByRole('option', { name: /0000:01:00\.0/ });
    expect(within(dialog).getByLabelText('Device')).toHaveValue('0000:01:00.0');
    expect(within(dialog).getByRole('checkbox', { name: 'PCI-Express' })).toBeChecked();
    expect(within(dialog).getByRole('checkbox', { name: 'ROM-Bar' })).not.toBeChecked();
    expect(within(dialog).getByRole('checkbox', { name: 'Primary GPU' })).toBeChecked();
    expect(within(dialog).getByRole('checkbox', { name: 'All functions' })).not.toBeChecked();

    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(mockUpsertDevice).toHaveBeenCalledTimes(1));
    expect(mockUpsertDevice.mock.calls[0]![3]).toStrictEqual({
      kind: 'pci',
      source: 'raw',
      id: '0000:01:00.0',
      pcie: true,
      rombar: false,
      xVga: true,
    });
  });

  it('(m) remove: the confirm names the slot and its value; deleteDevice is called with the slot', async () => {
    renderTab();
    fireEvent.click(await screen.findByRole('button', { name: 'Remove usb0' }));
    const dialog = await screen.findByRole('alertdialog');

    expect(within(dialog).getByText('Remove usb0?')).toBeInTheDocument();
    expect(within(dialog).getByText(/usb0 \(host=1d6b:0003,usb3=1\) is removed from this VM/)).toBeInTheDocument();
    expect(mockDeleteDevice).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Remove usb0' }));

    await waitFor(() => expect(mockDeleteDevice).toHaveBeenCalledWith('pve1', 100, 'usb0'));
    expect(mockDeleteDevice).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument());
  });

  it('(n) remove: a server error stays inline and the dialog stays open', async () => {
    const { GuestActionError } = await import('@/api/actions');
    mockDeleteDevice.mockRejectedValue(new GuestActionError(404, 'serial0 does not exist on this guest'));
    renderTab();
    fireEvent.click(await screen.findByRole('button', { name: 'Remove serial0' }));
    const dialog = await screen.findByRole('alertdialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Remove serial0' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('serial0 does not exist on this guest');
    expect(screen.getByRole('alertdialog')).toBeInTheDocument();
  });

  it('(o) forbidden host lists (no Sys.Modify / Mapping.Audit): manual entry is shown with a note', async () => {
    mockListHostUsb.mockResolvedValue({ items: [], forbidden: true });
    mockListUsbMappings.mockResolvedValue({ items: [], forbidden: true });
    renderTab();
    await openAddMenu('USB device');
    const dialog = await screen.findByRole('dialog');
    await within(dialog).findByRole('heading', { name: 'Add USB device (usb1)' });

    const input = await within(dialog).findByLabelText('Vendor/device ID');
    expect(input.tagName).toBe('INPUT');
    expect(within(dialog).getByText(/could not be listed \(Proxmox needs Sys\.Modify\)/)).toBeInTheDocument();
    fireEvent.change(input, { target: { value: '046d:c52b' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Add USB device' }));
    await waitFor(() => expect(mockUpsertDevice).toHaveBeenCalledTimes(1));
    expect(mockUpsertDevice.mock.calls[0]![3]).toStrictEqual({ kind: 'usb', source: 'vendor', id: '046d:c52b' });
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());

    // The mapping choice falls back to a text field too.
    await openAddMenu('USB device');
    const second = await screen.findByRole('dialog');
    await within(second).findByRole('heading', { name: 'Add USB device (usb1)' });
    fireEvent.click(within(second).getByRole('radio', { name: 'Mapped device' }));
    const mappingInput = await within(second).findByLabelText('Mapping');
    expect(mappingInput.tagName).toBe('INPUT');
    expect(within(second).getByText(/Proxmox needs Mapping\.Audit/)).toBeInTheDocument();
  });

  it('(p) fixture mode: add USB from the host list shows the new row; remove takes it away again', async () => {
    state.fixtures = true;
    const actual = state.actual!;
    mockUpsertDevice.mockImplementation(actual.upsertDevice);
    mockDeleteDevice.mockImplementation(actual.deleteDevice);
    mockGetNextDeviceSlot.mockImplementation(actual.getNextDeviceSlot);
    mockListHostUsb.mockImplementation(actual.listHostUsb);
    mockListUsbMappings.mockImplementation(actual.listUsbMappings);

    renderTab();
    await screen.findByText('USB Device (usb0)');
    expect(screen.queryByText('USB Device (usb1)')).not.toBeInTheDocument();

    await openAddMenu('USB device');
    const dialog = await screen.findByRole('dialog');
    await within(dialog).findByRole('heading', { name: 'Add USB device (usb1)' });
    await within(dialog).findByRole('option', { name: /046d:c52b — Logitech, Inc\. Unifying Receiver/ });
    fireEvent.change(within(dialog).getByLabelText('Vendor/device ID'), { target: { value: '046d:c52b' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Add USB device' }));

    const row = (await screen.findByText('USB Device (usb1)')).closest('tr')!;
    expect(getFixtureGuestConfig(100)?.usb1).toBe('host=046d:c52b');
    expect(row).toHaveTextContent('Host device 046d:c52b');

    fireEvent.click(within(row).getByRole('button', { name: 'Remove usb1' }));
    fireEvent.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Remove usb1' }));
    await waitFor(() => expect(screen.queryByText('USB Device (usb1)')).not.toBeInTheDocument());
    expect(getFixtureGuestConfig(100)?.usb1).toBeUndefined();
  });
});
