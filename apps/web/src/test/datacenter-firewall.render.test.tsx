import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClientProvider } from '@tanstack/react-query';

import { ClusterFirewallTab } from '@/pages/datacenter/tabs/ClusterFirewallTab';
import { createQueryClient } from '@/api/queryClient';
import { getFixtureClusterFirewall, patchFixtureClusterOptions, resetFixtureClusterFirewall } from '@/api/fixtures';
import type { AuthIdentity } from '@/api/client-types';
import type { GuestPermissions } from '@/api/actionHooks';

/**
 * The Datacenter -> Firewall tab (T67): the cluster rules, the options card with its typed
 * "ENABLE" confirmation, security groups (and the rules inside one), aliases and IP sets, plus the
 * gating on session mode + `Sys.Modify` on `/`. `useAuthMe`/`useRootPermissions` are mocked so each
 * test controls the gate; the `@/api/clusterFirewall` write functions are mocked so the exact
 * request each control builds can be asserted (reads are served by the real fixture-mode functions,
 * with the digest every real read carries). The last test flips `USE_FIXTURES` on and runs the real
 * fixture flow end to end.
 */
const mockUseAuthMe = vi.fn();
const mockUseRootPermissions = vi.fn();
const mockGetGroups = vi.fn();
const mockGetMacros = vi.fn();

const writes = {
  addClusterRule: vi.fn(),
  updateClusterRule: vi.fn(),
  deleteClusterRule: vi.fn(),
  updateClusterOptions: vi.fn(),
  saveSecurityGroup: vi.fn(),
  deleteSecurityGroup: vi.fn(),
  createAlias: vi.fn(),
  updateAlias: vi.fn(),
  deleteAlias: vi.fn(),
  saveIpset: vi.fn(),
  deleteIpset: vi.fn(),
  addIpsetEntry: vi.fn(),
  updateIpsetEntry: vi.fn(),
  deleteIpsetEntry: vi.fn(),
};

const state = vi.hoisted(() => ({
  fixtures: false,
  /** The write functions are the real ones (fixture round trip) rather than the mocks. */
  realWrites: false,
  actual: undefined as typeof import('@/api/clusterFirewall') | undefined,
}));

// `USE_FIXTURES` is true by default in this test env (`.env.test`), which would short-circuit the
// session-mode gate to "always enabled" before the mocked `useAuthMe` ever mattered. A getter, so
// the fixture-flow test can flip it.
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

vi.mock('@/api/rootPermissionHooks', () => ({ useRootPermissions: () => mockUseRootPermissions() }));

/** Runs a real fixture-mode function with `USE_FIXTURES` on just for its synchronous prologue (the
 * fixture branch reads the flag and the data before its first await), whatever the test's gate says. */
function inFixtureMode<T>(run: () => T): T {
  const previous = state.fixtures;
  state.fixtures = true;
  try {
    return run();
  } finally {
    state.fixtures = previous;
  }
}

vi.mock('@/api/clusterFirewall', async () => {
  const actual = await vi.importActual<typeof import('@/api/clusterFirewall')>('@/api/clusterFirewall');
  state.actual = actual;
  /** A write: the mock, or the real function once `realWrites` is set. */
  const write = <K extends keyof typeof writes>(name: K) =>
    ((...args: unknown[]) =>
      state.realWrites
        ? (actual[name as keyof typeof actual] as (...a: unknown[]) => unknown)(...args)
        : (writes[name] as (...a: unknown[]) => unknown)(...args)) as never;
  /** A read: always the real fixture-mode function. */
  const read = <K extends keyof typeof actual>(name: K) =>
    ((...args: unknown[]) => inFixtureMode(() => (actual[name] as (...a: unknown[]) => unknown)(...args))) as never;
  return {
    ...actual,
    getClusterRules: read('getClusterRules'),
    getGroupRules: read('getGroupRules'),
    getClusterOptions: read('getClusterOptions'),
    getClusterGroups: read('getClusterGroups'),
    getClusterAliases: read('getClusterAliases'),
    getClusterIpsets: read('getClusterIpsets'),
    getIpsetEntries: read('getIpsetEntries'),
    getClusterRefs: read('getClusterRefs'),
    addClusterRule: write('addClusterRule'),
    updateClusterRule: write('updateClusterRule'),
    deleteClusterRule: write('deleteClusterRule'),
    updateClusterOptions: write('updateClusterOptions'),
    saveSecurityGroup: write('saveSecurityGroup'),
    deleteSecurityGroup: write('deleteSecurityGroup'),
    createAlias: write('createAlias'),
    updateAlias: write('updateAlias'),
    deleteAlias: write('deleteAlias'),
    saveIpset: write('saveIpset'),
    deleteIpset: write('deleteIpset'),
    addIpsetEntry: write('addIpsetEntry'),
    updateIpsetEntry: write('updateIpsetEntry'),
    deleteIpsetEntry: write('deleteIpsetEntry'),
  };
});

// The rule dialog's group / macro pickers come from the guest firewall module.
vi.mock('@/api/firewall', async () => {
  const actual = await vi.importActual<typeof import('@/api/firewall')>('@/api/firewall');
  return {
    ...actual,
    getSecurityGroups: (...args: unknown[]) => mockGetGroups(...args),
    getMacros: (...args: unknown[]) => mockGetMacros(...args),
  };
});

function authData(mode: AuthIdentity['mode']) {
  return { data: { username: 'root@pam', realm: 'pam', capabilities: {}, mode } };
}

function permissionsData(privs: Record<string, boolean> | true) {
  const value: GuestPermissions = { can: (p: string) => privs === true || privs[p] === true };
  return { data: value };
}

const DIGEST = 'fixture-dc-fw-1';
const CLUSTER = { kind: 'cluster' };
const TOKEN_REASON = 'Read-only: signed in with a service token';
const PRIVILEGE_REASON = "You don't have Sys.Modify on the datacenter";

function renderTab() {
  const queryClient = createQueryClient();
  render(
    <QueryClientProvider client={queryClient}>
      <ClusterFirewallTab />
    </QueryClientProvider>,
  );
}

/** Radix's TabsTrigger switches tabs on `mousedown`, not `click`. */
async function openSubTab(name: string) {
  fireEvent.mouseDown(await screen.findByRole('tab', { name }), { button: 0 });
}

async function openDialog(buttonName: string) {
  fireEvent.click(await screen.findByRole('button', { name: buttonName }));
  return screen.findByRole('dialog');
}

describe('Datacenter Firewall tab', () => {
  beforeEach(() => {
    state.fixtures = false;
    state.realWrites = false;
    mockUseAuthMe.mockReturnValue(authData('session'));
    mockUseRootPermissions.mockReturnValue(permissionsData(true));
    mockGetGroups.mockResolvedValue([
      { group: 'dbservers', comment: 'Database ports' },
      { group: 'webservers', comment: 'HTTP and HTTPS' },
    ]);
    mockGetMacros.mockResolvedValue([
      { macro: 'HTTPS', descr: 'HTTP over TLS' },
      { macro: 'SSH', descr: 'Secure shell' },
    ]);
    for (const fn of Object.values(writes)) fn.mockResolvedValue(undefined);
  });

  afterEach(() => {
    state.fixtures = false;
    state.realWrites = false;
    resetFixtureClusterFirewall();
    vi.clearAllMocks();
  });

  describe('rules', () => {
    it('renders the three cluster rules in order with their columns and enabled state', async () => {
      renderTab();
      const ssh = await screen.findByTestId('dc-fw-rule-0');

      expect(screen.getAllByTestId(/^dc-fw-rule-\d+$/)).toHaveLength(3);
      for (const header of ['Type', 'Action', 'Macro', 'Protocol', 'Source', 'Destination', 'S.Port', 'D.Port', 'Log', 'Comment']) {
        expect(screen.getByRole('columnheader', { name: header })).toBeInTheDocument();
      }
      expect(screen.queryByRole('columnheader', { name: 'Interface' })).not.toBeInTheDocument();
      expect(ssh).toHaveTextContent('inACCEPTSSH');
      expect(ssh).toHaveTextContent('10.0.0.0/24');
      expect(ssh).toHaveTextContent('SSH from the office');
      expect(screen.getByTestId('dc-fw-rule-1')).toHaveTextContent('icmp');
      expect(screen.getByTestId('dc-fw-rule-2')).toHaveTextContent('No outbound SMTP');
      expect(screen.getByRole('checkbox', { name: 'Enable rule 0' })).toBeChecked();
      expect(screen.getByRole('checkbox', { name: 'Enable rule 2' })).not.toBeChecked();
    });

    it('add rule: sends the exact payload appended after the existing rules, with no interface picker', async () => {
      renderTab();
      const dialog = await openDialog('Add rule');
      await within(dialog).findByRole('heading', { name: 'Add firewall rule' });

      expect(within(dialog).queryByLabelText('Interface')).not.toBeInTheDocument();
      fireEvent.change(within(dialog).getByLabelText('Protocol'), { target: { value: 'tcp' } });
      fireEvent.change(within(dialog).getByLabelText('Source'), { target: { value: 'dc/office' } });
      fireEvent.change(within(dialog).getByLabelText('Destination port'), { target: { value: '22' } });
      fireEvent.change(within(dialog).getByLabelText('Comment'), { target: { value: 'ssh from the alias' } });
      fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));

      await waitFor(() =>
        expect(writes.addClusterRule.mock.lastCall).toStrictEqual([
          CLUSTER,
          { type: 'in', action: 'ACCEPT', enable: true, proto: 'tcp', source: 'dc/office', dport: '22', comment: 'ssh from the alias', pos: 3 },
        ]),
      );
      expect(writes.addClusterRule).toHaveBeenCalledTimes(1);
      await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    });

    it('the source picker offers the datacenter aliases and IP sets', async () => {
      renderTab();
      const dialog = await openDialog('Add rule');
      const source = within(dialog).getByLabelText('Source');
      const list = source.getAttribute('list');
      expect(list).not.toBeNull();
      await waitFor(() => {
        const options = Array.from(document.querySelectorAll(`datalist[id="${list}"] option`)).map((o) => o.getAttribute('value'));
        expect(options).toEqual(['dc/jumphost', 'dc/office', '+dc/trusted']);
      });
    });

    it('edit rule: sends only what changed, with the digest', async () => {
      renderTab();
      const dialog = await openDialog('Edit rule 1');
      await within(dialog).findByRole('heading', { name: 'Edit firewall rule (1)' });
      expect(within(dialog).getByRole('button', { name: 'Save' })).toBeDisabled();

      fireEvent.change(within(dialog).getByLabelText('Action'), { target: { value: 'DROP' } });
      fireEvent.change(within(dialog).getByLabelText('Comment'), { target: { value: '' } });
      fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));

      await waitFor(() =>
        expect(writes.updateClusterRule.mock.lastCall).toStrictEqual([CLUSTER, 1, { action: 'DROP', delete: ['comment'], digest: DIGEST }]),
      );
    });

    it('toggle, move and delete send the position and the digest', async () => {
      renderTab();
      fireEvent.click(await screen.findByRole('checkbox', { name: 'Enable rule 2' }));
      await waitFor(() =>
        expect(writes.updateClusterRule.mock.lastCall).toStrictEqual([CLUSTER, 2, { enable: true, digest: DIGEST }]),
      );

      expect(screen.getByRole('button', { name: 'Move rule 0 up' })).toBeDisabled();
      fireEvent.click(screen.getByRole('button', { name: 'Move rule 2 up' }));
      await waitFor(() =>
        expect(writes.updateClusterRule.mock.lastCall).toStrictEqual([CLUSTER, 2, { moveto: 1, digest: DIGEST }]),
      );

      fireEvent.click(screen.getByRole('button', { name: 'Delete rule 1' }));
      const dialog = await screen.findByRole('alertdialog');
      expect(writes.deleteClusterRule).not.toHaveBeenCalled();
      fireEvent.click(within(dialog).getByRole('button', { name: 'Delete rule' }));
      await waitFor(() => expect(writes.deleteClusterRule.mock.lastCall).toStrictEqual([CLUSTER, 1, DIGEST]));
    });
  });

  describe('options', () => {
    it('renders the options from the fixture: firewall off, DROP / ACCEPT, ebtables and the rate limit', async () => {
      renderTab();
      await openSubTab('Options');

      expect(await screen.findByRole('switch', { name: 'Enable firewall' })).toHaveAttribute('aria-checked', 'false');
      expect(screen.getByLabelText('Input policy')).toHaveValue('DROP');
      expect(screen.getByLabelText('Output policy')).toHaveValue('ACCEPT');
      expect(screen.getByRole('switch', { name: 'ebtables' })).toHaveAttribute('aria-checked', 'true');
      expect(screen.getByRole('switch', { name: 'Log rate limit' })).toHaveAttribute('aria-checked', 'true');
      expect(screen.getByLabelText('Burst')).toHaveValue('5');
      expect(screen.getByLabelText('Rate')).toHaveValue('1');
      expect(screen.getByLabelText('Per')).toHaveValue('second');
      expect(screen.getByRole('button', { name: 'Save options' })).toBeDisabled();
    });

    it('enabling asks for the word ENABLE with the lock-out sentence, then sends `enable` with the digest', async () => {
      renderTab();
      await openSubTab('Options');
      fireEvent.click(await screen.findByRole('switch', { name: 'Enable firewall' }));

      const dialog = await screen.findByRole('alertdialog');
      expect(within(dialog).getByText('Enable the datacenter firewall?')).toBeInTheDocument();
      expect(
        within(dialog).getByText(
          'Enabling the datacenter firewall with an inbound DROP policy can lock you out of every node; make sure a rule allows your management traffic first.',
        ),
      ).toBeInTheDocument();
      const confirm = within(dialog).getByRole('button', { name: 'Enable firewall' });
      expect(confirm).toBeDisabled();

      fireEvent.change(within(dialog).getByLabelText('Type ENABLE to confirm'), { target: { value: 'enable' } });
      expect(confirm).toBeDisabled();
      fireEvent.change(within(dialog).getByLabelText('Type ENABLE to confirm'), { target: { value: 'ENABLE' } });
      expect(confirm).toBeEnabled();
      expect(writes.updateClusterOptions).not.toHaveBeenCalled();

      fireEvent.click(confirm);
      await waitFor(() => expect(writes.updateClusterOptions.mock.lastCall).toStrictEqual([{ enable: true, digest: DIGEST }]));
      expect(writes.updateClusterOptions).toHaveBeenCalledTimes(1);
    });

    it('cancelling the confirmation sends nothing', async () => {
      renderTab();
      await openSubTab('Options');
      fireEvent.click(await screen.findByRole('switch', { name: 'Enable firewall' }));
      fireEvent.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Cancel' }));
      await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument());
      expect(writes.updateClusterOptions).not.toHaveBeenCalled();
    });

    it('switching an enabled firewall off needs no confirmation', async () => {
      patchFixtureClusterOptions({ enable: true });
      const digestAfter = getFixtureClusterFirewall().digest;
      renderTab();
      await openSubTab('Options');
      const fwSwitch = await screen.findByRole('switch', { name: 'Enable firewall' });
      expect(fwSwitch).toHaveAttribute('aria-checked', 'true');

      fireEvent.click(fwSwitch);
      await waitFor(() =>
        expect(writes.updateClusterOptions.mock.lastCall).toStrictEqual([{ enable: false, digest: digestAfter }]),
      );
      expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    });

    it('Save options sends only the changed keys, with the composed rate limit parts and the digest', async () => {
      renderTab();
      await openSubTab('Options');
      await screen.findByRole('switch', { name: 'ebtables' });

      fireEvent.change(screen.getByLabelText('Input policy'), { target: { value: 'REJECT' } });
      fireEvent.click(screen.getByRole('switch', { name: 'ebtables' }));
      fireEvent.change(screen.getByLabelText('Burst'), { target: { value: '10' } });
      fireEvent.change(screen.getByLabelText('Rate'), { target: { value: '2' } });
      fireEvent.change(screen.getByLabelText('Per'), { target: { value: 'minute' } });
      fireEvent.click(screen.getByRole('button', { name: 'Save options' }));

      await waitFor(() =>
        expect(writes.updateClusterOptions.mock.lastCall).toStrictEqual([
          {
            policy_in: 'REJECT',
            ebtables: false,
            log_ratelimit: { enabled: true, burst: 10, rate: '2/minute' },
            digest: DIGEST,
          },
        ]),
      );
    });

    it('a bad rate blocks Save options', async () => {
      renderTab();
      await openSubTab('Options');
      await screen.findByRole('switch', { name: 'ebtables' });
      fireEvent.change(screen.getByLabelText('Rate'), { target: { value: '0' } });
      expect(screen.getByText('A whole number, 1 or more.')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Save options' })).toBeDisabled();
    });
  });

  describe('security groups', () => {
    it('lists the groups, creates one with the exact payload and validates the name', async () => {
      renderTab();
      await openSubTab('Security Groups');
      expect(await screen.findByTestId('dc-fw-group-dbservers')).toHaveTextContent('Database ports');
      expect(screen.getByTestId('dc-fw-group-webservers')).toHaveTextContent('HTTP and HTTPS');

      const dialog = await openDialog('Create group');
      fireEvent.change(within(dialog).getByLabelText('Name'), { target: { value: '1bad' } });
      expect(within(dialog).getByRole('button', { name: 'Save' })).toBeDisabled();
      fireEvent.change(within(dialog).getByLabelText('Name'), { target: { value: 'appservers' } });
      fireEvent.change(within(dialog).getByLabelText('Comment'), { target: { value: 'Application tier' } });
      fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));

      await waitFor(() =>
        expect(writes.saveSecurityGroup.mock.lastCall).toStrictEqual([{ group: 'appservers', comment: 'Application tier' }]),
      );
    });

    it('rename sends the new name as `group` and the existing one as `rename`, with the digest', async () => {
      renderTab();
      await openSubTab('Security Groups');
      const dialog = await openDialog('Edit group webservers');
      expect(within(dialog).getByRole('button', { name: 'Save' })).toBeDisabled();

      fireEvent.change(within(dialog).getByLabelText('Name'), { target: { value: 'web-tier' } });
      fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));

      await waitFor(() =>
        expect(writes.saveSecurityGroup.mock.lastCall).toStrictEqual([
          { group: 'web-tier', comment: 'HTTP and HTTPS', rename: 'webservers', digest: DIGEST },
        ]),
      );
    });

    it('a group rule: the rules of the selected group are listed and a new one goes to that group', async () => {
      renderTab();
      await openSubTab('Security Groups');
      fireEvent.click(await screen.findByRole('button', { name: 'Show rules of webservers' }));

      expect(await screen.findByTestId('dc-fw-group-rule-0')).toHaveTextContent('HTTP');
      expect(screen.getByTestId('dc-fw-group-rule-1')).toHaveTextContent('HTTPS');
      expect(screen.getByRole('heading', { name: 'Rules: webservers' })).toBeInTheDocument();

      const dialog = await openDialog('Add rule');
      // A group's own rules are in/out only (groups do not nest) and carry no interface.
      expect(within(dialog).queryByRole('option', { name: 'group (security group)' })).not.toBeInTheDocument();
      expect(within(dialog).queryByLabelText('Interface')).not.toBeInTheDocument();
      fireEvent.change(within(dialog).getByLabelText('Macro'), { target: { value: 'SSH' } });
      fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));

      await waitFor(() =>
        expect(writes.addClusterRule.mock.lastCall).toStrictEqual([
          { kind: 'group', group: 'webservers' },
          { type: 'in', action: 'ACCEPT', enable: true, macro: 'SSH', pos: 2 },
        ]),
      );
    });

    it('deleting a group asks first and sends the group name', async () => {
      renderTab();
      await openSubTab('Security Groups');
      fireEvent.click(await screen.findByRole('button', { name: 'Delete group dbservers' }));
      const dialog = await screen.findByRole('alertdialog');
      expect(writes.deleteSecurityGroup).not.toHaveBeenCalled();
      fireEvent.click(within(dialog).getByRole('button', { name: 'Delete group' }));
      await waitFor(() => expect(writes.deleteSecurityGroup.mock.lastCall).toStrictEqual(['dbservers']));
    });
  });

  describe('aliases', () => {
    it('adds an alias with the exact payload and rejects a bad address inline', async () => {
      renderTab();
      await openSubTab('Aliases');
      expect(await screen.findByTestId('dc-fw-alias-office')).toHaveTextContent('10.0.0.0/24');
      expect(screen.getByTestId('dc-fw-alias-jumphost')).toHaveTextContent('192.168.1.10');

      const dialog = await openDialog('Add alias');
      fireEvent.change(within(dialog).getByLabelText('Name'), { target: { value: 'dmz' } });
      fireEvent.change(within(dialog).getByLabelText('IP/CIDR'), { target: { value: '172.16.0.0/33' } });
      expect(within(dialog).getByText(/Use an IPv4 or IPv6 address/)).toBeInTheDocument();
      expect(within(dialog).getByRole('button', { name: 'Save' })).toBeDisabled();
      fireEvent.change(within(dialog).getByLabelText('IP/CIDR'), { target: { value: '172.16.0.0/16' } });
      fireEvent.change(within(dialog).getByLabelText('Comment'), { target: { value: 'DMZ' } });
      fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));

      await waitFor(() =>
        expect(writes.createAlias.mock.lastCall).toStrictEqual([{ name: 'dmz', cidr: '172.16.0.0/16', comment: 'DMZ' }]),
      );
    });

    it('renames an alias: the path name stays, the new name goes in `rename`, with the digest', async () => {
      renderTab();
      await openSubTab('Aliases');
      const dialog = await openDialog('Edit alias office');
      expect(within(dialog).getByRole('button', { name: 'Save' })).toBeDisabled();

      fireEvent.change(within(dialog).getByLabelText('Name'), { target: { value: 'hq' } });
      fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));

      await waitFor(() =>
        expect(writes.updateAlias.mock.lastCall).toStrictEqual([
          { name: 'office', cidr: '10.0.0.0/24', comment: 'Office LAN', rename: 'hq', digest: DIGEST },
        ]),
      );
    });

    it('deleting an alias asks first and sends the name and the digest', async () => {
      renderTab();
      await openSubTab('Aliases');
      fireEvent.click(await screen.findByRole('button', { name: 'Delete alias jumphost' }));
      fireEvent.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Delete alias' }));
      await waitFor(() => expect(writes.deleteAlias.mock.lastCall).toStrictEqual(['jumphost', DIGEST]));
    });
  });

  describe('IP sets', () => {
    it('creates a set, then adds an entry with nomatch to the selected one', async () => {
      renderTab();
      await openSubTab('IP Sets');
      expect(await screen.findByTestId('dc-fw-ipset-trusted')).toHaveTextContent('Admin networks');

      const create = await openDialog('Create IP set');
      fireEvent.change(within(create).getByLabelText('Name'), { target: { value: 'blocked' } });
      fireEvent.click(within(create).getByRole('button', { name: 'Save' }));
      await waitFor(() => expect(writes.saveIpset.mock.lastCall).toStrictEqual([{ name: 'blocked' }]));
      await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());

      fireEvent.click(screen.getByRole('button', { name: 'Show entries of trusted' }));
      expect(await screen.findByTestId('dc-fw-ipset-entry-10.0.0.0/24')).toHaveTextContent('Office');
      expect(screen.getByTestId('dc-fw-ipset-entry-192.168.1.10')).toHaveTextContent('Jump host');

      const add = await openDialog('Add entry');
      fireEvent.change(within(add).getByLabelText('IP/CIDR'), { target: { value: '10.0.0.5' } });
      fireEvent.click(within(add).getByRole('checkbox', { name: /Exclude/ }));
      fireEvent.change(within(add).getByLabelText('Comment'), { target: { value: 'not this host' } });
      fireEvent.click(within(add).getByRole('button', { name: 'Save' }));

      await waitFor(() =>
        expect(writes.addIpsetEntry.mock.lastCall).toStrictEqual([
          { name: 'trusted', cidr: '10.0.0.5', nomatch: true, comment: 'not this host' },
        ]),
      );
    });

    it('edits an entry (address fixed, nomatch + comment) and removes one, with the digest', async () => {
      renderTab();
      await openSubTab('IP Sets');
      fireEvent.click(await screen.findByRole('button', { name: 'Show entries of trusted' }));

      const edit = await openDialog('Edit entry 10.0.0.0/24');
      expect(within(edit).getByLabelText('IP/CIDR')).toBeDisabled();
      fireEvent.click(within(edit).getByRole('checkbox', { name: /Exclude/ }));
      fireEvent.click(within(edit).getByRole('button', { name: 'Save' }));
      await waitFor(() =>
        expect(writes.updateIpsetEntry.mock.lastCall).toStrictEqual([
          { name: 'trusted', cidr: '10.0.0.0/24', nomatch: true, comment: 'Office', digest: DIGEST },
        ]),
      );
      await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());

      fireEvent.click(await screen.findByRole('button', { name: 'Remove entry 192.168.1.10' }));
      fireEvent.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Remove entry' }));
      await waitFor(() => expect(writes.deleteIpsetEntry.mock.lastCall).toStrictEqual(['trusted', '192.168.1.10', DIGEST]));
    });

    it('deleting a set says its entries go too and sends force', async () => {
      renderTab();
      await openSubTab('IP Sets');
      fireEvent.click(await screen.findByRole('button', { name: 'Delete IP set trusted' }));
      const dialog = await screen.findByRole('alertdialog');
      expect(within(dialog).getByText(/every entry in it are removed/)).toBeInTheDocument();
      fireEvent.click(within(dialog).getByRole('button', { name: 'Delete IP set' }));
      await waitFor(() => expect(writes.deleteIpset.mock.lastCall).toStrictEqual(['trusted', true]));
    });
  });

  describe('gating', () => {
    it('token mode: every control on every sub-tab is disabled with the read-only tooltip', async () => {
      mockUseAuthMe.mockReturnValue(authData('token'));
      renderTab();

      await screen.findByTestId('dc-fw-rule-0');
      for (const control of [
        screen.getByRole('button', { name: 'Add rule' }),
        screen.getByRole('button', { name: 'Add security group' }),
        screen.getByRole('button', { name: 'Edit rule 0' }),
        screen.getByRole('button', { name: 'Delete rule 0' }),
        screen.getByRole('button', { name: 'Move rule 1 up' }),
        screen.getByRole('checkbox', { name: 'Enable rule 0' }),
      ]) {
        expect(control).toBeDisabled();
        expect(control).toHaveAttribute('title', TOKEN_REASON);
      }

      await openSubTab('Options');
      for (const control of [
        await screen.findByRole('switch', { name: 'Enable firewall' }),
        screen.getByLabelText('Input policy'),
        screen.getByRole('switch', { name: 'ebtables' }),
      ]) {
        expect(control).toBeDisabled();
        expect(control).toHaveAttribute('title', TOKEN_REASON);
      }

      await openSubTab('Security Groups');
      for (const name of ['Create group', 'Edit group webservers', 'Delete group webservers']) {
        const control = await screen.findByRole('button', { name });
        expect(control).toBeDisabled();
        expect(control).toHaveAttribute('title', TOKEN_REASON);
      }

      await openSubTab('Aliases');
      for (const name of ['Add alias', 'Edit alias office', 'Delete alias office']) {
        const control = await screen.findByRole('button', { name });
        expect(control).toBeDisabled();
        expect(control).toHaveAttribute('title', TOKEN_REASON);
      }

      await openSubTab('IP Sets');
      for (const name of ['Create IP set', 'Edit IP set trusted', 'Delete IP set trusted']) {
        const control = await screen.findByRole('button', { name });
        expect(control).toBeDisabled();
        expect(control).toHaveAttribute('title', TOKEN_REASON);
      }
    });

    it('a session without Sys.Modify on / gets the privilege tooltip', async () => {
      mockUseRootPermissions.mockReturnValue(permissionsData({ 'Sys.Audit': true }));
      renderTab();

      await screen.findByTestId('dc-fw-rule-0');
      for (const control of [
        screen.getByRole('button', { name: 'Add rule' }),
        screen.getByRole('button', { name: 'Edit rule 1' }),
        screen.getByRole('button', { name: 'Delete rule 1' }),
        screen.getByRole('checkbox', { name: 'Enable rule 1' }),
      ]) {
        expect(control).toBeDisabled();
        expect(control).toHaveAttribute('title', PRIVILEGE_REASON);
      }

      await openSubTab('Options');
      const fwSwitch = await screen.findByRole('switch', { name: 'Enable firewall' });
      expect(fwSwitch).toBeDisabled();
      expect(fwSwitch).toHaveAttribute('title', PRIVILEGE_REASON);
    });

    it('a failed permission lookup keeps the controls disabled', async () => {
      mockUseRootPermissions.mockReturnValue({ data: undefined });
      renderTab();
      expect(await screen.findByRole('button', { name: 'Add rule' })).toBeDisabled();
    });
  });

  describe('fixture round trip', () => {
    it('add a rule, enable the firewall, add an alias and an IP set entry against the fixture store', async () => {
      state.fixtures = true;
      state.realWrites = true;
      renderTab();

      // Rules: a new rule appears at the end.
      const dialog = await openDialog('Add rule');
      fireEvent.change(within(dialog).getByLabelText('Destination port'), { target: { value: '8006' } });
      fireEvent.change(within(dialog).getByLabelText('Protocol'), { target: { value: 'tcp' } });
      fireEvent.change(within(dialog).getByLabelText('Comment'), { target: { value: 'Web UI' } });
      fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
      expect(await screen.findByTestId('dc-fw-rule-3')).toHaveTextContent('Web UI');
      expect(getFixtureClusterFirewall().rules).toHaveLength(4);

      // Options: enabling needs the typed word, then the switch reads back as on.
      await openSubTab('Options');
      fireEvent.click(await screen.findByRole('switch', { name: 'Enable firewall' }));
      const confirm = await screen.findByRole('alertdialog');
      fireEvent.change(within(confirm).getByLabelText('Type ENABLE to confirm'), { target: { value: 'ENABLE' } });
      fireEvent.click(within(confirm).getByRole('button', { name: 'Enable firewall' }));
      await waitFor(() => expect(screen.getByRole('switch', { name: 'Enable firewall' })).toHaveAttribute('aria-checked', 'true'));
      expect(getFixtureClusterFirewall().options.enable).toBe(1);

      // Aliases: a new one is listed.
      await openSubTab('Aliases');
      const alias = await openDialog('Add alias');
      fireEvent.change(within(alias).getByLabelText('Name'), { target: { value: 'dmz' } });
      fireEvent.change(within(alias).getByLabelText('IP/CIDR'), { target: { value: 'fd00::/64' } });
      fireEvent.click(within(alias).getByRole('button', { name: 'Save' }));
      expect(await screen.findByTestId('dc-fw-alias-dmz')).toHaveTextContent('fd00::/64');

      // IP sets: an entry with nomatch is added to the existing set.
      await openSubTab('IP Sets');
      fireEvent.click(await screen.findByRole('button', { name: 'Show entries of trusted' }));
      const entry = await openDialog('Add entry');
      fireEvent.change(within(entry).getByLabelText('IP/CIDR'), { target: { value: '10.0.0.5' } });
      fireEvent.click(within(entry).getByRole('checkbox', { name: /Exclude/ }));
      fireEvent.click(within(entry).getByRole('button', { name: 'Save' }));
      expect(await screen.findByTestId('dc-fw-ipset-entry-10.0.0.5')).toHaveTextContent('nomatch');
      expect(getFixtureClusterFirewall().ipsets[0]?.entries.at(-1)).toStrictEqual({ cidr: '10.0.0.5', nomatch: true });
    });

    it('a stale digest is rejected inline and a duplicate alias name is refused', async () => {
      state.fixtures = true;
      state.realWrites = true;
      renderTab();

      await screen.findByTestId('dc-fw-rule-0');
      // Another session changes the firewall after this one loaded it.
      patchFixtureClusterOptions({ policy_out: 'DROP' });
      fireEvent.click(screen.getByRole('button', { name: 'Edit rule 0' }));
      const dialog = await screen.findByRole('dialog');
      fireEvent.change(within(dialog).getByLabelText('Comment'), { target: { value: 'changed' } });
      fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
      expect(await within(dialog).findByRole('alert')).toHaveTextContent(
        'The firewall configuration changed since it was loaded. Reload and try again.',
      );
      fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));

      await openSubTab('Aliases');
      const alias = await openDialog('Add alias');
      fireEvent.change(within(alias).getByLabelText('Name'), { target: { value: 'office' } });
      fireEvent.change(within(alias).getByLabelText('IP/CIDR'), { target: { value: '10.9.9.0/24' } });
      fireEvent.click(within(alias).getByRole('button', { name: 'Save' }));
      expect(await within(alias).findByRole('alert')).toHaveTextContent("Alias 'office' already exists");
    });
  });
});
