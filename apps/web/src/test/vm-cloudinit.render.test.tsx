import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClientProvider } from '@tanstack/react-query';

import { CloudInitTab } from '@/pages/vm/tabs/CloudInitTab';
import { createQueryClient } from '@/api/queryClient';
import { getFixtureGuestConfig, patchFixtureGuestConfig, setFixtureCloudInitPending } from '@/api/fixtures';
import type { AuthIdentity } from '@/api/client-types';
import type { GuestPermissions } from '@/api/actionHooks';

/**
 * The VM Cloud-Init tab (T54): rows for the cloud-init settings, an edit dialog per row, one IP
 * config row per NIC, a "Regenerate image" button, the pending banner, and the gating on session
 * mode + `VM.Config.Cloudinit`. `useAuthMe`/`usePermissions` are mocked so each test controls the
 * gate; the guest config comes from the real fixture client (VM 100 carries a cloud-init drive and
 * settings, VM 101 has none), and `@/api/cloudInit`'s request functions are mocked so the exact
 * request each dialog builds can be asserted. The last tests flip `USE_FIXTURES` on and run the
 * real fixture flow instead.
 */
const mockUseAuthMe = vi.fn();
const mockUsePermissions = vi.fn();
const mockUpdateCloudInit = vi.fn();
const mockRegenerateCloudInit = vi.fn();
const mockGetCloudInitPending = vi.fn();

const state = vi.hoisted(() => ({
  fixtures: false,
  actual: undefined as typeof import('@/api/cloudInit') | undefined,
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

vi.mock('@/api/cloudInit', async () => {
  const actual = await vi.importActual<typeof import('@/api/cloudInit')>('@/api/cloudInit');
  state.actual = actual;
  return {
    ...actual,
    updateCloudInit: (...args: unknown[]) => mockUpdateCloudInit(...args),
    regenerateCloudInit: (...args: unknown[]) => mockRegenerateCloudInit(...args),
    getCloudInitPending: (...args: unknown[]) => mockGetCloudInitPending(...args),
  };
});

function authData(mode: AuthIdentity['mode']) {
  return { data: { username: 'root@pam', realm: 'pam', capabilities: {}, mode } };
}

function permissionsData(privs: Record<string, boolean> | true) {
  const value: GuestPermissions = { can: (p: string) => privs === true || privs[p] === true };
  return { data: value };
}

const KEY_ED = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl admin@lab';
const KEY_RSA = 'ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAABAQC7+/abc= ops@host';

/** The Cloud-Init settings VM 100 is seeded with (`fixtures.ts`), restored after every test. */
const SEEDED = {
  ciuser: 'debian',
  cipassword: '********',
  searchdomain: 'lab.example.com',
  nameserver: '10.0.20.2 10.0.20.3',
  sshkeys: encodeURIComponent(
    'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIDemoFixtureKeyOnlyNotARealKey000000000000 admin@lab',
  ),
  ipconfig0: 'ip=10.0.20.15/24,gw=10.0.20.1',
};

function renderTab(vmid = 100) {
  const queryClient = createQueryClient();
  render(
    <QueryClientProvider client={queryClient}>
      <CloudInitTab node="pve1" type="qemu" vmid={vmid} />
    </QueryClientProvider>,
  );
}

async function openDialog(buttonName: string) {
  fireEvent.click(await screen.findByRole('button', { name: buttonName }));
  return screen.findByRole('dialog');
}

describe('VM Cloud-Init tab', () => {
  beforeEach(() => {
    state.fixtures = false;
    mockUseAuthMe.mockReturnValue(authData('session'));
    mockUsePermissions.mockReturnValue(permissionsData(true));
    mockUpdateCloudInit.mockResolvedValue({ ok: true, pending: [] });
    mockRegenerateCloudInit.mockResolvedValue({ ok: true });
    mockGetCloudInitPending.mockResolvedValue([]);
  });

  afterEach(() => {
    state.fixtures = false;
    patchFixtureGuestConfig('pve1', 'qemu', 100, {
      ...SEEDED,
      ciupgrade: undefined,
      citype: undefined,
      ipconfig1: undefined,
    });
    setFixtureCloudInitPending(100, []);
    vi.clearAllMocks();
  });

  it('(a) a VM without a Cloud-Init drive shows the empty state and no controls', async () => {
    renderTab(101);

    expect(await screen.findByText('No Cloud-Init drive. Add one on the Hardware tab.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Regenerate image' })).not.toBeInTheDocument();
    expect(screen.queryByText('User')).not.toBeInTheDocument();
  });

  it('(b) renders the settings from the config, one IP config row per NIC', async () => {
    renderTab();

    const user = (await screen.findByText('User')).closest('tr')!;
    expect(user).toHaveTextContent('debian');
    expect(screen.getByText('Password').closest('tr')).toHaveTextContent('••••••');
    expect(screen.getByText('DNS domain').closest('tr')).toHaveTextContent('lab.example.com');
    expect(screen.getByText('DNS servers').closest('tr')).toHaveTextContent('10.0.20.2 10.0.20.3');
    expect(screen.getByText('Upgrade packages').closest('tr')).toHaveTextContent('Yes');
    expect(screen.getByText('Type').closest('tr')).toHaveTextContent('Default');
    // The keys are decoded (one per line), shortened, and counted.
    const keys = screen.getByText('SSH public keys').closest('tr')!;
    expect(within(keys).getByTestId('cloudinit-key-count')).toHaveTextContent('1 key');
    expect(keys).toHaveTextContent('ssh-ed25519 AAAAC3NzaC1l…000000 admin@lab');
    expect(screen.getByText('IP Config (net0)').closest('tr')).toHaveTextContent('ip=10.0.20.15/24,gw=10.0.20.1');
    expect(screen.getByText('IP Config (net1)').closest('tr')).toHaveTextContent('Not configured');
  });

  it('(c) token mode: every pencil and the regenerate button are disabled with the read-only tooltip', async () => {
    mockUseAuthMe.mockReturnValue(authData('token'));

    renderTab();
    await screen.findByText('IP Config (net1)');

    for (const name of [
      'Edit user',
      'Edit password',
      'Edit DNS domain',
      'Edit DNS servers',
      'Edit SSH public keys',
      'Edit upgrade packages',
      'Edit type',
      'Edit IP config net0',
      'Edit IP config net1',
      'Regenerate image',
    ]) {
      const button = screen.getByRole('button', { name });
      expect(button).toBeDisabled();
      expect(button).toHaveAttribute('title', 'Read-only: signed in with a service token');
    }
  });

  it('(d) a session without VM.Config.Cloudinit gets the privilege tooltip', async () => {
    mockUsePermissions.mockReturnValue(permissionsData({ 'VM.Config.Network': true }));

    renderTab();
    await screen.findByText('IP Config (net1)');

    for (const name of ['Edit user', 'Edit password', 'Edit IP config net0', 'Regenerate image']) {
      const button = screen.getByRole('button', { name });
      expect(button).toBeDisabled();
      expect(button).toHaveAttribute('title', "You don't have VM.Config.Cloudinit on this guest");
    }
  });

  it('(e) user: sends exactly { user }; blank removes it (null); an invalid name disables Save', async () => {
    renderTab();
    const dialog = await openDialog('Edit user');
    const save = within(dialog).getByRole('button', { name: 'Save' });
    expect(within(dialog).getByLabelText('User')).toHaveValue('debian');
    expect(save).toBeDisabled(); // unchanged

    fireEvent.change(within(dialog).getByLabelText('User'), { target: { value: 'Not Valid' } });
    expect(save).toBeDisabled();
    expect(within(dialog).getByText(/Use lowercase letters/)).toBeInTheDocument();

    fireEvent.change(within(dialog).getByLabelText('User'), { target: { value: 'admin' } });
    fireEvent.click(save);
    await waitFor(() => expect(mockUpdateCloudInit).toHaveBeenCalledWith('pve1', 100, { user: 'admin' }));
    expect(mockUpdateCloudInit).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());

    const again = await openDialog('Edit user');
    fireEvent.change(within(again).getByLabelText('User'), { target: { value: '' } });
    fireEvent.click(within(again).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(mockUpdateCloudInit).toHaveBeenLastCalledWith('pve1', 100, { user: null }));
  });

  it('(f) password: needs a matching confirmation, then sends exactly { password }', async () => {
    renderTab();
    const dialog = await openDialog('Edit password');
    const save = within(dialog).getByRole('button', { name: 'Save' });
    expect(save).toBeDisabled();

    fireEvent.change(within(dialog).getByLabelText('Password'), { target: { value: 'hunter2hunter2' } });
    fireEvent.change(within(dialog).getByLabelText('Confirm password'), { target: { value: 'hunter2' } });
    expect(within(dialog).getByText('The passwords do not match.')).toBeInTheDocument();
    expect(save).toBeDisabled();

    fireEvent.change(within(dialog).getByLabelText('Confirm password'), { target: { value: 'hunter2hunter2' } });
    expect(save).toBeEnabled();
    fireEvent.click(save);
    await waitFor(() => expect(mockUpdateCloudInit).toHaveBeenCalledWith('pve1', 100, { password: 'hunter2hunter2' }));
    expect(mockUpdateCloudInit).toHaveBeenCalledTimes(1);
    // The password is never rendered back: the row shows only that one is set.
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(document.body).not.toHaveTextContent('hunter2hunter2');
  });

  it('(f2) a set password can be removed: sends { password: null }', async () => {
    renderTab();
    const dialog = await openDialog('Edit password');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Remove password' }));
    await waitFor(() => expect(mockUpdateCloudInit).toHaveBeenCalledWith('pve1', 100, { password: null }));
  });

  it('(g) IP config net0, static + gateway: sends exactly the NIC state', async () => {
    renderTab();
    const dialog = await openDialog('Edit IP config net0');
    expect(within(dialog).getByRole('heading', { name: 'Edit IP config (net0)' })).toBeInTheDocument();
    // Prefilled from ip=10.0.20.15/24,gw=10.0.20.1.
    expect(within(dialog).getByLabelText('IPv4')).toHaveValue('static');
    expect(within(dialog).getByLabelText('IPv4 address (CIDR)')).toHaveValue('10.0.20.15/24');

    fireEvent.change(within(dialog).getByLabelText('IPv4 address (CIDR)'), { target: { value: '10.0.0.5' } });
    expect(within(dialog).getByRole('button', { name: 'Save' })).toBeDisabled();
    fireEvent.change(within(dialog).getByLabelText('IPv4 address (CIDR)'), { target: { value: '10.0.0.5/24' } });
    fireEvent.change(within(dialog).getByLabelText('IPv4 gateway'), { target: { value: '10.0.0.1' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));

    await waitFor(() =>
      expect(mockUpdateCloudInit).toHaveBeenCalledWith('pve1', 100, {
        ipconfig: { net0: { ip: '10.0.0.5/24', gw: '10.0.0.1' } },
      }),
    );
    expect(mockUpdateCloudInit).toHaveBeenCalledTimes(1);
  });

  it('(g2) IP config net1 (not configured): DHCP + SLAAC; choosing none for both on net0 removes it', async () => {
    renderTab();
    const dialog = await openDialog('Edit IP config net1');
    expect(within(dialog).getByLabelText('IPv4')).toHaveValue('none');
    expect(within(dialog).getByRole('button', { name: 'Save' })).toBeDisabled();
    fireEvent.change(within(dialog).getByLabelText('IPv4'), { target: { value: 'dhcp' } });
    fireEvent.change(within(dialog).getByLabelText('IPv6'), { target: { value: 'auto' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(mockUpdateCloudInit).toHaveBeenCalledWith('pve1', 100, { ipconfig: { net1: { ip: 'dhcp', ip6: 'auto' } } }),
    );
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());

    const net0 = await openDialog('Edit IP config net0');
    fireEvent.change(within(net0).getByLabelText('IPv4'), { target: { value: 'none' } });
    fireEvent.click(within(net0).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(mockUpdateCloudInit).toHaveBeenLastCalledWith('pve1', 100, { ipconfig: { net0: null } }));
  });

  it('(h) SSH keys: two keys, one per line, sent as a list; a bad line disables Save', async () => {
    renderTab();
    const dialog = await openDialog('Edit SSH public keys');
    const save = within(dialog).getByRole('button', { name: 'Save' });
    // The stored (URL-encoded) value is shown decoded, one key per line.
    expect(within(dialog).getByLabelText('SSH public keys')).toHaveValue(
      'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIDemoFixtureKeyOnlyNotARealKey000000000000 admin@lab',
    );

    fireEvent.change(within(dialog).getByLabelText('SSH public keys'), { target: { value: `${KEY_ED}\nnot a key` } });
    expect(within(dialog).getByText(/Line 2 is not an OpenSSH public key/)).toBeInTheDocument();
    expect(save).toBeDisabled();

    fireEvent.change(within(dialog).getByLabelText('SSH public keys'), { target: { value: `${KEY_ED}\n\n${KEY_RSA}\n` } });
    expect(save).toBeEnabled();
    fireEvent.click(save);
    await waitFor(() => expect(mockUpdateCloudInit).toHaveBeenCalledWith('pve1', 100, { sshKeys: [KEY_ED, KEY_RSA] }));
  });

  it('(i) DNS servers: a space separated list is sent as an array; more than three is refused', async () => {
    renderTab();
    const dialog = await openDialog('Edit DNS servers');
    const save = within(dialog).getByRole('button', { name: 'Save' });

    fireEvent.change(within(dialog).getByLabelText('DNS servers'), { target: { value: '1.1.1.1 8.8.8.8 9.9.9.9 4.4.4.4' } });
    expect(within(dialog).getByText('At most 3 DNS servers.')).toBeInTheDocument();
    expect(save).toBeDisabled();
    fireEvent.change(within(dialog).getByLabelText('DNS servers'), { target: { value: 'dns.example.com' } });
    expect(save).toBeDisabled();

    fireEvent.change(within(dialog).getByLabelText('DNS servers'), { target: { value: '1.1.1.1  8.8.8.8' } });
    fireEvent.click(save);
    await waitFor(() =>
      expect(mockUpdateCloudInit).toHaveBeenCalledWith('pve1', 100, { nameserver: ['1.1.1.1', '8.8.8.8'] }),
    );
  });

  it('(j) DNS domain, upgrade and type each send only their own field', async () => {
    renderTab();

    const domain = await openDialog('Edit DNS domain');
    fireEvent.change(within(domain).getByLabelText('DNS domain'), { target: { value: 'corp.example.com' } });
    fireEvent.click(within(domain).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(mockUpdateCloudInit).toHaveBeenLastCalledWith('pve1', 100, { searchdomain: 'corp.example.com' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());

    const upgrade = await openDialog('Edit upgrade packages');
    expect(within(upgrade).getByRole('checkbox', { name: 'Upgrade packages on first boot' })).toBeChecked();
    fireEvent.click(within(upgrade).getByRole('checkbox', { name: 'Upgrade packages on first boot' }));
    fireEvent.click(within(upgrade).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(mockUpdateCloudInit).toHaveBeenLastCalledWith('pve1', 100, { upgrade: false }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());

    const type = await openDialog('Edit type');
    fireEvent.change(within(type).getByLabelText('Type'), { target: { value: 'configdrive2' } });
    fireEvent.click(within(type).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(mockUpdateCloudInit).toHaveBeenLastCalledWith('pve1', 100, { type: 'configdrive2' }));
    expect(mockUpdateCloudInit).toHaveBeenCalledTimes(3);
  });

  it('(k) a server error stays inline and the dialog stays open', async () => {
    const { GuestActionError } = await import('@/api/actions');
    mockUpdateCloudInit.mockRejectedValue(new GuestActionError(403, "You don't have VM.Config.Cloudinit on this guest"));

    renderTab();
    const dialog = await openDialog('Edit user');
    fireEvent.change(within(dialog).getByLabelText('User'), { target: { value: 'admin' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));

    expect(await within(dialog).findByRole('alert')).toHaveTextContent('VM.Config.Cloudinit');
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });

  it('(l) Regenerate image calls the regenerate request for the guest', async () => {
    renderTab();
    const button = await screen.findByRole('button', { name: 'Regenerate image' });
    expect(button).toBeEnabled();
    fireEvent.click(button);

    await waitFor(() => expect(mockRegenerateCloudInit).toHaveBeenCalledWith('pve1', 100));
    expect(mockRegenerateCloudInit).toHaveBeenCalledTimes(1);
    expect(mockUpdateCloudInit).not.toHaveBeenCalled();
  });

  it('(m) pending values from the cloud-init endpoint show a banner and badge their rows', async () => {
    mockGetCloudInitPending.mockResolvedValue([
      { key: 'ciuser', value: 'debian', pending: 'admin' },
      { key: 'sshkeys', value: 'x', delete: 1 },
      { key: 'nameserver', value: '10.0.20.2' },
    ]);

    renderTab();
    const banner = await screen.findByTestId('cloudinit-pending-banner');
    expect(banner).toHaveTextContent('ciuser, sshkeys');
    expect(within(screen.getByText('User').closest('tr')!).getByTestId('cloudinit-pending-badge')).toBeInTheDocument();
    expect(within(screen.getByText('SSH public keys').closest('tr')!).getByTestId('cloudinit-pending-badge')).toBeInTheDocument();
    expect(within(screen.getByText('DNS servers').closest('tr')!).queryByTestId('cloudinit-pending-badge')).not.toBeInTheDocument();
  });

  it('(n) fixture mode: saving a user and an IP config updates the rows, holds them pending, and regenerate clears it', async () => {
    state.fixtures = true;
    const actual = state.actual!;
    mockUpdateCloudInit.mockImplementation(actual.updateCloudInit);
    mockRegenerateCloudInit.mockImplementation(actual.regenerateCloudInit);
    mockGetCloudInitPending.mockImplementation(actual.getCloudInitPending);

    renderTab();
    await screen.findByText('IP Config (net1)');
    expect(screen.queryByTestId('cloudinit-pending-banner')).not.toBeInTheDocument();

    const dialog = await openDialog('Edit user');
    fireEvent.change(within(dialog).getByLabelText('User'), { target: { value: 'ops' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));

    const user = (await screen.findByText('ops')).closest('tr')!;
    expect(user).toHaveTextContent('ops');
    expect(getFixtureGuestConfig(100)?.ciuser).toBe('ops');
    // VM 100 is running, so PVE holds the change back until the image is regenerated.
    expect(await screen.findByTestId('cloudinit-pending-banner')).toHaveTextContent('ciuser');

    const ip = await openDialog('Edit IP config net1');
    fireEvent.change(within(ip).getByLabelText('IPv4'), { target: { value: 'dhcp' } });
    fireEvent.click(within(ip).getByRole('button', { name: 'Save' }));
    const row = (await screen.findByText('IP Config (net1)')).closest('tr')!;
    await waitFor(() => expect(row).toHaveTextContent('DHCP'));
    expect(getFixtureGuestConfig(100)?.ipconfig1).toBe('ip=dhcp');

    fireEvent.click(screen.getByRole('button', { name: 'Regenerate image' }));
    await waitFor(() => expect(screen.queryByTestId('cloudinit-pending-banner')).not.toBeInTheDocument());
  });

  it('(o) fixture mode: a typed password is never stored, only PVE’s mask', async () => {
    state.fixtures = true;
    mockUpdateCloudInit.mockImplementation(state.actual!.updateCloudInit);
    mockGetCloudInitPending.mockImplementation(state.actual!.getCloudInitPending);
    patchFixtureGuestConfig('pve1', 'qemu', 100, { cipassword: undefined });

    renderTab();
    expect((await screen.findByText('Password')).closest('tr')).toHaveTextContent('Not set');
    const dialog = await openDialog('Edit password');
    fireEvent.change(within(dialog).getByLabelText('Password'), { target: { value: 'correct-horse-battery' } });
    fireEvent.change(within(dialog).getByLabelText('Confirm password'), { target: { value: 'correct-horse-battery' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(screen.getByText('Password').closest('tr')).toHaveTextContent('••••••'));
    expect(getFixtureGuestConfig(100)?.cipassword).toBe('********');
    expect(JSON.stringify(getFixtureGuestConfig(100))).not.toContain('correct-horse-battery');
  });
});
