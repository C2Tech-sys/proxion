import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClientProvider } from '@tanstack/react-query';

import { OptionsTab } from '@/pages/vm/tabs/OptionsTab';
import { createQueryClient } from '@/api/queryClient';
import { getFixtureGuestConfig, patchFixtureGuestConfig } from '@/api/fixtures';
import type { AuthIdentity } from '@/api/client-types';
import type { GuestPermissions } from '@/api/actionHooks';

/**
 * The Options tab (T53): the row list, the gating on session mode + per-row privilege
 * (`VM.Config.Options` / `VM.Config.HWType` for qemu, `VM.Config.Options` / `VM.Config.Network`
 * for lxc), the exact `PATCH .../options` body each dialog builds, the reused rename dialog, the
 * pending badge, and one real fixture round trip. `useAuthMe`/`usePermissions` are mocked so each
 * test controls the gate; the config comes from the real fixture client, and `@/api/options`'s
 * request function is mocked so the payload can be asserted.
 */
const mockUseAuthMe = vi.fn();
const mockUsePermissions = vi.fn();
const mockUpdateOptions = vi.fn();
const mockUpdateGuestConfig = vi.fn();
const mockGetPending = vi.fn();

const state = vi.hoisted(() => ({
  fixtures: false,
  actual: undefined as typeof import('@/api/options') | undefined,
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

vi.mock('@/api/actions', async () => {
  const actual = await vi.importActual<typeof import('@/api/actions')>('@/api/actions');
  return { ...actual, updateGuestConfig: (...args: unknown[]) => mockUpdateGuestConfig(...args) };
});

vi.mock('@/api/hardware', async () => {
  const actual = await vi.importActual<typeof import('@/api/hardware')>('@/api/hardware');
  return { ...actual, getPendingConfig: () => mockGetPending() };
});

vi.mock('@/api/options', async () => {
  const actual = await vi.importActual<typeof import('@/api/options')>('@/api/options');
  state.actual = actual;
  return { ...actual, updateGuestOptions: (...args: unknown[]) => mockUpdateOptions(...args) };
});

function authData(mode: AuthIdentity['mode']) {
  return { data: { username: 'root@pam', realm: 'pam', capabilities: {}, mode } };
}

function permissionsData(privs: Record<string, boolean> | true) {
  const value: GuestPermissions = { can: (p: string) => privs === true || privs[p] === true };
  return { data: value };
}

type Guest = { node: string; type: 'qemu' | 'lxc'; vmid: number };
const QEMU: Guest = { node: 'pve1', type: 'qemu', vmid: 100 };
const LXC: Guest = { node: 'pve2', type: 'lxc', vmid: 200 };

function renderTab(guest: Guest = QEMU) {
  const queryClient = createQueryClient();
  render(
    <QueryClientProvider client={queryClient}>
      <OptionsTab node={guest.node} type={guest.type} vmid={guest.vmid} />
    </QueryClientProvider>,
  );
}

async function openDialog(buttonName: string) {
  fireEvent.click(await screen.findByRole('button', { name: buttonName }));
  return screen.findByRole('dialog');
}

const QEMU_PENCILS = [
  'Edit Name',
  'Edit Start at boot',
  'Edit Start/Shutdown order',
  'Edit OS Type',
  'Edit Protection',
  'Edit Tags',
  'Edit QEMU Guest Agent',
  'Edit Use local time for RTC',
  'Edit Use tablet for pointer',
  'Edit ACPI support',
  'Edit KVM hardware virtualization',
  'Edit Hotplug',
];
const QEMU_HWTYPE_PENCILS = [
  'Edit Use tablet for pointer',
  'Edit ACPI support',
  'Edit KVM hardware virtualization',
  'Edit Hotplug',
];

describe('Options tab', () => {
  beforeEach(() => {
    state.fixtures = false;
    mockUseAuthMe.mockReturnValue(authData('session'));
    mockUsePermissions.mockReturnValue(permissionsData(true));
    mockUpdateOptions.mockResolvedValue({ ok: true, changed: [], pending: [] });
    mockUpdateGuestConfig.mockResolvedValue({ ok: true, changed: ['name'] });
    mockGetPending.mockResolvedValue([]);
  });

  afterEach(() => {
    state.fixtures = false;
    // Only the fixture round trip writes to the shared in-memory configs.
    patchFixtureGuestConfig('pve1', 'qemu', 100, { tags: 'prod;web', startup: undefined, protection: undefined });
    patchFixtureGuestConfig('pve2', 'lxc', 200, { nameserver: undefined, searchdomain: undefined });
    vi.clearAllMocks();
  });

  it('(a) lists the qemu rows with their current values from the config', async () => {
    renderTab();
    await screen.findByText('Start at boot');

    const labels = screen.getAllByRole('row').map((row) => within(row).getAllByRole('cell')[0]!.textContent);
    expect(labels).toStrictEqual([
      'Name',
      'Start at boot',
      'Start/Shutdown order',
      'OS Type',
      'Protection',
      'Tags',
      'QEMU Guest Agent',
      'Use local time for RTC',
      'Use tablet for pointer',
      'ACPI support',
      'KVM hardware virtualization',
      'Hotplug',
    ]);
    const rowOf = (label: string) => screen.getByText(label).closest('tr')!;
    expect(rowOf('Name')).toHaveTextContent('web-prod-01');
    expect(rowOf('Start at boot')).toHaveTextContent('No');
    expect(rowOf('OS Type')).toHaveTextContent('Linux 6.x - 2.6 Kernel');
    expect(rowOf('Tags')).toHaveTextContent('prodweb');
    expect(rowOf('QEMU Guest Agent')).toHaveTextContent('Enabled');
    expect(rowOf('Use tablet for pointer')).toHaveTextContent('Yes');
    expect(rowOf('Hotplug')).toHaveTextContent('Network, Disk, USB (default)');
  });

  it('(b) lists the lxc rows, including the read-only Unprivileged and Architecture ones', async () => {
    renderTab(LXC);
    await screen.findByText('Hostname');

    const labels = screen.getAllByRole('row').map((row) => within(row).getAllByRole('cell')[0]!.textContent);
    expect(labels).toStrictEqual([
      'Hostname',
      'Start at boot',
      'Start/Shutdown order',
      'Protection',
      'Tags',
      'DNS servers',
      'DNS search domain',
      'Unprivileged container',
      'Architecture',
    ]);
    const rowOf = (label: string) => screen.getByText(label).closest('tr')!;
    expect(rowOf('Hostname')).toHaveTextContent('caddy-proxy');
    expect(rowOf('Unprivileged container')).toHaveTextContent('Yes');
    expect(rowOf('Architecture')).toHaveTextContent('amd64');
    // Read-only rows have no pencil.
    expect(within(rowOf('Unprivileged container')).queryByRole('button')).not.toBeInTheDocument();
    expect(within(rowOf('Architecture')).queryByRole('button')).not.toBeInTheDocument();
  });

  it('(c) token mode: every pencil is disabled with the read-only tooltip', async () => {
    mockUseAuthMe.mockReturnValue(authData('token'));

    renderTab();
    await screen.findByText('Start at boot');

    for (const name of QEMU_PENCILS) {
      const button = screen.getByRole('button', { name });
      expect(button, name).toBeDisabled();
      expect(button, name).toHaveAttribute('title', 'Read-only: signed in with a service token');
    }
  });

  it('(d) qemu privilege gate: HWType rows need VM.Config.HWType, the rest VM.Config.Options', async () => {
    mockUsePermissions.mockReturnValue(permissionsData({ 'VM.Config.Options': true }));

    renderTab();
    await screen.findByText('Start at boot');

    for (const name of QEMU_PENCILS) {
      const button = screen.getByRole('button', { name });
      if (QEMU_HWTYPE_PENCILS.includes(name)) {
        expect(button, name).toBeDisabled();
        expect(button, name).toHaveAttribute('title', "You don't have VM.Config.HWType on this guest");
      } else {
        expect(button, name).toBeEnabled();
      }
    }
  });

  it('(d2) qemu privilege gate: with only VM.Config.HWType the Options rows are disabled instead', async () => {
    mockUsePermissions.mockReturnValue(permissionsData({ 'VM.Config.HWType': true }));

    renderTab();
    await screen.findByText('Start at boot');

    for (const name of QEMU_PENCILS) {
      const button = screen.getByRole('button', { name });
      if (QEMU_HWTYPE_PENCILS.includes(name)) {
        expect(button, name).toBeEnabled();
      } else {
        expect(button, name).toBeDisabled();
        expect(button, name).toHaveAttribute('title', "You don't have VM.Config.Options on this guest");
      }
    }
  });

  it('(e) lxc privilege gate: DNS rows need VM.Config.Network, onboot/startup/protection/tags VM.Config.Options', async () => {
    mockUsePermissions.mockReturnValue(permissionsData({ 'VM.Config.Options': true }));
    renderTab(LXC);
    await screen.findByText('Hostname');
    for (const name of ['Edit Start at boot', 'Edit Start/Shutdown order', 'Edit Protection', 'Edit Tags']) {
      expect(screen.getByRole('button', { name }), name).toBeEnabled();
    }
    for (const name of ['Edit DNS servers', 'Edit DNS search domain']) {
      const button = screen.getByRole('button', { name });
      expect(button, name).toBeDisabled();
      expect(button, name).toHaveAttribute('title', "You don't have VM.Config.Network on this guest");
    }
  });

  it('(e2) lxc privilege gate: with only VM.Config.Network the DNS rows are enabled and the Options rows are not', async () => {
    mockUsePermissions.mockReturnValue(permissionsData({ 'VM.Config.Network': true }));
    renderTab(LXC);
    await screen.findByText('Hostname');
    for (const name of ['Edit DNS servers', 'Edit DNS search domain']) {
      expect(screen.getByRole('button', { name }), name).toBeEnabled();
    }
    for (const name of ['Edit Start at boot', 'Edit Tags']) {
      const button = screen.getByRole('button', { name });
      expect(button, name).toBeDisabled();
      expect(button, name).toHaveAttribute('title', "You don't have VM.Config.Options on this guest");
    }
  });

  it('(f) startup: sends exactly order/up/down', async () => {
    renderTab();
    const dialog = await openDialog('Edit Start/Shutdown order');
    const save = within(dialog).getByRole('button', { name: 'Save' });
    expect(save).toBeDisabled();
    fireEvent.change(within(dialog).getByLabelText('Start order'), { target: { value: '3' } });
    fireEvent.change(within(dialog).getByLabelText('Startup delay (s)'), { target: { value: '30' } });
    fireEvent.change(within(dialog).getByLabelText('Shutdown timeout (s)'), { target: { value: '60' } });
    fireEvent.click(save);

    await waitFor(() => expect(mockUpdateOptions).toHaveBeenCalledTimes(1));
    expect(mockUpdateOptions.mock.calls[0]).toStrictEqual(['pve1', 'qemu', 100, { startup: { order: 3, up: 30, down: 60 } }]);
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });

  it('(f2) startup: blanking every field of an existing startup sends null (clears it)', async () => {
    patchFixtureGuestConfig('pve1', 'qemu', 100, { startup: 'order=1' });

    renderTab();
    const dialog = await openDialog('Edit Start/Shutdown order');
    expect(within(dialog).getByLabelText('Start order')).toHaveValue(1);
    fireEvent.change(within(dialog).getByLabelText('Start order'), { target: { value: '' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(mockUpdateOptions).toHaveBeenCalledTimes(1));
    expect(mockUpdateOptions.mock.calls[0]).toStrictEqual(['pve1', 'qemu', 100, { startup: null }]);
  });

  it('(g) agent: toggling fstrim sends the full agent object', async () => {
    renderTab();
    const dialog = await openDialog('Edit QEMU Guest Agent');
    expect(within(dialog).getByRole('checkbox', { name: 'Use QEMU Guest Agent' })).toBeChecked();
    fireEvent.click(within(dialog).getByRole('checkbox', { name: 'Trim cloned disks (fstrim)' }));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(mockUpdateOptions).toHaveBeenCalledTimes(1));
    expect(mockUpdateOptions.mock.calls[0]).toStrictEqual([
      'pve1',
      'qemu',
      100,
      { agent: { enabled: true, fstrimClonedDisks: true } },
    ]);
  });

  it('(h) tags: sends the parsed list, refuses an invalid tag, and an emptied field sends []', async () => {
    renderTab();
    const dialog = await openDialog('Edit Tags');
    const input = within(dialog).getByLabelText('Tags');
    expect(input).toHaveValue('prod web');

    fireEvent.change(input, { target: { value: 'prod, bad;tag!' } });
    expect(within(dialog).getByRole('alert')).toHaveTextContent('"tag!" is not a valid tag');
    expect(within(dialog).getByRole('button', { name: 'Save' })).toBeDisabled();

    fireEvent.change(input, { target: { value: 'prod web db_1' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(mockUpdateOptions).toHaveBeenCalledTimes(1));
    expect(mockUpdateOptions.mock.calls[0]).toStrictEqual(['pve1', 'qemu', 100, { tags: ['prod', 'web', 'db_1'] }]);
  });

  it('(i) lxc DNS: sends the non-blank servers; an invalid address is refused', async () => {
    renderTab(LXC);
    const dialog = await openDialog('Edit DNS servers');
    fireEvent.change(within(dialog).getByLabelText('DNS server 1'), { target: { value: 'dns.example.com' } });
    expect(within(dialog).getByRole('alert')).toHaveTextContent('"dns.example.com" is not an IPv4 or IPv6 address');
    expect(within(dialog).getByRole('button', { name: 'Save' })).toBeDisabled();

    fireEvent.change(within(dialog).getByLabelText('DNS server 1'), { target: { value: '1.1.1.1' } });
    fireEvent.change(within(dialog).getByLabelText('DNS server 2'), { target: { value: '8.8.8.8' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(mockUpdateOptions).toHaveBeenCalledTimes(1));
    expect(mockUpdateOptions.mock.calls[0]).toStrictEqual([
      'pve2',
      'lxc',
      200,
      { nameserver: ['1.1.1.1', '8.8.8.8'] },
    ]);
  });

  it('(j) protection asks for confirmation and sends nothing until it is given', async () => {
    renderTab();
    const dialog = await openDialog('Edit Protection');
    expect(within(dialog).getByRole('heading', { name: 'Turn on protection?' })).toBeInTheDocument();
    expect(mockUpdateOptions).not.toHaveBeenCalled();

    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(mockUpdateOptions).not.toHaveBeenCalled();

    const again = await openDialog('Edit Protection');
    fireEvent.click(within(again).getByRole('button', { name: 'Turn on protection' }));
    await waitFor(() => expect(mockUpdateOptions).toHaveBeenCalledTimes(1));
    expect(mockUpdateOptions.mock.calls[0]).toStrictEqual(['pve1', 'qemu', 100, { protection: true }]);
  });

  it('(k) Name reuses the rename dialog and the existing config action, not the options route', async () => {
    renderTab();
    const dialog = await openDialog('Edit Name');
    expect(within(dialog).getByRole('heading', { name: 'Rename web-prod-01' })).toBeInTheDocument();
    fireEvent.change(within(dialog).getByLabelText('Guest name'), { target: { value: 'web-prod-09' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Rename' }));

    await waitFor(() => expect(mockUpdateGuestConfig).toHaveBeenCalledTimes(1));
    expect(mockUpdateGuestConfig.mock.calls[0]).toStrictEqual(['pve1', 'qemu', 100, { name: 'web-prod-09' }]);
    expect(mockUpdateOptions).not.toHaveBeenCalled();
  });

  it('(l) a pending change badges its row and shows the banner', async () => {
    mockGetPending.mockResolvedValue([
      { key: 'tablet', value: 1, pending: 0 },
      { key: 'name', value: 'web-prod-01' },
    ]);

    renderTab();
    expect(await screen.findByTestId('hardware-pending-banner')).toHaveTextContent('Changes pending a restart: tablet');
    const badged = screen.getAllByTestId('options-pending-badge');
    expect(badged).toHaveLength(1);
    expect(badged[0]!.closest('tr')).toHaveTextContent('Use tablet for pointer');
  });

  it('(m) fixture mode round trip: saving tags writes the config and the row shows the new tags', async () => {
    state.fixtures = true;
    mockUpdateOptions.mockImplementation(state.actual!.updateGuestOptions);

    renderTab();
    const dialog = await openDialog('Edit Tags');
    fireEvent.change(within(dialog).getByLabelText('Tags'), { target: { value: 'prod web edge' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(getFixtureGuestConfig(100)?.tags).toBe('prod;web;edge'));
    await waitFor(() => expect(screen.getByTestId('options-tags')).toHaveTextContent('prodwebedge'));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });
});
