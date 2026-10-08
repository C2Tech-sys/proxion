import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClientProvider } from '@tanstack/react-query';

import { StorageConfigTab } from '@/pages/datacenter/tabs/StorageConfigTab';
import { createQueryClient } from '@/api/queryClient';
import { GuestActionError } from '@/api/actions';
import { FIXTURE_STORAGE_SCAN, getFixtureStorageConfigs, resetFixtureStorageConfigs } from '@/api/fixtures';
import type { AuthIdentity } from '@/api/client-types';
import type { GuestPermissions } from '@/api/actionHooks';

/**
 * Datacenter -> Storage (T70): the definitions table, the "Add" menu and per-type dialog, Edit,
 * Remove (typed confirm) and the gating on session mode + `Datastore.Allocate`. `useAuthMe` and
 * `usePathPermissions` are mocked so each test controls the gate; `@/api/storageConfig`'s write
 * functions are mocked so the exact request each dialog builds can be asserted (`toStrictEqual`).
 * The last tests flip `USE_FIXTURES` on and run the real fixture flow instead.
 */
const SECRET = 'S3cr3t-Pa55word-do-not-store';

const mockUseAuthMe = vi.fn();
const mockUsePathPermissions = vi.fn();
const mockAddStorage = vi.fn();
const mockEditStorage = vi.fn();
const mockRemoveStorage = vi.fn();

const state = vi.hoisted(() => ({
  fixtures: false,
  actual: undefined as typeof import('@/api/storageConfig') | undefined,
}));

// `USE_FIXTURES` is true by default in this test env (`.env.test`), which would short-circuit the
// session-mode gate to "always enabled". A getter, so the fixture-flow tests can flip it per test.
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

vi.mock('@/api/datacenterPermissionHooks', () => ({
  usePathPermissions: (path: string) => mockUsePathPermissions(path),
}));

vi.mock('@/api/storageConfig', async () => {
  const actual = await vi.importActual<typeof import('@/api/storageConfig')>('@/api/storageConfig');
  const fixtures = await vi.importActual<typeof import('@/api/fixtures')>('@/api/fixtures');
  state.actual = actual;
  return {
    ...actual,
    // Not in fixture mode the real function would `fetch`; serve the same data from memory.
    getStorageConfigs: (...args: Parameters<typeof actual.getStorageConfigs>) =>
      state.fixtures
        ? actual.getStorageConfigs(...args)
        : Promise.resolve(fixtures.getFixtureStorageConfigs().map((c) => actual.normalizeStorageConfig(c))),
    scanStorage: (request: Parameters<typeof actual.scanStorage>[0]) =>
      state.fixtures ? actual.scanStorage(request) : Promise.resolve(scanFromFixture(request)),
    addStorage: (...args: Parameters<typeof actual.addStorage>) =>
      state.fixtures ? actual.addStorage(...args) : mockAddStorage(...args),
    editStorage: (...args: Parameters<typeof actual.editStorage>) =>
      state.fixtures ? actual.editStorage(...args) : mockEditStorage(...args),
    removeStorage: (...args: Parameters<typeof actual.removeStorage>) =>
      state.fixtures ? actual.removeStorage(...args) : mockRemoveStorage(...args),
  };
});

/** What the scan helpers return when the real function (which would `fetch`) is not used. */
function scanFromFixture(request: { kind: string; vg?: string }): string[] {
  switch (request.kind) {
    case 'nfs':
      return FIXTURE_STORAGE_SCAN.nfs.map((r) => r.path);
    case 'cifs':
      return FIXTURE_STORAGE_SCAN.cifs.map((r) => r.share);
    case 'zfs':
      return FIXTURE_STORAGE_SCAN.zfs.map((r) => r.pool);
    case 'lvm':
      return FIXTURE_STORAGE_SCAN.lvm.map((r) => r.vg);
    default:
      return (FIXTURE_STORAGE_SCAN.lvmthin[request.vg ?? ''] ?? []).map((r) => r.lv);
  }
}

function authData(mode: AuthIdentity['mode']) {
  return { data: { username: 'root@pam', realm: 'pam', capabilities: {}, mode } };
}

function permissionsData(privs: Record<string, boolean> | true) {
  const value: GuestPermissions = { can: (p: string) => privs === true || privs[p] === true };
  return { data: value };
}

function renderTab() {
  const queryClient = createQueryClient();
  render(
    <QueryClientProvider client={queryClient}>
      <StorageConfigTab />
    </QueryClientProvider>,
  );
}

async function openAddDialog(label: string) {
  const trigger = await screen.findByRole('button', { name: 'Add' });
  fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false, pointerType: 'mouse' });
  fireEvent.click(await screen.findByRole('menuitem', { name: label }));
  return screen.findByRole('dialog');
}

async function openRowDialog(buttonName: string, role: 'dialog' | 'alertdialog' = 'dialog') {
  fireEvent.click(await screen.findByRole('button', { name: buttonName }));
  return screen.findByRole(role);
}

function change(dialog: HTMLElement, label: string, value: string) {
  fireEvent.change(within(dialog).getByLabelText(label), { target: { value } });
}

function toggle(dialog: HTMLElement, name: string) {
  fireEvent.click(within(dialog).getByRole('checkbox', { name }));
}

describe('Datacenter Storage tab', () => {
  beforeEach(() => {
    state.fixtures = false;
    mockUseAuthMe.mockReturnValue(authData('session'));
    mockUsePathPermissions.mockImplementation(() => permissionsData(true));
    mockAddStorage.mockImplementation((body: { storage: string }) => Promise.resolve({ ok: true, storage: body.storage }));
    mockEditStorage.mockImplementation((storage: string) => Promise.resolve({ ok: true, storage, changed: [] }));
    mockRemoveStorage.mockResolvedValue({ ok: true });
  });

  afterEach(() => {
    state.fixtures = false;
    resetFixtureStorageConfigs();
    vi.clearAllMocks();
  });

  it('(a) lists every definition with type, content, target, shared, enabled, nodes and usage', async () => {
    renderTab();

    const local = await screen.findByTestId('storage-row-local');
    const localCells = within(local).getAllByRole('cell');
    expect(localCells[0]).toHaveTextContent('local');
    expect(localCells[1]).toHaveTextContent('Directory');
    expect(localCells[2]).toHaveTextContent('iso, vztmpl, backup');
    expect(localCells[3]).toHaveTextContent('/var/lib/vz');
    expect(localCells[4]).toHaveTextContent('No');
    expect(localCells[5]).toHaveTextContent('Yes');
    expect(localCells[6]).toHaveTextContent('All');
    // `local` exists on both fixture nodes, so the usage cell labels each bar with its node.
    await waitFor(() =>
      expect(within(screen.getByTestId('storage-row-local')).getAllByRole('cell')[7]).toHaveTextContent(
        /pve1 .* \/ .*pve2 .* \/ /,
      ),
    );

    const nfs = screen.getByTestId('storage-row-backup-nfs');
    const nfsCells = within(nfs).getAllByRole('cell');
    expect(nfsCells[1]).toHaveTextContent('NFS');
    expect(nfsCells[2]).toHaveTextContent('backup, iso');
    expect(nfsCells[2]).toHaveTextContent('Retention: last 3');
    expect(nfsCells[3]).toHaveTextContent('10.0.0.20:/export/pve-backups');
    expect(nfsCells[4]).toHaveTextContent('Yes');
    expect(nfsCells[7]).toHaveTextContent('-');

    const zfs = screen.getByTestId('storage-row-local-zfs');
    expect(within(zfs).getAllByRole('cell')[6]).toHaveTextContent('pve1');
    expect(within(screen.getByTestId('storage-row-pbs-main')).getAllByRole('cell')[3]).toHaveTextContent('pbs.lan:main');
  });

  it('(b) token mode: Add, Edit and Remove are disabled with the read-only tooltip', async () => {
    mockUseAuthMe.mockReturnValue(authData('token'));

    renderTab();
    await screen.findByTestId('storage-row-local');

    for (const name of ['Add', 'Edit backup-nfs', 'Remove backup-nfs']) {
      const button = screen.getByRole('button', { name });
      expect(button).toBeDisabled();
      expect(button).toHaveAttribute('title', 'Read-only: signed in with a service token');
    }
  });

  it('(c) a session without Datastore.Allocate gets the privilege tooltip, per path', async () => {
    mockUsePathPermissions.mockImplementation((path: string) =>
      permissionsData(path === '/storage/tank' ? { 'Datastore.Allocate': true } : { 'Datastore.Audit': true }),
    );

    renderTab();
    await screen.findByTestId('storage-row-local');

    expect(screen.getByRole('button', { name: 'Add' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Add' })).toHaveAttribute('title', "You don't have Datastore.Allocate on /storage");
    expect(screen.getByRole('button', { name: 'Edit backup-nfs' })).toHaveAttribute(
      'title',
      "You don't have Datastore.Allocate on this storage",
    );
    // Granted on `/storage/tank` only: that row is enabled.
    expect(screen.getByRole('button', { name: 'Edit tank' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Remove tank' })).toBeEnabled();
  });

  it('(d) Add > NFS: scan fills the export, content/nodes/retention build the exact body', async () => {
    renderTab();
    const dialog = await openAddDialog('NFS');
    expect(within(dialog).getByRole('heading', { name: 'Add: NFS' })).toBeInTheDocument();
    const add = within(dialog).getByRole('button', { name: 'Add' });
    expect(add).toBeDisabled();

    change(dialog, 'ID', 'nfs1');
    expect(within(dialog).getByRole('button', { name: 'Scan NFS exports' })).toBeDisabled();
    change(dialog, 'Server', '10.0.0.5');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Scan NFS exports' }));
    const found = await within(dialog).findByLabelText('Found NFS exports');
    fireEvent.change(found, { target: { value: '/export/isos' } });
    expect(within(dialog).getByLabelText('Export')).toHaveValue('/export/isos');
    expect(add).toBeEnabled();

    toggle(dialog, 'Container template'); // iso, vztmpl, backup -> iso, backup
    fireEvent.click(await within(dialog).findByRole('checkbox', { name: 'pve1' }));
    change(dialog, 'Keep last', '3');
    fireEvent.click(add);

    await waitFor(() => expect(mockAddStorage).toHaveBeenCalledTimes(1));
    expect(mockAddStorage.mock.calls[0]![0]).toStrictEqual({
      type: 'nfs',
      storage: 'nfs1',
      content: ['iso', 'backup'],
      nodes: ['pve1'],
      server: '10.0.0.5',
      export: '/export/isos',
      prune: { keepLast: 3 },
    });
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });

  it('(e) the form explains a bad id/server and keeps Add disabled; content is limited to the type', async () => {
    renderTab();
    const dialog = await openAddDialog('NFS');

    change(dialog, 'ID', '1bad');
    change(dialog, 'Server', 'bad host');
    change(dialog, 'Export', 'srv');
    expect(within(dialog).getByText(/a letter first/)).toBeInTheDocument();
    expect(within(dialog).getByText('Enter a host name or IP address.')).toBeInTheDocument();
    expect(within(dialog).getByText('Enter the export path, starting with /.')).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: 'Add' })).toBeDisabled();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());

    // A ZFS pool holds disks and containers only; a PBS datastore holds backups only.
    const zfs = await openAddDialog('ZFS');
    expect(within(zfs).getAllByRole('checkbox', { name: /Disk image|Container$/ })).toHaveLength(2);
    expect(within(zfs).queryByRole('checkbox', { name: 'ISO image' })).not.toBeInTheDocument();
    fireEvent.click(within(zfs).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    const pbs = await openAddDialog('Proxmox Backup Server');
    expect(within(pbs).getAllByRole('checkbox', { name: /Disk image|Container|ISO|Snippets|Import|template|VZDump/ })).toHaveLength(1);
    expect(within(pbs).getByRole('checkbox', { name: 'VZDump backup file' })).toBeChecked();
  });

  it('(f) Add > SMB/CIFS sends the password in the request, as a password field', async () => {
    renderTab();
    const dialog = await openAddDialog('SMB/CIFS');

    change(dialog, 'ID', 'smb1');
    change(dialog, 'Server', 'nas.lan');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Scan SMB shares' }));
    fireEvent.change(await within(dialog).findByLabelText('Found SMB shares'), { target: { value: 'backups' } });
    expect(within(dialog).getByLabelText('Share')).toHaveValue('backups');
    change(dialog, 'Username', 'svc-pve');
    expect(within(dialog).getByLabelText('Password')).toHaveAttribute('type', 'password');
    change(dialog, 'Password', SECRET);
    change(dialog, 'Domain', 'CORP');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Add' }));

    await waitFor(() => expect(mockAddStorage).toHaveBeenCalledTimes(1));
    expect(mockAddStorage.mock.calls[0]![0]).toStrictEqual({
      type: 'cifs',
      storage: 'smb1',
      content: ['iso', 'vztmpl', 'backup'],
      server: 'nas.lan',
      share: 'backups',
      username: 'svc-pve',
      password: SECRET,
      domain: 'CORP',
    });
  });

  it('(g) Add > ZFS and LVM-Thin: scans fill the pool, volume group and thin pool', async () => {
    renderTab();
    const zfs = await openAddDialog('ZFS');
    change(zfs, 'ID', 'zfs2');
    fireEvent.click(within(zfs).getByRole('button', { name: 'Scan ZFS pools' }));
    fireEvent.change(await within(zfs).findByLabelText('Found ZFS pools'), { target: { value: 'tank' } });
    toggle(zfs, 'Thin provision');
    change(zfs, 'Block size', '16k');
    fireEvent.click(within(zfs).getByRole('button', { name: 'Add' }));
    await waitFor(() => expect(mockAddStorage).toHaveBeenCalledTimes(1));
    expect(mockAddStorage.mock.calls[0]![0]).toStrictEqual({
      type: 'zfspool',
      storage: 'zfs2',
      content: ['images', 'rootdir'],
      pool: 'tank',
      sparse: true,
      blocksize: '16k',
    });
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());

    const thin = await openAddDialog('LVM-Thin');
    change(thin, 'ID', 'thin2');
    fireEvent.click(within(thin).getByRole('button', { name: 'Scan volume groups' }));
    fireEvent.change(await within(thin).findByLabelText('Found volume groups'), { target: { value: 'pve' } });
    fireEvent.click(within(thin).getByRole('button', { name: 'Scan thin pools' }));
    fireEvent.change(await within(thin).findByLabelText('Found thin pools'), { target: { value: 'data' } });
    fireEvent.click(within(thin).getByRole('button', { name: 'Add' }));
    await waitFor(() => expect(mockAddStorage).toHaveBeenCalledTimes(2));
    expect(mockAddStorage.mock.calls[1]![0]).toStrictEqual({
      type: 'lvmthin',
      storage: 'thin2',
      content: ['images', 'rootdir'],
      vgname: 'pve',
      thinpool: 'data',
    });
  });

  it('(h) Edit an NFS storage sends the full desired state of its editable fields', async () => {
    renderTab();
    const dialog = await openRowDialog('Edit backup-nfs');
    expect(within(dialog).getByRole('heading', { name: 'Edit: backup-nfs' })).toBeInTheDocument();
    // What it points at is shown but not editable.
    expect(within(dialog).getByLabelText('Server')).toBeDisabled();
    expect(within(dialog).getByLabelText('Export')).toBeDisabled();
    expect(within(dialog).getByLabelText('NFS options')).toHaveValue('vers=4.2');
    expect(within(dialog).getByLabelText('Keep last')).toHaveValue('3');

    toggle(dialog, 'ISO image');
    // The node list comes from the cluster resources, which may still be loading.
    fireEvent.click(await within(dialog).findByRole('checkbox', { name: 'pve1' }));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(mockEditStorage).toHaveBeenCalledTimes(1));
    expect(mockEditStorage.mock.calls[0]![0]).toBe('backup-nfs');
    expect(mockEditStorage.mock.calls[0]![1]).toStrictEqual({
      content: ['backup'],
      nodes: ['pve1'],
      disable: false,
      options: 'vers=4.2',
      prune: { keepLast: 3 },
    });
  });

  it('(i) clearing every node sends nodes: null; disabling sends disable: true', async () => {
    renderTab();
    const dialog = await openRowDialog('Edit tank');
    expect(within(dialog).getByRole('checkbox', { name: 'pve1' })).toBeChecked();
    toggle(dialog, 'pve1');
    expect(within(dialog).getByText('Available on all nodes.')).toBeInTheDocument();
    toggle(dialog, 'Enable');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(mockEditStorage).toHaveBeenCalledTimes(1));
    expect(mockEditStorage.mock.calls[0]![1]).toStrictEqual({
      content: ['images', 'rootdir'],
      nodes: null,
      disable: true,
      sparse: false,
    });
  });

  it('(j) editing a PBS storage: a blank password is { keep: true }, a typed one is sent', async () => {
    const fingerprint = String(getFixtureStorageConfigs().find((c) => c.storage === 'pbs-main')!.fingerprint);
    renderTab();
    const dialog = await openRowDialog('Edit pbs-main');
    expect(within(dialog).getByLabelText('Password')).toHaveValue('');
    expect(within(dialog).getByText('Leave blank to keep the current password.')).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(mockEditStorage).toHaveBeenCalledTimes(1));
    expect(mockEditStorage.mock.calls[0]![1]).toStrictEqual({
      content: ['backup'],
      nodes: null,
      disable: false,
      username: 'backup@pbs',
      password: { keep: true },
      fingerprint,
      namespace: null,
      prune: { keepAll: true },
    });
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());

    const again = await openRowDialog('Edit pbs-main');
    change(again, 'Password', SECRET);
    fireEvent.click(within(again).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(mockEditStorage).toHaveBeenCalledTimes(2));
    expect(mockEditStorage.mock.calls[1]![1]).toMatchObject({ password: SECRET });
  });

  it('(k) a server error stays inline and the dialog stays open', async () => {
    mockEditStorage.mockRejectedValue(new GuestActionError(400, 'Parameter verification failed. options: invalid format'));
    renderTab();
    const dialog = await openRowDialog('Edit backup-nfs');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));

    expect(await within(dialog).findByRole('alert')).toHaveTextContent('Parameter verification failed. options: invalid format');
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });

  it('(l) Remove needs the typed id, says the data is not deleted, then calls the API', async () => {
    renderTab();
    const dialog = await openRowDialog('Remove backup-nfs', 'alertdialog');
    expect(
      within(dialog).getByText(/Removes the storage definition from Proxmox only; the data on it is not deleted\./),
    ).toBeInTheDocument();
    const confirm = within(dialog).getByRole('button', { name: 'Remove backup-nfs' });
    expect(confirm).toBeDisabled();
    change(dialog, 'Type the storage ID to confirm', 'backup');
    expect(confirm).toBeDisabled();
    change(dialog, 'Type the storage ID to confirm', 'backup-nfs');
    expect(confirm).toBeEnabled();
    fireEvent.click(confirm);

    await waitFor(() => expect(mockRemoveStorage).toHaveBeenCalledTimes(1));
    expect(mockRemoveStorage.mock.calls[0]).toStrictEqual(['backup-nfs']);
    await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument());
  });

  it('(m) the built-in local storage cannot be removed', async () => {
    renderTab();
    await screen.findByTestId('storage-row-local');
    const remove = screen.getByRole('button', { name: 'Remove local' });
    expect(remove).toBeDisabled();
    expect(remove).toHaveAttribute('title', 'The built-in "local" storage cannot be removed');
    expect(screen.getByRole('button', { name: 'Edit local' })).toBeEnabled();
  });

  it('(n) fixture round trip: adding a PBS storage never keeps the password in the record', async () => {
    state.fixtures = true;
    renderTab();
    const dialog = await openAddDialog('Proxmox Backup Server');
    change(dialog, 'ID', 'pbs-new');
    change(dialog, 'Server', 'pbs2.lan');
    change(dialog, 'Username', 'backup@pbs');
    change(dialog, 'Password', SECRET);
    change(dialog, 'Datastore', 'ds2');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Add' }));

    const row = await screen.findByTestId('storage-row-pbs-new');
    expect(within(row).getAllByRole('cell')[3]).toHaveTextContent('pbs2.lan:ds2');
    const record = getFixtureStorageConfigs().find((c) => c.storage === 'pbs-new');
    expect(record).toStrictEqual({
      storage: 'pbs-new',
      type: 'pbs',
      server: 'pbs2.lan',
      datastore: 'ds2',
      username: 'backup@pbs',
      content: 'backup',
    });
    expect(JSON.stringify(getFixtureStorageConfigs())).not.toContain(SECRET);
    expect(document.body.innerHTML).not.toContain(SECRET);
  });

  it('(o) fixture round trip: edit disables a storage, remove drops its row and keeps the others', async () => {
    state.fixtures = true;
    renderTab();

    const edit = await openRowDialog('Edit tank-backups');
    toggle(edit, 'Enable');
    fireEvent.click(within(edit).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(within(screen.getByTestId('storage-row-tank-backups')).getByText('Disabled')).toBeInTheDocument());
    expect(getFixtureStorageConfigs().find((c) => c.storage === 'tank-backups')!.disable).toBe(1);

    const remove = await openRowDialog('Remove backup-nfs', 'alertdialog');
    change(remove, 'Type the storage ID to confirm', 'backup-nfs');
    fireEvent.click(within(remove).getByRole('button', { name: 'Remove backup-nfs' }));
    await waitFor(() => expect(screen.queryByTestId('storage-row-backup-nfs')).not.toBeInTheDocument());
    expect(screen.getByTestId('storage-row-local')).toBeInTheDocument();
  });
});
