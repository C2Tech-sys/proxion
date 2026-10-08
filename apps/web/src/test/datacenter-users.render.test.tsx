import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClientProvider } from '@tanstack/react-query';

import { UsersTab } from '@/pages/datacenter/tabs/UsersTab';
import { createQueryClient } from '@/api/queryClient';
import {
  getFixtureAccessAcl,
  getFixtureAccessGroups,
  getFixtureAccessPools,
  getFixtureAccessRealms,
  getFixtureAccessRoles,
  getFixtureAccessUsers,
  resetFixtureAccess,
} from '@/api/fixtures';
import type { AuthIdentity } from '@/api/client-types';
import type { GuestPermissions } from '@/api/actionHooks';

/**
 * Datacenter -> Users & Permissions (T68). `useAuthMe` / `usePathPermissions` are mocked so each
 * test controls the session and privilege gates; the lists come from the real access fixtures; the
 * write functions of `@/api/access` are mocked so the exact request each dialog builds can be
 * asserted. The last test flips `USE_FIXTURES` on and runs the real fixture round trip instead.
 */
const mockUseAuthMe = vi.fn();
const mockPathPermissions = vi.fn();
const mockCreateUser = vi.fn();
const mockUpdateUser = vi.fn();
const mockDeleteUser = vi.fn();
const mockChangePassword = vi.fn();
const mockCreateGroup = vi.fn();
const mockUpdateGroup = vi.fn();
const mockDeleteGroup = vi.fn();
const mockSetAcl = vi.fn();
const mockCreateToken = vi.fn();
const mockDeleteToken = vi.fn();

const state = vi.hoisted(() => ({
  fixtures: false,
  actual: undefined as typeof import('@/api/access') | undefined,
}));

// `USE_FIXTURES` is true by default in this test env (`.env.test`); a getter so each test picks.
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
    // Path suggestions: a small fixed cluster (the real hook would poll the live-state endpoints).
    useClusterResources: () => ({
      data: [
        { id: 'node/pve1', type: 'node', node: 'pve1', status: 'online' },
        { id: 'qemu/100', type: 'qemu', node: 'pve1', status: 'running', vmid: 100 },
        { id: 'storage/pve1/local', type: 'storage', node: 'pve1', status: 'available', storage: 'local' },
      ],
    }),
  };
});

vi.mock('@/api/accessPermissionHooks', () => ({
  usePathPermissions: (path: string) => mockPathPermissions(path),
}));

vi.mock('@/api/access', async () => {
  const actual = await vi.importActual<typeof import('@/api/access')>('@/api/access');
  state.actual = actual;
  // Writes: the real fixture implementation in the round-trip test, the spy everywhere else.
  const write = <A extends unknown[], R>(real: (...a: A) => R, spy: (...a: A) => unknown) =>
    ((...a: A) => (state.fixtures ? real(...a) : spy(...a))) as (...a: A) => R;
  return {
    ...actual,
    // Reads: always the fixture data (the real reads would `fetch` outside fixture mode).
    getUsers: async () => getFixtureAccessUsers(),
    getGroups: async () => getFixtureAccessGroups(),
    getRoles: async () => getFixtureAccessRoles(),
    getAcl: async () => getFixtureAccessAcl(),
    getRealms: async () => getFixtureAccessRealms(),
    getPoolIds: async () => getFixtureAccessPools(),
    createUser: write(actual.createUser, (...a) => mockCreateUser(...a)),
    updateUser: write(actual.updateUser, (...a) => mockUpdateUser(...a)),
    deleteUser: write(actual.deleteUser, (...a) => mockDeleteUser(...a)),
    changePassword: write(actual.changePassword, (...a) => mockChangePassword(...a)),
    createGroup: write(actual.createGroup, (...a) => mockCreateGroup(...a)),
    updateGroup: write(actual.updateGroup, (...a) => mockUpdateGroup(...a)),
    deleteGroup: write(actual.deleteGroup, (...a) => mockDeleteGroup(...a)),
    setAcl: write(actual.setAcl, (...a) => mockSetAcl(...a)),
    createToken: write(actual.createToken, (...a) => mockCreateToken(...a)),
    deleteToken: write(actual.deleteToken, (...a) => mockDeleteToken(...a)),
  };
});

const TOKEN_TIP = 'Read-only: signed in with a service token';
const PASSWORD = 'Sup3r-S3cret-Pa55word!';
const OLD_PASSWORD = 'Curr3nt-Pa55word-Zed';
const SECRET = '5f1d7c1e-9a52-4c0e-8f0a-3b6f1a2d4e77';

function authData(mode: AuthIdentity['mode'], username = 'chris@pve') {
  return { data: { username, realm: username.split('@')[1] ?? 'pve', capabilities: {}, mode } };
}

function permissionsData(privs: Record<string, boolean> | true): { data: GuestPermissions } {
  return { data: { can: (p: string) => privs === true || privs[p] === true } };
}

function renderTab() {
  render(
    <QueryClientProvider client={createQueryClient()}>
      <UsersTab />
    </QueryClientProvider>,
  );
}

/** Radix's TabsTrigger switches tabs on `mousedown`, not `click`. */
function openSubTab(name: string) {
  fireEvent.mouseDown(screen.getByRole('tab', { name }), { button: 0 });
}

async function openDialog(buttonName: string) {
  fireEvent.click(await screen.findByRole('button', { name: buttonName }));
  return screen.findByRole('dialog');
}

const endOfDay = (y: number, m: number, d: number) => Math.floor(new Date(y, m - 1, d, 23, 59, 59).getTime() / 1000);

describe('Datacenter Users & Permissions tab', () => {
  beforeEach(() => {
    state.fixtures = false;
    mockUseAuthMe.mockReturnValue(authData('session'));
    mockPathPermissions.mockReturnValue(permissionsData(true));
    mockCreateUser.mockResolvedValue({ ok: true, userid: 'newuser@pve' });
    mockUpdateUser.mockResolvedValue({ ok: true });
    mockDeleteUser.mockResolvedValue({ ok: true });
    mockChangePassword.mockResolvedValue({ ok: true });
    mockCreateGroup.mockResolvedValue({ ok: true, groupid: 'ops' });
    mockUpdateGroup.mockResolvedValue({ ok: true });
    mockDeleteGroup.mockResolvedValue({ ok: true });
    mockSetAcl.mockResolvedValue({ ok: true });
    mockCreateToken.mockResolvedValue({ fullTokenid: 'chris@pve!ci-bot', value: SECRET });
    mockDeleteToken.mockResolvedValue({ ok: true });
  });

  afterEach(() => {
    state.fixtures = false;
    resetFixtureAccess();
    vi.clearAllMocks();
  });

  it('(a) lists the users with name, state, groups, email and comment', async () => {
    renderTab();
    const chris = await screen.findByRole('row', { name: /chris@pve/ });
    expect(within(chris).getByText('Chris Shirley')).toBeInTheDocument();
    expect(within(chris).getByText('admins')).toBeInTheDocument();
    expect(within(chris).getByText('chris@c2techsys.com')).toBeInTheDocument();
    expect(within(chris).getByText('Lab owner')).toBeInTheDocument();
    expect(within(chris).getByText('never')).toBeInTheDocument();

    const contractor = screen.getByRole('row', { name: /contractor@pve/ });
    expect(within(contractor).getByText('No')).toBeInTheDocument();
    expect(within(contractor).getByText('auditors')).toBeInTheDocument();
    expect(screen.getByRole('row', { name: /root@pam/ })).toBeInTheDocument();
    // Only pve-realm users have a password to change here.
    expect(screen.queryByRole('button', { name: 'Change password for root@pam' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Change password for chris@pve' })).toBeInTheDocument();
  });

  it('(b) add user sends the exact body, password included; confirmation must match', async () => {
    renderTab();
    const dialog = await openDialog('Add user');
    await within(dialog).findByRole('option', { name: 'pve' });
    expect(within(dialog).getByLabelText('Realm')).toHaveValue('pve');
    const add = within(dialog).getByRole('button', { name: 'Add user' });
    expect(add).toBeDisabled();

    fireEvent.change(within(dialog).getByLabelText('User name'), { target: { value: 'newuser' } });
    fireEvent.change(within(dialog).getByLabelText('Password'), { target: { value: PASSWORD } });
    fireEvent.change(within(dialog).getByLabelText('Confirm password'), { target: { value: 'different-password' } });
    expect(within(dialog).getByText('The passwords do not match.')).toBeInTheDocument();
    expect(add).toBeDisabled();
    fireEvent.change(within(dialog).getByLabelText('Confirm password'), { target: { value: PASSWORD } });
    expect(add).toBeEnabled();

    fireEvent.change(within(dialog).getByLabelText('First name'), { target: { value: 'New' } });
    fireEvent.change(within(dialog).getByLabelText('Last name'), { target: { value: 'User' } });
    fireEvent.change(within(dialog).getByLabelText('Email'), { target: { value: 'new@example.com' } });
    fireEvent.change(within(dialog).getByLabelText('Comment'), { target: { value: 'Bench tech' } });
    fireEvent.change(within(dialog).getByLabelText('Expire'), { target: { value: '2030-01-15' } });
    fireEvent.click(within(dialog).getByRole('checkbox', { name: 'auditors' }));
    fireEvent.click(add);

    await waitFor(() => expect(mockCreateUser).toHaveBeenCalledTimes(1));
    expect(mockCreateUser.mock.calls[0]).toStrictEqual([
      {
        userid: 'newuser@pve',
        enable: true,
        password: PASSWORD,
        expire: endOfDay(2030, 1, 15),
        firstname: 'New',
        lastname: 'User',
        email: 'new@example.com',
        groups: ['auditors'],
        comment: 'Bench tech',
      },
    ]);
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });

  it('(b2) a pam user has no password fields, and a missing realm privilege blocks the dialog', async () => {
    mockPathPermissions.mockImplementation((path: string) =>
      permissionsData(path === '/access/realm/pam' ? {} : true),
    );
    renderTab();
    const dialog = await openDialog('Add user');
    await within(dialog).findByRole('option', { name: 'pam' });
    expect(within(dialog).getByLabelText('Password')).toBeInTheDocument();

    fireEvent.change(within(dialog).getByLabelText('Realm'), { target: { value: 'pam' } });
    expect(within(dialog).queryByLabelText('Password')).not.toBeInTheDocument();
    fireEvent.change(within(dialog).getByLabelText('User name'), { target: { value: 'ops' } });
    expect(within(dialog).getByRole('alert')).toHaveTextContent("You don't have Realm.AllocateUser on realm pam");
    expect(within(dialog).getByRole('button', { name: 'Add user' })).toBeDisabled();

    fireEvent.change(within(dialog).getByLabelText('Realm'), { target: { value: 'pve' } });
    expect(within(dialog).queryByRole('alert')).not.toBeInTheDocument();
    expect(within(dialog).getByLabelText('Password')).toBeInTheDocument();
  });

  it('(c) edit sends only what changed; a cleared field is null', async () => {
    renderTab();
    fireEvent.click(await screen.findByRole('button', { name: 'Edit user contractor@pve' }));
    const dialog = await screen.findByRole('dialog');
    const save = within(dialog).getByRole('button', { name: 'Save' });
    expect(save).toBeDisabled(); // nothing changed yet
    expect(within(dialog).getByLabelText('First name')).toHaveValue('Casey');

    fireEvent.change(within(dialog).getByLabelText('First name'), { target: { value: '' } });
    fireEvent.change(within(dialog).getByLabelText('Comment'), { target: { value: '' } });
    fireEvent.change(within(dialog).getByLabelText('Expire'), { target: { value: '' } });
    fireEvent.change(within(dialog).getByLabelText('Last name'), { target: { value: 'Contract' } });
    fireEvent.click(within(dialog).getByRole('checkbox', { name: 'Enabled' }));
    fireEvent.click(within(dialog).getByRole('checkbox', { name: 'admins' }));
    expect(save).toBeEnabled();
    fireEvent.click(save);

    await waitFor(() => expect(mockUpdateUser).toHaveBeenCalledTimes(1));
    expect(mockUpdateUser.mock.calls[0]).toStrictEqual([
      'contractor@pve',
      {
        enable: true,
        expire: null,
        firstname: null,
        lastname: 'Contract',
        comment: null,
        groups: ['admins', 'auditors'],
      },
    ]);
  });

  it('(d) delete needs the userid typed; root@pam and your own account cannot be deleted', async () => {
    renderTab();
    await screen.findByRole('row', { name: /chris@pve/ });
    const root = screen.getByRole('button', { name: 'Delete user root@pam' });
    expect(root).toBeDisabled();
    expect(root).toHaveAttribute('title', 'root@pam cannot be deleted');
    const own = screen.getByRole('button', { name: 'Delete user chris@pve' });
    expect(own).toBeDisabled();
    expect(own).toHaveAttribute('title', 'You cannot delete the account you are signed in with');

    fireEvent.click(screen.getByRole('button', { name: 'Delete user contractor@pve' }));
    const dialog = await screen.findByRole('alertdialog');
    expect(within(dialog).getByText(/This cannot be undone/)).toBeInTheDocument();
    const confirm = within(dialog).getByRole('button', { name: 'Delete contractor@pve' });
    expect(confirm).toBeDisabled();
    fireEvent.change(within(dialog).getByLabelText(/to confirm/), { target: { value: 'contractor@pv' } });
    expect(confirm).toBeDisabled();
    fireEvent.change(within(dialog).getByLabelText(/to confirm/), { target: { value: 'contractor@pve' } });
    expect(confirm).toBeEnabled();
    fireEvent.click(confirm);

    await waitFor(() => expect(mockDeleteUser).toHaveBeenCalledTimes(1));
    expect(mockDeleteUser.mock.calls[0]).toStrictEqual(['contractor@pve']);
    await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument());
  });

  it("(e) change password: another user's body, and the signed-in user's own with the current password", async () => {
    renderTab();
    fireEvent.click(await screen.findByRole('button', { name: 'Change password for contractor@pve' }));
    let dialog = await screen.findByRole('dialog');
    expect(within(dialog).queryByLabelText('Current password')).not.toBeInTheDocument();
    const change = within(dialog).getByRole('button', { name: 'Change password' });
    fireEvent.change(within(dialog).getByLabelText('New password'), { target: { value: 'short' } });
    expect(within(dialog).getByText('Use 8 to 64 characters.')).toBeInTheDocument();
    expect(change).toBeDisabled();
    fireEvent.change(within(dialog).getByLabelText('New password'), { target: { value: PASSWORD } });
    fireEvent.change(within(dialog).getByLabelText('Confirm new password'), { target: { value: PASSWORD } });
    fireEvent.click(change);
    await waitFor(() => expect(mockChangePassword).toHaveBeenCalledTimes(1));
    expect(mockChangePassword.mock.calls[0]).toStrictEqual([{ userid: 'contractor@pve', password: PASSWORD }]);
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: 'Change my password' }));
    dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByRole('heading', { name: 'Change my password' })).toBeInTheDocument();
    fireEvent.change(within(dialog).getByLabelText('Current password'), { target: { value: OLD_PASSWORD } });
    fireEvent.change(within(dialog).getByLabelText('New password'), { target: { value: PASSWORD } });
    fireEvent.change(within(dialog).getByLabelText('Confirm new password'), { target: { value: PASSWORD } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Change password' }));
    await waitFor(() => expect(mockChangePassword).toHaveBeenCalledTimes(2));
    expect(mockChangePassword.mock.calls[1]).toStrictEqual([
      { userid: 'chris@pve', password: PASSWORD, confirmationPassword: OLD_PASSWORD },
    ]);
  });

  it('(e2) a pam user gets a hint instead of a password change', async () => {
    mockUseAuthMe.mockReturnValue(authData('session', 'root@pam'));
    renderTab();
    await screen.findByRole('row', { name: /root@pam/ });
    const button = screen.getByRole('button', { name: 'Change my password' });
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute('title', expect.stringContaining('pam users are managed on the Proxmox host'));
  });

  it('(f) groups: add, edit and delete send the exact requests', async () => {
    renderTab();
    await screen.findByRole('row', { name: /chris@pve/ });
    openSubTab('Groups');

    const admins = await screen.findByRole('row', { name: /admins/ });
    expect(within(admins).getByText('chris@pve')).toBeInTheDocument(); // member

    let dialog = await openDialog('Add group');
    fireEvent.change(within(dialog).getByLabelText('Group name'), { target: { value: 'ops' } });
    fireEvent.change(within(dialog).getByLabelText('Comment'), { target: { value: 'Operators' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Add group' }));
    await waitFor(() => expect(mockCreateGroup).toHaveBeenCalledTimes(1));
    expect(mockCreateGroup.mock.calls[0]).toStrictEqual([{ groupid: 'ops', comment: 'Operators' }]);
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: 'Edit group auditors' }));
    dialog = await screen.findByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText('Comment'), { target: { value: '' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(mockUpdateGroup).toHaveBeenCalledTimes(1));
    expect(mockUpdateGroup.mock.calls[0]).toStrictEqual(['auditors', { comment: '' }]);
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: 'Delete group auditors' }));
    const alert = await screen.findByRole('alertdialog');
    fireEvent.click(within(alert).getByRole('button', { name: 'Delete auditors' }));
    await waitFor(() => expect(mockDeleteGroup).toHaveBeenCalledTimes(1));
    expect(mockDeleteGroup.mock.calls[0]).toStrictEqual(['auditors']);
  });

  it('(g) roles are read-only, with a privileges list per role', async () => {
    renderTab();
    await screen.findByRole('row', { name: /chris@pve/ });
    openSubTab('Roles');

    const auditor = await screen.findByRole('row', { name: /PVEAuditor/ });
    expect(within(auditor).queryByRole('button', { name: /^Edit|^Delete|^Add/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Add role/ })).not.toBeInTheDocument();
    fireEvent.click(within(auditor).getByRole('button', { name: 'Privileges of PVEAuditor' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByRole('heading', { name: 'PVEAuditor privileges' })).toBeInTheDocument();
    for (const priv of ['Datastore.Audit', 'Pool.Audit', 'Sys.Audit', 'VM.Audit']) {
      expect(within(dialog).getByText(priv)).toBeInTheDocument();
    }
  });

  it('(h) permissions: add (users form) and remove send the exact bodies', async () => {
    renderTab();
    await screen.findByRole('row', { name: /chris@pve/ });
    openSubTab('Permissions');

    const vmRow = await screen.findByRole('row', { name: /\/vms\/100/ });
    expect(within(vmRow).getByText('PVEVMAdmin')).toBeInTheDocument();
    expect(within(vmRow).getByText('User')).toBeInTheDocument();

    const dialog = await openDialog('Add permission');
    await within(dialog).findByRole('option', { name: 'PVEVMAdmin' });
    // The cluster's own nodes, guests and storages are offered as path suggestions.
    for (const path of ['/nodes/pve1', '/vms/100', '/storage/local', '/pool/lab']) {
      expect(dialog.querySelector(`datalist option[value="${path}"]`)).not.toBeNull();
    }
    fireEvent.change(within(dialog).getByLabelText('Path'), { target: { value: '/nodes/pve1' } });
    fireEvent.change(within(dialog).getByLabelText('Role'), { target: { value: 'PVEVMAdmin' } });
    fireEvent.change(within(dialog).getByLabelText('User'), { target: { value: 'contractor@pve' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Add' }));
    await waitFor(() => expect(mockSetAcl).toHaveBeenCalledTimes(1));
    expect(mockSetAcl.mock.calls[0]).toStrictEqual([
      { path: '/nodes/pve1', roles: ['PVEVMAdmin'], propagate: true, users: ['contractor@pve'] },
    ]);
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: 'Remove permission PVEVMAdmin on /vms/100 for chris@pve' }));
    const alert = await screen.findByRole('alertdialog');
    fireEvent.click(within(alert).getByRole('button', { name: 'Remove' }));
    await waitFor(() => expect(mockSetAcl).toHaveBeenCalledTimes(2));
    expect(mockSetAcl.mock.calls[1]).toStrictEqual([
      { path: '/vms/100', roles: ['PVEVMAdmin'], propagate: true, remove: true, users: ['chris@pve'] },
    ]);
  });

  it('(h2) permissions: group and API-token subjects use their own body keys; a bad path blocks', async () => {
    renderTab();
    await screen.findByRole('row', { name: /chris@pve/ });
    openSubTab('Permissions');

    let dialog = await openDialog('Add permission');
    await within(dialog).findByRole('option', { name: 'PVEAdmin' });
    fireEvent.change(within(dialog).getByLabelText('Path'), { target: { value: 'vms/100' } });
    expect(within(dialog).getByRole('button', { name: 'Add' })).toBeDisabled();
    fireEvent.change(within(dialog).getByLabelText('Path'), { target: { value: '/pool/lab' } });
    fireEvent.change(within(dialog).getByLabelText('Applies to'), { target: { value: 'group' } });
    fireEvent.change(within(dialog).getByLabelText('Role'), { target: { value: 'PVEAdmin' } });
    fireEvent.click(within(dialog).getByRole('checkbox', { name: 'Propagate' }));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Add' }));
    await waitFor(() => expect(mockSetAcl).toHaveBeenCalledTimes(1));
    expect(mockSetAcl.mock.calls[0]).toStrictEqual([
      { path: '/pool/lab', roles: ['PVEAdmin'], propagate: false, groups: ['admins'] },
    ]);
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());

    dialog = await openDialog('Add permission');
    await within(dialog).findByRole('option', { name: 'PVEAdmin' });
    fireEvent.change(within(dialog).getByLabelText('Applies to'), { target: { value: 'token' } });
    expect(within(dialog).getByLabelText('API token')).toHaveValue('chris@pve!monitoring');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Add' }));
    await waitFor(() => expect(mockSetAcl).toHaveBeenCalledTimes(2));
    expect(mockSetAcl.mock.calls[1]).toStrictEqual([
      { path: '/', roles: ['PVEAuditor'], propagate: true, tokens: ['chris@pve!monitoring'] },
    ]);
  });

  it('(i) token create shows the secret once; the token list never contains it', async () => {
    renderTab();
    await screen.findByRole('row', { name: /chris@pve/ });
    openSubTab('API Tokens');

    const existing = await screen.findByRole('row', { name: /monitoring/ });
    expect(within(existing).getByText('chris@pve')).toBeInTheDocument();
    expect(within(existing).getByText('Grafana read-only')).toBeInTheDocument();

    const dialog = await openDialog('Add token');
    await within(dialog).findByRole('option', { name: 'chris@pve' });
    expect(within(dialog).getByLabelText('User')).toHaveValue('chris@pve');
    fireEvent.change(within(dialog).getByLabelText('Token ID'), { target: { value: 'ci-bot' } });
    fireEvent.change(within(dialog).getByLabelText('Comment'), { target: { value: 'CI runner' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Create token' }));

    await waitFor(() => expect(mockCreateToken).toHaveBeenCalledTimes(1));
    expect(mockCreateToken.mock.calls[0]).toStrictEqual([
      'chris@pve',
      { tokenid: 'ci-bot', privsep: true, comment: 'CI runner' },
    ]);

    // The secret is shown once, in a read-only copy box, with the warning.
    const secret = await within(dialog).findByLabelText('Secret');
    expect(secret).toHaveValue(SECRET);
    expect(secret).toHaveAttribute('readonly');
    expect(within(dialog).getByText(/it will not be shown again/)).toBeInTheDocument();
    expect(within(dialog).getByLabelText('Token ID')).toHaveValue('chris@pve!ci-bot');

    fireEvent.click(within(dialog).getByRole('button', { name: 'I have stored it' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    // Gone from the page, and the list (re-read after the create) never carried it.
    expect(document.body.textContent).not.toContain(SECRET);
    expect(screen.queryByDisplayValue(SECRET)).not.toBeInTheDocument();
  });

  it('(i2) token delete confirms and sends user + token id; Users -> Tokens filters to that user', async () => {
    renderTab();
    fireEvent.click(await screen.findByRole('button', { name: 'Tokens for contractor@pve' }));
    await screen.findByText('There are no API tokens.');
    expect(screen.getByText('contractor@pve')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Show all' }));

    fireEvent.click(await screen.findByRole('button', { name: 'Delete token chris@pve!monitoring' }));
    const alert = await screen.findByRole('alertdialog');
    fireEvent.click(within(alert).getByRole('button', { name: 'Delete token' }));
    await waitFor(() => expect(mockDeleteToken).toHaveBeenCalledTimes(1));
    expect(mockDeleteToken.mock.calls[0]).toStrictEqual(['chris@pve', 'monitoring']);
  });

  it('(j) token mode: every write control is disabled with the read-only tooltip', async () => {
    mockUseAuthMe.mockReturnValue(authData('token', 'root@pam!proxion'));
    renderTab();
    await screen.findByRole('row', { name: /chris@pve/ });

    for (const name of [
      'Add user',
      'Change my password',
      'Edit user chris@pve',
      'Change password for chris@pve',
      'Delete user contractor@pve',
    ]) {
      const button = screen.getByRole('button', { name });
      expect(button, name).toBeDisabled();
      expect(button, name).toHaveAttribute('title', TOKEN_TIP);
    }
    // Reading is still possible: the per-user token view is just navigation.
    expect(screen.getByRole('button', { name: 'Tokens for chris@pve' })).toBeEnabled();

    openSubTab('Groups');
    for (const name of ['Add group', 'Edit group admins', 'Delete group admins']) {
      const button = await screen.findByRole('button', { name });
      expect(button, name).toBeDisabled();
      expect(button, name).toHaveAttribute('title', TOKEN_TIP);
    }
    openSubTab('Permissions');
    for (const name of ['Add permission', 'Remove permission PVEVMAdmin on /vms/100 for chris@pve']) {
      const button = await screen.findByRole('button', { name });
      expect(button, name).toBeDisabled();
      expect(button, name).toHaveAttribute('title', TOKEN_TIP);
    }
    openSubTab('API Tokens');
    for (const name of ['Add token', 'Delete token chris@pve!monitoring']) {
      const button = await screen.findByRole('button', { name });
      expect(button, name).toBeDisabled();
      expect(button, name).toHaveAttribute('title', TOKEN_TIP);
    }
    expect(mockCreateUser).not.toHaveBeenCalled();
  });

  it('(k) privilege gate: each control follows its own PVE privilege and path', async () => {
    // Holds nothing on /access or /access/groups, and Permissions.Modify everywhere but /vms/100.
    mockPathPermissions.mockImplementation((path: string) =>
      permissionsData(path === '/vms/100' || path.startsWith('/access') ? {} : { 'Permissions.Modify': true }),
    );
    renderTab();
    await screen.findByRole('row', { name: /chris@pve/ });

    const needUserModify = "You don't have User.Modify";
    for (const name of ['Edit user contractor@pve', 'Change password for contractor@pve', 'Delete user contractor@pve']) {
      const button = screen.getByRole('button', { name });
      expect(button, name).toBeDisabled();
      expect(button, name).toHaveAttribute('title', needUserModify);
    }
    // The signed-in user may always change their own password (PVE lets users do that).
    expect(screen.getByRole('button', { name: 'Change password for chris@pve' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Change my password' })).toBeEnabled();

    openSubTab('Groups');
    const addGroup = await screen.findByRole('button', { name: 'Add group' });
    expect(addGroup).toBeDisabled();
    expect(addGroup).toHaveAttribute('title', "You don't have Group.Allocate");

    openSubTab('Permissions');
    const onVm = await screen.findByRole('button', { name: 'Remove permission PVEVMAdmin on /vms/100 for chris@pve' });
    expect(onVm).toBeDisabled();
    expect(onVm).toHaveAttribute('title', "You don't have Permissions.Modify");
    expect(screen.getByRole('button', { name: 'Remove permission PVEAuditor on /storage/local for chris@pve!monitoring' })).toBeEnabled();

    openSubTab('API Tokens');
    // Without User.Modify only the caller's own tokens can be changed or created.
    await screen.findByRole('row', { name: /monitoring/ });
    expect(screen.getByRole('button', { name: 'Delete token chris@pve!monitoring' })).toBeEnabled();
    const dialog = await openDialog('Add token');
    const options = within(dialog.querySelector('select')!).getAllByRole('option');
    expect(options.map((o) => o.textContent)).toStrictEqual(['chris@pve']);
  });

  it('(l) fixture round trip: add a user (password kept out of the record), then delete it', async () => {
    state.fixtures = true;
    renderTab();
    await screen.findByRole('row', { name: /chris@pve/ });

    const dialog = await openDialog('Add user');
    await within(dialog).findByRole('option', { name: 'pve' });
    fireEvent.change(within(dialog).getByLabelText('User name'), { target: { value: 'newuser' } });
    fireEvent.change(within(dialog).getByLabelText('Password'), { target: { value: PASSWORD } });
    fireEvent.change(within(dialog).getByLabelText('Confirm password'), { target: { value: PASSWORD } });
    fireEvent.change(within(dialog).getByLabelText('Comment'), { target: { value: 'Round trip' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Add user' }));

    const row = await screen.findByRole('row', { name: /newuser@pve/ });
    expect(within(row).getByText('Round trip')).toBeInTheDocument();
    // The password went into the (fixture) request only -- the stored record has no trace of it.
    const stored = getFixtureAccessUsers().find((u) => u.userid === 'newuser@pve');
    expect(stored).toStrictEqual({
      userid: 'newuser@pve',
      enable: true,
      expire: 0,
      comment: 'Round trip',
      groups: [],
      tokens: [],
    });
    expect(JSON.stringify(getFixtureAccessUsers())).not.toContain(PASSWORD);
    expect(mockCreateUser).not.toHaveBeenCalled();

    fireEvent.click(within(row).getByRole('button', { name: 'Delete user newuser@pve' }));
    const alert = await screen.findByRole('alertdialog');
    fireEvent.change(within(alert).getByLabelText(/to confirm/), { target: { value: 'newuser@pve' } });
    fireEvent.click(within(alert).getByRole('button', { name: 'Delete newuser@pve' }));
    await waitFor(() => expect(screen.queryByRole('row', { name: /newuser@pve/ })).not.toBeInTheDocument());
    expect(getFixtureAccessUsers().some((u) => u.userid === 'newuser@pve')).toBe(false);

    // And a token round trip: the secret comes back once and is not stored on the user.
    openSubTab('API Tokens');
    const tokenDialog = await openDialog('Add token');
    await within(tokenDialog).findByRole('option', { name: 'chris@pve' });
    fireEvent.change(within(tokenDialog).getByLabelText('Token ID'), { target: { value: 'demo-token' } });
    fireEvent.click(within(tokenDialog).getByRole('button', { name: 'Create token' }));
    const secret = (await within(tokenDialog).findByLabelText('Secret')) as HTMLInputElement;
    expect(secret.value).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    const secretValue = secret.value;
    expect(JSON.stringify(getFixtureAccessUsers())).not.toContain(secretValue);
    expect(getFixtureAccessUsers().find((u) => u.userid === 'chris@pve')?.tokens.map((t) => t.tokenid)).toContain('demo-token');
    fireEvent.click(within(tokenDialog).getByRole('button', { name: 'I have stored it' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(await screen.findByRole('row', { name: /demo-token/ })).toBeInTheDocument();
    expect(document.body.textContent).not.toContain(secretValue);
  });
});
