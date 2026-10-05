import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClientProvider } from '@tanstack/react-query';

import { FirewallTab } from '@/pages/vm/tabs/FirewallTab';
import { createQueryClient } from '@/api/queryClient';
import { getFixtureFirewall, resetFixtureFirewall } from '@/api/fixtures';
import type { AuthIdentity } from '@/api/client-types';
import type { GuestPermissions } from '@/api/actionHooks';

/**
 * The Firewall tab (T56): the options card, the rules table and its row actions, the rule dialog,
 * and the gating on session mode + `VM.Config.Network`. `useAuthMe`/`usePermissions` are mocked so
 * each test controls the gate; `@/api/firewall`'s request functions are mocked so the exact request
 * each control builds can be asserted (reads are served from the fixture data, with the digest
 * every real read carries). The last tests flip `USE_FIXTURES` on and run the real fixture flow.
 */
const mockUseAuthMe = vi.fn();
const mockUsePermissions = vi.fn();
const mockGetRules = vi.fn();
const mockGetOptions = vi.fn();
const mockGetGroups = vi.fn();
const mockGetMacros = vi.fn();
const mockAddRule = vi.fn();
const mockUpdateRule = vi.fn();
const mockDeleteRule = vi.fn();
const mockUpdateOptions = vi.fn();

const state = vi.hoisted(() => ({
  fixtures: false,
  actual: undefined as typeof import('@/api/firewall') | undefined,
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
  return { ...actual, useAuthMe: () => mockUseAuthMe() };
});

vi.mock('@/api/actionHooks', async () => {
  const actual = await vi.importActual<typeof import('@/api/actionHooks')>('@/api/actionHooks');
  return { ...actual, usePermissions: (vmid: number) => mockUsePermissions(vmid) };
});

vi.mock('@/api/firewall', async () => {
  const actual = await vi.importActual<typeof import('@/api/firewall')>('@/api/firewall');
  state.actual = actual;
  return {
    ...actual,
    getFirewallRules: (...args: unknown[]) => mockGetRules(...args),
    getFirewallOptions: (...args: unknown[]) => mockGetOptions(...args),
    getSecurityGroups: (...args: unknown[]) => mockGetGroups(...args),
    getMacros: (...args: unknown[]) => mockGetMacros(...args),
    addFirewallRule: (...args: unknown[]) => mockAddRule(...args),
    updateFirewallRule: (...args: unknown[]) => mockUpdateRule(...args),
    deleteFirewallRule: (...args: unknown[]) => mockDeleteRule(...args),
    updateFirewallOptions: (...args: unknown[]) => mockUpdateOptions(...args),
  };
});

function authData(mode: AuthIdentity['mode']) {
  return { data: { username: 'root@pam', realm: 'pam', capabilities: {}, mode } };
}

function permissionsData(privs: Record<string, boolean> | true) {
  const value: GuestPermissions = { can: (p: string) => privs === true || privs[p] === true };
  return { data: value };
}

const GROUPS = [
  { group: 'dbservers', comment: 'Database ports' },
  { group: 'webservers', comment: 'HTTP and HTTPS' },
];
const MACROS = [
  { macro: 'HTTPS', descr: 'HTTP over TLS' },
  { macro: 'SSH', descr: 'Secure shell' },
];

/** The fixture firewall of `vmid`, shaped like a real read (every rule carries the digest). */
async function fixtureRules(_node: string, _type: string, vmid: number) {
  const fw = getFixtureFirewall(vmid);
  return fw.rules.map((rule) => ({ ...rule, digest: fw.digest }));
}

async function fixtureOptions(_node: string, _type: string, vmid: number) {
  const fw = getFixtureFirewall(vmid);
  return state.actual!.normalizeFirewallOptions({ ...fw.options, digest: fw.digest });
}

const DIGEST_100 = 'fixture-fw-100-1';

function renderTab(guest: { node: string; type: 'qemu' | 'lxc'; vmid: number } = { node: 'pve1', type: 'qemu', vmid: 100 }) {
  const queryClient = createQueryClient();
  render(
    <QueryClientProvider client={queryClient}>
      <FirewallTab node={guest.node} type={guest.type} vmid={guest.vmid} />
    </QueryClientProvider>,
  );
}

async function openDialog(buttonName: string) {
  fireEvent.click(await screen.findByRole('button', { name: buttonName }));
  return screen.findByRole('dialog');
}

describe('Firewall tab', () => {
  beforeEach(() => {
    state.fixtures = false;
    mockUseAuthMe.mockReturnValue(authData('session'));
    mockUsePermissions.mockReturnValue(permissionsData(true));
    mockGetRules.mockImplementation(fixtureRules);
    mockGetOptions.mockImplementation(fixtureOptions);
    mockGetGroups.mockResolvedValue(GROUPS);
    mockGetMacros.mockResolvedValue(MACROS);
    mockAddRule.mockResolvedValue(undefined);
    mockUpdateRule.mockResolvedValue(undefined);
    mockDeleteRule.mockResolvedValue(undefined);
    mockUpdateOptions.mockResolvedValue(undefined);
  });

  afterEach(() => {
    state.fixtures = false;
    resetFixtureFirewall();
    vi.clearAllMocks();
  });

  it('(a) renders the guest\'s rules from the fixtures, in order, with every column', async () => {
    renderTab();
    const ssh = await screen.findByTestId('firewall-rule-0');

    expect(screen.getAllByTestId(/^firewall-rule-\d+$/)).toHaveLength(4);
    for (const header of ['Type', 'Action', 'Macro', 'Protocol', 'Source', 'Destination', 'S.Port', 'D.Port', 'Interface', 'Log', 'Comment']) {
      expect(screen.getByRole('columnheader', { name: header })).toBeInTheDocument();
    }
    expect(ssh).toHaveTextContent('inACCEPTSSH');
    expect(ssh).toHaveTextContent('10.0.0.0/24');
    expect(ssh).toHaveTextContent('SSH from the office');
    expect(screen.getByRole('checkbox', { name: 'Enable rule 0' })).toBeChecked();

    expect(screen.getByTestId('firewall-rule-1')).toHaveTextContent('tcp');
    expect(screen.getByTestId('firewall-rule-1')).toHaveTextContent('80,443');
    expect(screen.getByRole('checkbox', { name: 'Enable rule 2' })).not.toBeChecked();
    expect(screen.getByTestId('firewall-rule-3')).toHaveTextContent('groupwebservers');
    expect(screen.getByTestId('firewall-rule-3')).toHaveTextContent('net0');
  });

  it('(a2) a container shows its own rules and an empty guest shows the empty state', async () => {
    renderTab({ node: 'pve2', type: 'lxc', vmid: 200 });
    expect(await screen.findByTestId('firewall-rule-2')).toHaveTextContent('192.168.0.0/16');
    expect(screen.getAllByTestId(/^firewall-rule-\d+$/)).toHaveLength(3);
    expect(screen.getByTestId('firewall-rule-0')).toHaveTextContent('No outbound SMTP');
  });

  it('(b) renders the options: switches, policies and log levels', async () => {
    renderTab();
    await screen.findByTestId('firewall-rule-0');

    expect(screen.getByRole('switch', { name: 'Firewall' })).toHaveAttribute('aria-checked', 'false');
    expect(screen.getByRole('switch', { name: 'DHCP' })).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByRole('switch', { name: 'NDP' })).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByRole('switch', { name: 'Router Advertisement' })).toHaveAttribute('aria-checked', 'false');
    expect(screen.getByRole('switch', { name: 'MAC filter' })).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByRole('switch', { name: 'IP filter' })).toHaveAttribute('aria-checked', 'false');
    expect(screen.getByLabelText('Input policy')).toHaveValue('DROP');
    expect(screen.getByLabelText('Output policy')).toHaveValue('ACCEPT');
    expect(screen.getByLabelText('Input log level')).toHaveValue('nolog');
    expect(screen.getByLabelText('Output log level')).toHaveValue('nolog');
  });

  it('(c) token mode: every control is disabled with the read-only tooltip', async () => {
    mockUseAuthMe.mockReturnValue(authData('token'));

    renderTab();
    await screen.findByTestId('firewall-rule-0');

    const reason = 'Read-only: signed in with a service token';
    const controls = [
      screen.getByRole('button', { name: 'Add rule' }),
      screen.getByRole('button', { name: 'Add security group' }),
      screen.getByRole('button', { name: 'Edit rule 0' }),
      screen.getByRole('button', { name: 'Delete rule 0' }),
      screen.getByRole('button', { name: 'Move rule 1 up' }),
      screen.getByRole('button', { name: 'Move rule 1 down' }),
      screen.getByRole('checkbox', { name: 'Enable rule 0' }),
      screen.getByRole('switch', { name: 'Firewall' }),
      screen.getByLabelText('Input policy'),
    ];
    for (const control of controls) {
      expect(control).toBeDisabled();
      expect(control).toHaveAttribute('title', reason);
    }
  });

  it('(d) a session without VM.Config.Network gets the privilege tooltip', async () => {
    mockUsePermissions.mockReturnValue(permissionsData({ 'VM.Config.CPU': true }));

    renderTab();
    await screen.findByTestId('firewall-rule-0');

    const reason = "You don't have VM.Config.Network on this guest";
    for (const control of [
      screen.getByRole('button', { name: 'Add rule' }),
      screen.getByRole('button', { name: 'Edit rule 1' }),
      screen.getByRole('button', { name: 'Delete rule 1' }),
      screen.getByRole('checkbox', { name: 'Enable rule 1' }),
      screen.getByRole('switch', { name: 'DHCP' }),
    ]) {
      expect(control).toBeDisabled();
      expect(control).toHaveAttribute('title', reason);
    }
  });

  it('(e) add rule: sends the exact payload, appended after the existing rules', async () => {
    renderTab();
    const dialog = await openDialog('Add rule');
    await within(dialog).findByRole('heading', { name: 'Add firewall rule' });
    await within(dialog).findByRole('option', { name: 'net1' });

    // Defaults: an enabled `in ACCEPT` rule; nothing else is sent until it is filled in.
    expect(within(dialog).getByLabelText('Type')).toHaveValue('in');
    expect(within(dialog).getByLabelText('Action')).toHaveValue('ACCEPT');
    fireEvent.change(within(dialog).getByLabelText('Protocol'), { target: { value: 'tcp' } });
    fireEvent.change(within(dialog).getByLabelText('Source'), { target: { value: '10.0.0.0/24' } });
    fireEvent.change(within(dialog).getByLabelText('Destination port'), { target: { value: '22' } });
    fireEvent.change(within(dialog).getByLabelText('Interface'), { target: { value: 'net0' } });
    fireEvent.change(within(dialog).getByLabelText('Log level'), { target: { value: 'info' } });
    fireEvent.change(within(dialog).getByLabelText('Comment'), { target: { value: 'ssh from the office' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));

    await waitFor(() =>
      expect(mockAddRule).toHaveBeenCalledWith('pve1', 'qemu', 100, {
        type: 'in',
        action: 'ACCEPT',
        enable: true,
        proto: 'tcp',
        source: '10.0.0.0/24',
        dport: '22',
        iface: 'net0',
        log: 'info',
        comment: 'ssh from the office',
        pos: 4,
      }),
    );
    expect(mockAddRule).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });

  it('(f) add security group: the picker lists the cluster groups and sends a group rule', async () => {
    renderTab();
    const dialog = await openDialog('Add security group');
    await within(dialog).findByRole('heading', { name: 'Add security group' });
    expect(within(dialog).getByLabelText('Type')).toHaveValue('group');
    await within(dialog).findByRole('option', { name: 'dbservers (Database ports)' });
    // No group chosen yet: nothing to save, and a group rule has no protocol/port fields.
    expect(within(dialog).getByRole('button', { name: 'Save' })).toBeDisabled();
    expect(within(dialog).queryByLabelText('Protocol')).not.toBeInTheDocument();

    fireEvent.change(within(dialog).getByLabelText('Security group'), { target: { value: 'dbservers' } });
    fireEvent.change(within(dialog).getByLabelText('Interface'), { target: { value: 'net1' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));

    await waitFor(() =>
      expect(mockAddRule).toHaveBeenCalledWith('pve1', 'qemu', 100, {
        type: 'group',
        action: 'dbservers',
        enable: true,
        iface: 'net1',
        pos: 4,
      }),
    );
  });

  it('(f2) the dialog validates inline: bad ports and a bad macro block Save; a failed lookup falls back to free text', async () => {
    mockGetGroups.mockRejectedValue(new Error('403'));
    renderTab();
    const dialog = await openDialog('Add rule');

    fireEvent.change(within(dialog).getByLabelText('Destination port'), { target: { value: '22;rm' } });
    expect(within(dialog).getByText(/Use ports/)).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: 'Save' })).toBeDisabled();
    fireEvent.change(within(dialog).getByLabelText('Destination port'), { target: { value: '8000:8100,https' } });
    expect(within(dialog).queryByText(/Use ports/)).not.toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: 'Save' })).toBeEnabled();

    fireEvent.change(within(dialog).getByLabelText('Macro'), { target: { value: 'SSH,Ping' } });
    expect(within(dialog).getByRole('button', { name: 'Save' })).toBeDisabled();
    fireEvent.change(within(dialog).getByLabelText('Macro'), { target: { value: '' } });

    fireEvent.change(within(dialog).getByLabelText('Type'), { target: { value: 'group' } });
    // The group lookup failed (or was refused): a free-text field instead of a picker.
    const group = await within(dialog).findByLabelText('Security group');
    expect(group.tagName).toBe('INPUT');
    fireEvent.change(group, { target: { value: 'ACCEPT' } });
    expect(within(dialog).getByRole('button', { name: 'Save' })).toBeDisabled();
    fireEvent.change(group, { target: { value: 'my-group' } });
    expect(within(dialog).getByRole('button', { name: 'Save' })).toBeEnabled();
  });

  it('(g) edit with a cleared dport sends a delete list and the digest, and only what changed', async () => {
    renderTab();
    const dialog = await openDialog('Edit rule 1');
    await within(dialog).findByRole('heading', { name: 'Edit firewall rule (1)' });
    expect(within(dialog).getByLabelText('Destination port')).toHaveValue('80,443');
    // Nothing changed yet: nothing to save.
    expect(within(dialog).getByRole('button', { name: 'Save' })).toBeDisabled();

    fireEvent.change(within(dialog).getByLabelText('Destination port'), { target: { value: '' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));

    await waitFor(() =>
      expect(mockUpdateRule).toHaveBeenCalledWith('pve1', 'qemu', 100, 1, { delete: ['dport'], digest: DIGEST_100 }),
    );
  });

  it('(g2) edit: a changed verdict and comment are sent together, a server error stays inline', async () => {
    const { GuestActionError } = await import('@/api/actions');
    mockUpdateRule.mockRejectedValueOnce(new GuestActionError(400, 'detected modified configuration'));
    renderTab();
    const dialog = await openDialog('Edit rule 0');
    fireEvent.change(within(dialog).getByLabelText('Action'), { target: { value: 'DROP' } });
    fireEvent.change(within(dialog).getByLabelText('Comment'), { target: { value: 'blocked' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));

    expect(await within(dialog).findByRole('alert')).toHaveTextContent('detected modified configuration');
    expect(mockUpdateRule).toHaveBeenLastCalledWith('pve1', 'qemu', 100, 0, {
      action: 'DROP',
      comment: 'blocked',
      digest: DIGEST_100,
    });
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });

  it('(h) the enable checkbox sends `enable` with the digest', async () => {
    renderTab();
    fireEvent.click(await screen.findByRole('checkbox', { name: 'Enable rule 2' }));
    await waitFor(() =>
      expect(mockUpdateRule).toHaveBeenCalledWith('pve1', 'qemu', 100, 2, { enable: true, digest: DIGEST_100 }),
    );

    fireEvent.click(screen.getByRole('checkbox', { name: 'Enable rule 0' }));
    await waitFor(() =>
      expect(mockUpdateRule).toHaveBeenLastCalledWith('pve1', 'qemu', 100, 0, { enable: false, digest: DIGEST_100 }),
    );
  });

  it('(i) move up / move down send `moveto`; the ends of the list cannot move further', async () => {
    renderTab();
    await screen.findByTestId('firewall-rule-0');
    expect(screen.getByRole('button', { name: 'Move rule 0 up' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Move rule 3 down' })).toBeDisabled();

    fireEvent.click(screen.getByRole('button', { name: 'Move rule 2 up' }));
    await waitFor(() =>
      expect(mockUpdateRule).toHaveBeenCalledWith('pve1', 'qemu', 100, 2, { moveto: 1, digest: DIGEST_100 }),
    );

    fireEvent.click(await screen.findByRole('button', { name: 'Move rule 1 down' }));
    await waitFor(() =>
      expect(mockUpdateRule).toHaveBeenLastCalledWith('pve1', 'qemu', 100, 1, { moveto: 2, digest: DIGEST_100 }),
    );
  });

  it('(j) delete: the confirm names the rule and deleteFirewallRule gets the pos and the digest', async () => {
    renderTab();
    fireEvent.click(await screen.findByRole('button', { name: 'Delete rule 1' }));
    const dialog = await screen.findByRole('alertdialog');

    expect(within(dialog).getByText('Delete firewall rule 1?')).toBeInTheDocument();
    // Nothing is sent until the destructive action is confirmed.
    expect(mockDeleteRule).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete rule' }));

    await waitFor(() => expect(mockDeleteRule).toHaveBeenCalledWith('pve1', 'qemu', 100, 1, DIGEST_100));
    expect(mockDeleteRule).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument());
  });

  it('(j2) delete: cancel sends nothing', async () => {
    renderTab();
    fireEvent.click(await screen.findByRole('button', { name: 'Delete rule 0' }));
    fireEvent.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument());
    expect(mockDeleteRule).not.toHaveBeenCalled();
  });

  it('(k) enabling the firewall with a DROP input policy asks first, then sends `enable` with the digest', async () => {
    renderTab();
    const fwSwitch = await screen.findByRole('switch', { name: 'Firewall' });
    fireEvent.click(fwSwitch);

    const dialog = await screen.findByRole('alertdialog');
    expect(within(dialog).getByText('Enable the firewall?')).toBeInTheDocument();
    expect(within(dialog).getByText(/input policy is DROP/)).toBeInTheDocument();
    expect(mockUpdateOptions).not.toHaveBeenCalled();

    // Cancel: still nothing.
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument());
    expect(mockUpdateOptions).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('switch', { name: 'Firewall' }));
    fireEvent.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Enable firewall' }));
    await waitFor(() =>
      expect(mockUpdateOptions).toHaveBeenCalledWith('pve1', 'qemu', 100, { enable: true, digest: DIGEST_100 }),
    );
    expect(mockUpdateOptions).toHaveBeenCalledTimes(1);
  });

  it('(l) the other options send one key each: a policy, a log level and a switch; disabling needs no confirm', async () => {
    renderTab({ node: 'pve2', type: 'lxc', vmid: 200 });
    await screen.findByTestId('firewall-rule-0');
    const digest200 = 'fixture-fw-200-1';
    expect(screen.getByRole('switch', { name: 'Firewall' })).toHaveAttribute('aria-checked', 'true');

    fireEvent.change(screen.getByLabelText('Input policy'), { target: { value: 'REJECT' } });
    await waitFor(() =>
      expect(mockUpdateOptions).toHaveBeenLastCalledWith('pve2', 'lxc', 200, { policy_in: 'REJECT', digest: digest200 }),
    );
    fireEvent.change(screen.getByLabelText('Input log level'), { target: { value: 'warning' } });
    await waitFor(() =>
      expect(mockUpdateOptions).toHaveBeenLastCalledWith('pve2', 'lxc', 200, { log_level_in: 'warning', digest: digest200 }),
    );
    fireEvent.click(screen.getByRole('switch', { name: 'IP filter' }));
    await waitFor(() =>
      expect(mockUpdateOptions).toHaveBeenLastCalledWith('pve2', 'lxc', 200, { ipfilter: true, digest: digest200 }),
    );

    fireEvent.click(screen.getByRole('switch', { name: 'Firewall' }));
    await waitFor(() =>
      expect(mockUpdateOptions).toHaveBeenLastCalledWith('pve2', 'lxc', 200, { enable: false, digest: digest200 }),
    );
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
  });

  it('(m) fixture mode: add, toggle, move and delete round-trip through the fixture firewall', async () => {
    state.fixtures = true;
    const actual = state.actual!;
    mockGetRules.mockImplementation(actual.getFirewallRules);
    mockGetOptions.mockImplementation(actual.getFirewallOptions);
    mockGetGroups.mockImplementation(actual.getSecurityGroups);
    mockGetMacros.mockImplementation(actual.getMacros);
    mockAddRule.mockImplementation(actual.addFirewallRule);
    mockUpdateRule.mockImplementation(actual.updateFirewallRule);
    mockDeleteRule.mockImplementation(actual.deleteFirewallRule);
    mockUpdateOptions.mockImplementation(actual.updateFirewallOptions);

    renderTab();
    await screen.findByTestId('firewall-rule-3');
    expect(screen.queryByTestId('firewall-rule-4')).not.toBeInTheDocument();

    // Add: a new rule appears at the end.
    const dialog = await openDialog('Add rule');
    fireEvent.change(within(dialog).getByLabelText('Protocol'), { target: { value: 'tcp' } });
    fireEvent.change(within(dialog).getByLabelText('Destination port'), { target: { value: '8080' } });
    fireEvent.change(within(dialog).getByLabelText('Comment'), { target: { value: 'app server' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
    const added = await screen.findByTestId('firewall-rule-4');
    expect(added).toHaveTextContent('8080');
    expect(added).toHaveTextContent('app server');

    // Toggle: the checkbox follows the re-read (the new digest is picked up, so a second change works).
    fireEvent.click(screen.getByRole('checkbox', { name: 'Enable rule 4' }));
    await waitFor(() => expect(screen.getByRole('checkbox', { name: 'Enable rule 4' })).not.toBeChecked());

    // Move up: the new rule is now at position 3.
    fireEvent.click(await screen.findByRole('button', { name: 'Move rule 4 up' }));
    await waitFor(() => expect(screen.getByTestId('firewall-rule-3')).toHaveTextContent('app server'));
    expect(screen.getByTestId('firewall-rule-4')).toHaveTextContent('webservers');

    // Options: the policy change lands in the fixture.
    fireEvent.change(screen.getByLabelText('Output policy'), { target: { value: 'DROP' } });
    await waitFor(() => expect(getFixtureFirewall(100).options.policy_out).toBe('DROP'));
    await waitFor(() => expect(screen.getByLabelText('Output policy')).toBeEnabled());

    // Delete: it goes away again.
    fireEvent.click(await screen.findByRole('button', { name: 'Delete rule 3' }));
    fireEvent.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Delete rule' }));
    await waitFor(() => expect(screen.queryByText('app server')).not.toBeInTheDocument());
    expect(screen.getAllByTestId(/^firewall-rule-\d+$/)).toHaveLength(4);
  });

  it('(n) fixture mode: a stale digest is rejected inline, an empty guest shows the empty state', async () => {
    state.fixtures = true;
    const actual = state.actual!;
    mockGetRules.mockImplementation(actual.getFirewallRules);
    mockGetOptions.mockImplementation(actual.getFirewallOptions);
    mockUpdateRule.mockImplementation(actual.updateFirewallRule);

    renderTab({ node: 'pve1', type: 'qemu', vmid: 101 });
    expect(await screen.findByText('No firewall rules.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Add rule' })).toBeEnabled();

    await expect(actual.updateFirewallRule('pve1', 'qemu', 100, 0, { enable: false, digest: 'stale' })).rejects.toThrow(
      /changed since it was loaded/,
    );
    expect(getFixtureFirewall(100).rules[0]!.enable).toBe(1);
  });
});
