import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClientProvider } from '@tanstack/react-query';

import { BackupJobsTab } from '@/pages/datacenter/tabs/BackupJobsTab';
import { createQueryClient } from '@/api/queryClient';
import { GuestActionError } from '@/api/actions';
import {
  fixtureBackupJobs,
  resetFixtureBackupJobs,
  getFixtureBackupJobVolumes,
  FIXTURE_BACKUP_STORAGES,
  FIXTURE_POOLS,
} from '@/api/fixtures';
import { parseBackupJobs, parseIncludedVolumes, parseRetention } from '@/api/backupJobs';
import type { ClusterResource } from '@/api/types';

/**
 * Datacenter -> Backup Jobs (T66): the job table with its summaries, the gating on session mode +
 * `Sys.Modify` on `/`, the add/edit dialog and the exact request bodies it builds, the inline
 * Enabled switch, "Run now", the included-guests sheet, the typed-id delete confirm, and one real
 * fixture round trip. `useAuthMe`, `useRootPermissions` and `useClusterResources` are mocked so each
 * test controls the gate; the request functions in `@/api/backupJobs` are mocked so the exact
 * request can be asserted (the last test passes them through to the real fixture implementation).
 */
const state = vi.hoisted(() => ({ fixtures: false, passthrough: false }));
const mockUseAuthMe = vi.fn();
const mockUseRootPermissions = vi.fn();
const mockGetJobs = vi.fn();
const mockGetVolumes = vi.fn();
const mockGetStorages = vi.fn();
const mockGetPools = vi.fn();
const mockCreate = vi.fn();
const mockUpdate = vi.fn();
const mockDelete = vi.fn();
const mockRun = vi.fn();
const mockToastSuccess = vi.fn();
const mockToastError = vi.fn();

vi.mock('@/api/client', async () => {
  const actual = await vi.importActual<typeof import('@/api/client')>('@/api/client');
  return {
    ...actual,
    get USE_FIXTURES() {
      return state.fixtures;
    },
  };
});

const RESOURCES: ClusterResource[] = [
  { id: 'node/pve1', type: 'node', node: 'pve1', status: 'online' },
  { id: 'node/pve2', type: 'node', node: 'pve2', status: 'online' },
  { id: 'qemu/100', type: 'qemu', node: 'pve1', status: 'running', vmid: 100, name: 'web-prod-01' },
  { id: 'qemu/102', type: 'qemu', node: 'pve1', status: 'running', vmid: 102, name: 'db-prod-01' },
  { id: 'lxc/200', type: 'lxc', node: 'pve2', status: 'running', vmid: 200, name: 'caddy-proxy' },
];

vi.mock('@/api/hooks', async () => {
  const actual = await vi.importActual<typeof import('@/api/hooks')>('@/api/hooks');
  return {
    ...actual,
    useAuthMe: () => mockUseAuthMe(),
    useClusterResources: () => ({ data: RESOURCES }),
  };
});

vi.mock('@/api/rootPermissionHooks', () => ({ useRootPermissions: () => mockUseRootPermissions() }));

vi.mock('sonner', async () => {
  const actual = await vi.importActual<typeof import('sonner')>('sonner');
  return {
    ...actual,
    toast: {
      success: (...args: unknown[]) => mockToastSuccess(...args),
      error: (...args: unknown[]) => mockToastError(...args),
    },
  };
});

vi.mock('@/api/backupJobs', async () => {
  const actual = await vi.importActual<typeof import('@/api/backupJobs')>('@/api/backupJobs');
  return {
    ...actual,
    getBackupJobs: () => (state.passthrough ? actual.getBackupJobs() : mockGetJobs()),
    getIncludedVolumes: (id: string) => (state.passthrough ? actual.getIncludedVolumes(id) : mockGetVolumes(id)),
    getBackupStorages: () => (state.passthrough ? actual.getBackupStorages() : mockGetStorages()),
    getPools: () => (state.passthrough ? actual.getPools() : mockGetPools()),
    createBackupJob: (...args: unknown[]) =>
      state.passthrough ? actual.createBackupJob(args[0] as never) : mockCreate(...args),
    updateBackupJob: (...args: unknown[]) =>
      state.passthrough ? actual.updateBackupJob(args[0] as string, args[1] as never) : mockUpdate(...args),
    deleteBackupJob: (...args: unknown[]) =>
      state.passthrough ? actual.deleteBackupJob(args[0] as string) : mockDelete(...args),
    runBackupJob: (...args: unknown[]) => (state.passthrough ? actual.runBackupJob(args[0] as string) : mockRun(...args)),
  };
});

const SESSION_AUTH = { data: { username: 'root@pam', realm: 'pam', capabilities: {}, mode: 'session' } };
const TOKEN_AUTH = { data: { ...SESSION_AUTH.data, mode: 'token' } };

function permissions(privs: Record<string, boolean>) {
  return { data: { can: (p: string) => privs[p] === true } };
}

const TOKEN_TOOLTIP = 'Read-only: signed in with a service token';
const PRIVILEGE_TOOLTIP = "You don't have Sys.Modify on /";

function renderTab() {
  const queryClient = createQueryClient();
  render(
    <QueryClientProvider client={queryClient}>
      <BackupJobsTab />
    </QueryClientProvider>,
  );
}

async function openAdd() {
  fireEvent.click(await screen.findByRole('button', { name: 'Add job' }));
  return screen.findByRole('dialog');
}

async function openEdit(id: string) {
  fireEvent.click(await screen.findByRole('button', { name: `Edit job ${id}` }));
  return screen.findByRole('dialog');
}

function row(id: string) {
  return screen.getByTestId(`backup-job-${id}`);
}

describe('Datacenter Backup Jobs tab', () => {
  beforeEach(() => {
    state.fixtures = false;
    state.passthrough = false;
    resetFixtureBackupJobs();
    vi.clearAllMocks();
    mockUseAuthMe.mockReturnValue(SESSION_AUTH);
    mockUseRootPermissions.mockReturnValue(permissions({ 'Sys.Modify': true }));
    mockGetJobs.mockImplementation(() => Promise.resolve(structuredClone(fixtureBackupJobs)));
    mockGetVolumes.mockImplementation((id: string) =>
      Promise.resolve(parseIncludedVolumes(getFixtureBackupJobVolumes(id))),
    );
    mockGetStorages.mockResolvedValue(FIXTURE_BACKUP_STORAGES);
    mockGetPools.mockResolvedValue(FIXTURE_POOLS);
    mockCreate.mockResolvedValue({ ok: true, id: 'backup-new' });
    mockUpdate.mockResolvedValue({ ok: true, id: 'x' });
    mockDelete.mockResolvedValue({ ok: true });
    mockRun.mockResolvedValue({ upids: ['UPID:pve1:1', 'UPID:pve2:2'] });
  });

  it('(a) lists the jobs with their schedule, storage, mode, selection, compression and retention summaries', async () => {
    renderTab();
    await screen.findByTestId('backup-job-backup-nightly');

    const nightly = within(row('backup-nightly'));
    expect(nightly.getByText('02:00')).toBeInTheDocument();
    expect(nightly.getByText('backup-nfs')).toBeInTheDocument();
    expect(nightly.getByText('Snapshot')).toBeInTheDocument();
    expect(nightly.getByText('All guests (except 2)')).toBeInTheDocument();
    expect(nightly.getByText('ZSTD')).toBeInTheDocument();
    expect(nightly.getByText('Keep last 3, daily 7')).toBeInTheDocument();
    expect(nightly.getByText('Nightly, all production guests')).toBeInTheDocument();
    expect(nightly.getByText(/^in \d+h/)).toBeInTheDocument();
    expect(nightly.getByRole('switch', { name: 'Enable job backup-nightly' })).toHaveAttribute('aria-checked', 'true');

    const weekly = within(row('backup-weekly-prod'));
    expect(weekly.getByText('Pool prod')).toBeInTheDocument();
    expect(weekly.getByText('Keep weekly 4, monthly 6')).toBeInTheDocument();

    const archive = within(row('backup-archive'));
    expect(archive.getByText('3 guests')).toBeInTheDocument();
    expect(archive.getByText('GZIP')).toBeInTheDocument();
    expect(archive.getByText('Stop')).toBeInTheDocument();
    expect(archive.getByText('Keep all')).toBeInTheDocument();
    expect(archive.getByRole('switch', { name: 'Enable job backup-archive' })).toHaveAttribute('aria-checked', 'false');
    // A disabled job has no next run.
    expect(archive.getByText('-')).toBeInTheDocument();
  });

  it('(b) token mode: add, edit, toggle, run and delete are disabled with the read-only tooltip', async () => {
    mockUseAuthMe.mockReturnValue(TOKEN_AUTH);

    renderTab();
    await screen.findByTestId('backup-job-backup-nightly');

    for (const name of [
      'Add job',
      'Edit job backup-nightly',
      'Run job backup-nightly now',
      'Delete job backup-nightly',
      'Enable job backup-nightly',
    ]) {
      const control = screen.getByRole(name === 'Enable job backup-nightly' ? 'switch' : 'button', { name });
      expect(control).toBeDisabled();
      expect(control).toHaveAttribute('title', TOKEN_TOOLTIP);
    }
    // Reading the included guests is not a write.
    expect(screen.getByRole('button', { name: 'Show included guests for job backup-nightly' })).toBeEnabled();
  });

  it('(c) a session without Sys.Modify on / gets the privilege tooltip on every write', async () => {
    mockUseRootPermissions.mockReturnValue(permissions({ 'Sys.Audit': true }));

    renderTab();
    await screen.findByTestId('backup-job-backup-nightly');

    for (const name of ['Add job', 'Edit job backup-nightly', 'Run job backup-nightly now', 'Delete job backup-nightly']) {
      const button = screen.getByRole('button', { name });
      expect(button).toBeDisabled();
      expect(button).toHaveAttribute('title', PRIVILEGE_TOOLTIP);
    }
    const toggle = screen.getByRole('switch', { name: 'Enable job backup-nightly' });
    expect(toggle).toBeDisabled();
    expect(toggle).toHaveAttribute('title', PRIVILEGE_TOOLTIP);
  });

  it('(d) a minimal add sends the defaults spelled out', async () => {
    renderTab();
    const dialog = within(await openAdd());

    await waitFor(() => expect(dialog.getByLabelText('Storage')).toHaveValue('backup-nfs'));
    fireEvent.click(dialog.getByRole('button', { name: 'Create job' }));

    await waitFor(() => expect(mockCreate).toHaveBeenCalledTimes(1));
    expect(mockCreate.mock.calls[0]).toStrictEqual([
      {
        schedule: '02:00',
        storage: 'backup-nfs',
        selection: { kind: 'all' },
        enabled: true,
        mode: 'snapshot',
        compress: 'zstd',
      },
    ]);
    await waitFor(() => expect(mockToastSuccess).toHaveBeenCalledWith('Backup job created'));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });

  it('(e) a full add sends the exact body: preset schedule, chosen guests, retention, mail and advanced options', async () => {
    renderTab();
    const dialog = within(await openAdd());

    fireEvent.change(dialog.getByLabelText('Schedule'), { target: { value: 'mon..fri 02:00' } });
    await waitFor(() => expect(dialog.getByLabelText('Storage')).toHaveValue('backup-nfs'));
    fireEvent.change(dialog.getByLabelText('Storage'), { target: { value: 'tank-backups' } });
    fireEvent.change(dialog.getByLabelText('Mode'), { target: { value: 'stop' } });
    fireEvent.change(dialog.getByLabelText('Compression'), { target: { value: 'gzip' } });
    fireEvent.change(dialog.getByLabelText('Selection mode'), { target: { value: 'vmids' } });
    fireEvent.click(dialog.getByRole('checkbox', { name: /^102/ }));
    fireEvent.click(dialog.getByRole('checkbox', { name: /^100/ }));
    fireEvent.change(dialog.getByLabelText('Keep last'), { target: { value: '3' } });
    fireEvent.change(dialog.getByLabelText('Keep daily'), { target: { value: '7' } });
    fireEvent.change(dialog.getByLabelText('Send email to'), { target: { value: 'ops@example.com, backup@example.org' } });
    fireEvent.change(dialog.getByLabelText('Send when'), { target: { value: 'failure' } });
    fireEvent.change(dialog.getByLabelText('Notification mode'), { target: { value: 'notification-system' } });
    fireEvent.change(dialog.getByLabelText('Comment'), { target: { value: ' weekday fulls ' } });
    fireEvent.change(dialog.getByLabelText('Bandwidth limit (KiB/s)'), { target: { value: '51200' } });
    fireEvent.change(dialog.getByLabelText('zstd threads'), { target: { value: '4' } });
    fireEvent.change(dialog.getByLabelText('I/O priority'), { target: { value: '7' } });
    fireEvent.click(dialog.getByRole('checkbox', { name: 'Repeat missed runs' }));
    fireEvent.click(dialog.getByRole('checkbox', { name: 'Protect the backups from pruning' }));
    fireEvent.click(dialog.getByRole('checkbox', { name: 'Enabled' }));

    fireEvent.click(dialog.getByRole('button', { name: 'Create job' }));

    await waitFor(() => expect(mockCreate).toHaveBeenCalledTimes(1));
    expect(mockCreate.mock.calls[0]).toStrictEqual([
      {
        schedule: 'mon..fri 02:00',
        storage: 'tank-backups',
        selection: { kind: 'vmids', vmids: [100, 102] },
        enabled: false,
        mode: 'stop',
        compress: 'gzip',
        mailto: ['ops@example.com', 'backup@example.org'],
        mailnotification: 'failure',
        notificationMode: 'notification-system',
        pruneBackups: { keepLast: 3, keepDaily: 7 },
        comment: 'weekday fulls',
        repeatMissed: true,
        bwlimit: 51200,
        zstd: 4,
        ionice: 7,
        protected: true,
      },
    ]);
  });

  it('(f) a custom schedule, a pool and an exclude list; invalid input disables Create and shows why', async () => {
    renderTab();
    const dialog = within(await openAdd());
    await waitFor(() => expect(dialog.getByLabelText('Storage')).toHaveValue('backup-nfs'));
    const create = dialog.getByRole('button', { name: 'Create job' });

    fireEvent.change(dialog.getByLabelText('Schedule'), { target: { value: 'custom' } });
    fireEvent.change(dialog.getByLabelText('Custom schedule'), { target: { value: 'sat 22:30; rm' } });
    expect(create).toBeDisabled();
    expect(dialog.getByText('Enter a calendar event such as mon..fri 02:00.')).toBeInTheDocument();
    fireEvent.change(dialog.getByLabelText('Custom schedule'), { target: { value: 'sat 22:30' } });
    expect(create).toBeEnabled();

    fireEvent.change(dialog.getByLabelText('Selection mode'), { target: { value: 'pool' } });
    expect(create).toBeDisabled();
    expect(dialog.getByText('Choose a pool.')).toBeInTheDocument();
    fireEvent.change(dialog.getByLabelText('Pool'), { target: { value: 'prod' } });
    expect(create).toBeEnabled();

    fireEvent.change(dialog.getByLabelText('Selection mode'), { target: { value: 'all' } });
    fireEvent.click(dialog.getByRole('checkbox', { name: /^200/ }));
    fireEvent.change(dialog.getByLabelText('Keep last'), { target: { value: '400' } });
    expect(create).toBeDisabled();
    fireEvent.change(dialog.getByLabelText('Keep last'), { target: { value: '' } });
    fireEvent.click(dialog.getByLabelText('Keep all backups'));
    fireEvent.click(create);

    await waitFor(() => expect(mockCreate).toHaveBeenCalledTimes(1));
    expect(mockCreate.mock.calls[0]).toStrictEqual([
      {
        schedule: 'sat 22:30',
        storage: 'backup-nfs',
        selection: { kind: 'all', exclude: [200] },
        enabled: true,
        mode: 'snapshot',
        compress: 'zstd',
        pruneBackups: { keepAll: true },
      },
    ]);
  });

  it('(g) editing switches the selection kind and sends only the changed key', async () => {
    renderTab();
    const dialog = within(await openEdit('backup-weekly-prod'));
    expect(dialog.getByRole('heading', { name: 'Edit backup job backup-weekly-prod' })).toBeInTheDocument();
    // Nothing changed yet: nothing to save.
    expect(dialog.getByRole('button', { name: 'Save changes' })).toBeDisabled();

    fireEvent.change(dialog.getByLabelText('Selection mode'), { target: { value: 'all' } });
    fireEvent.click(dialog.getByRole('checkbox', { name: /^100/ }));
    fireEvent.click(dialog.getByRole('button', { name: 'Save changes' }));

    await waitFor(() => expect(mockUpdate).toHaveBeenCalledTimes(1));
    // The server turns the new kind into PVE's delete list (all/exclude/pool/vmid): see backupJobRoutes.test.ts.
    expect(mockUpdate.mock.calls[0]).toStrictEqual(['backup-weekly-prod', { selection: { kind: 'all', exclude: [100] } }]);
    await waitFor(() => expect(mockToastSuccess).toHaveBeenCalledWith('Backup job backup-weekly-prod saved'));
  });

  it('(h) editing sends an explicit null for a setting the user cleared', async () => {
    renderTab();
    const dialog = within(await openEdit('backup-weekly-prod'));

    fireEvent.change(dialog.getByLabelText('Send email to'), { target: { value: '' } });
    fireEvent.change(dialog.getByLabelText('Send when'), { target: { value: '' } });
    fireEvent.change(dialog.getByLabelText('Keep weekly'), { target: { value: '' } });
    fireEvent.change(dialog.getByLabelText('Keep monthly'), { target: { value: '' } });
    fireEvent.change(dialog.getByLabelText('Comment'), { target: { value: 'new note' } });
    fireEvent.change(dialog.getByLabelText('Schedule'), { target: { value: '*-*-01 03:00' } });
    fireEvent.click(dialog.getByRole('button', { name: 'Save changes' }));

    await waitFor(() => expect(mockUpdate).toHaveBeenCalledTimes(1));
    expect(mockUpdate.mock.calls[0]).toStrictEqual([
      'backup-weekly-prod',
      { schedule: '*-*-01 03:00', mailto: null, mailnotification: null, pruneBackups: null, comment: 'new note' },
    ]);
  });

  it('(i) a server error on save stays inline and the dialog stays open', async () => {
    mockCreate.mockRejectedValue(new GuestActionError(400, 'Parameter verification failed. schedule: invalid format'));

    renderTab();
    const dialog = within(await openAdd());
    await waitFor(() => expect(dialog.getByLabelText('Storage')).toHaveValue('backup-nfs'));
    fireEvent.click(dialog.getByRole('button', { name: 'Create job' }));

    expect(await dialog.findByRole('alert')).toHaveTextContent('Parameter verification failed. schedule: invalid format');
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });

  it('(j) the Enabled switch sends { enabled: false } and toasts', async () => {
    renderTab();
    await screen.findByTestId('backup-job-backup-nightly');

    fireEvent.click(screen.getByRole('switch', { name: 'Enable job backup-nightly' }));

    await waitFor(() => expect(mockUpdate).toHaveBeenCalledTimes(1));
    expect(mockUpdate.mock.calls[0]).toStrictEqual(['backup-nightly', { enabled: false }]);
    await waitFor(() => expect(mockToastSuccess).toHaveBeenCalledWith('Backup job backup-nightly disabled'));
  });

  it('(k) Run now calls the route and toasts the number of started tasks; a failure is a toast', async () => {
    renderTab();
    await screen.findByTestId('backup-job-backup-nightly');

    fireEvent.click(screen.getByRole('button', { name: 'Run job backup-nightly now' }));
    await waitFor(() => expect(mockRun).toHaveBeenCalledTimes(1));
    expect(mockRun.mock.calls[0]).toStrictEqual(['backup-nightly']);
    await waitFor(() => expect(mockToastSuccess).toHaveBeenCalledWith('Backup job backup-nightly started (2 tasks)'));

    mockRun.mockRejectedValue(new GuestActionError(403, "You don't have VM.Backup"));
    fireEvent.click(screen.getByRole('button', { name: 'Run job backup-archive now' }));
    await waitFor(() => expect(mockToastError).toHaveBeenCalledWith("You don't have VM.Backup"));
  });

  it('(l) the included-guests sheet lists the guests and their volumes with a backup=0 marker', async () => {
    renderTab();
    await screen.findByTestId('backup-job-backup-nightly');

    fireEvent.click(screen.getByRole('button', { name: 'Show included guests for job backup-nightly' }));

    const sheet = within(await screen.findByRole('dialog'));
    expect(sheet.getByText('Included guests: backup-nightly')).toBeInTheDocument();
    const list = within(await sheet.findByRole('list', { name: 'Included guests' }));
    expect(list.getByText('web-prod-01')).toBeInTheDocument();
    expect(list.getByText('db-prod-01')).toBeInTheDocument();
    expect(list.getByText('pihole')).toBeInTheDocument();
    expect(list.getByText('Excluded (backup=0)')).toBeInTheDocument();
    expect(list.getAllByText('Included').length).toBeGreaterThanOrEqual(4);
    expect(mockGetVolumes).toHaveBeenCalledWith('backup-nightly');
  });

  it('(m) delete needs the job id typed, then sends exactly one DELETE for that job', async () => {
    renderTab();
    await screen.findByTestId('backup-job-backup-archive');

    fireEvent.click(screen.getByRole('button', { name: 'Delete job backup-archive' }));
    const dialog = within(await screen.findByRole('alertdialog'));
    expect(dialog.getByText(/backups it already made stay on the storage/)).toBeInTheDocument();
    const confirm = dialog.getByRole('button', { name: 'Delete job' });
    expect(confirm).toBeDisabled();

    fireEvent.change(dialog.getByLabelText('Type the job ID to confirm'), { target: { value: 'backup-archiv' } });
    expect(confirm).toBeDisabled();
    fireEvent.change(dialog.getByLabelText('Type the job ID to confirm'), { target: { value: 'backup-archive' } });
    expect(confirm).toBeEnabled();
    fireEvent.click(confirm);

    await waitFor(() => expect(mockDelete).toHaveBeenCalledTimes(1));
    expect(mockDelete.mock.calls[0]).toStrictEqual(['backup-archive']);
    await waitFor(() => expect(mockToastSuccess).toHaveBeenCalledWith('Backup job backup-archive deleted'));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument());
  });

  it('(n) fixture round trip: add a job, switch it off, run it, delete it', async () => {
    state.fixtures = true;
    state.passthrough = true;

    renderTab();
    await screen.findByTestId('backup-job-backup-nightly');
    expect(fixtureBackupJobs).toHaveLength(3);

    const dialog = within(await openAdd());
    await waitFor(() => expect(dialog.getByLabelText('Storage')).toHaveValue('backup-nfs'));
    fireEvent.change(dialog.getByLabelText('Selection mode'), { target: { value: 'pool' } });
    fireEvent.change(dialog.getByLabelText('Pool'), { target: { value: 'lab' } });
    fireEvent.change(dialog.getByLabelText('Comment'), { target: { value: 'lab nightly' } });
    fireEvent.click(dialog.getByRole('button', { name: 'Create job' }));

    const created = await screen.findByTestId('backup-job-backup-demo-1');
    expect(within(created).getByText('Pool lab')).toBeInTheDocument();
    expect(within(created).getByText('lab nightly')).toBeInTheDocument();
    expect(fixtureBackupJobs).toHaveLength(4);

    fireEvent.click(within(created).getByRole('switch', { name: 'Enable job backup-demo-1' }));
    await waitFor(() =>
      expect(within(screen.getByTestId('backup-job-backup-demo-1')).getByRole('switch')).toHaveAttribute(
        'aria-checked',
        'false',
      ),
    );

    fireEvent.click(screen.getByRole('button', { name: 'Run job backup-nightly now' }));
    await waitFor(() => expect(mockToastSuccess).toHaveBeenCalledWith(expect.stringMatching(/^Backup job backup-nightly started \(\d tasks?\)$/)));

    fireEvent.click(screen.getByRole('button', { name: 'Delete job backup-demo-1' }));
    const confirm = within(await screen.findByRole('alertdialog'));
    fireEvent.change(confirm.getByLabelText('Type the job ID to confirm'), { target: { value: 'backup-demo-1' } });
    fireEvent.click(confirm.getByRole('button', { name: 'Delete job' }));

    await waitFor(() => expect(screen.queryByTestId('backup-job-backup-demo-1')).not.toBeInTheDocument());
    expect(fixtureBackupJobs).toHaveLength(3);
  });

  it('(o) parses PVE job rows: flags, vmid/exclude lists, prune-backups as an object or a string, mailto', () => {
    const jobs = parseBackupJobs([
      {
        id: 'a',
        schedule: '02:00',
        storage: 's',
        all: 1,
        exclude: '100,101',
        'prune-backups': { 'keep-last': 3, 'keep-daily': 7 },
        mailto: 'x@example.com,y@example.com',
        'next-run': 1_800_000_000,
        enabled: 0,
        'repeat-missed': 1,
      },
      { id: 'b', schedule: 'sun 01:00', storage: 's', vmid: '100,102', 'prune-backups': 'keep-all=1', compress: 0 },
      { id: 'c', schedule: 'sun 02:00', storage: 's', pool: 'prod', 'prune-backups': 'keep-weekly=4,keep-monthly=6' },
      { schedule: 'no id' },
    ]);
    expect(jobs.map((j) => j.id)).toStrictEqual(['a', 'b', 'c']);
    expect(jobs[0]).toMatchObject({
      enabled: false,
      selection: { kind: 'all', exclude: [100, 101] },
      retention: { keepAll: false, keepLast: 3, keepDaily: 7 },
      mailto: ['x@example.com', 'y@example.com'],
      nextRun: 1_800_000_000,
      repeatMissed: true,
    });
    expect(jobs[1]).toMatchObject({ enabled: true, selection: { kind: 'vmids', vmids: [100, 102] }, retention: { keepAll: true }, compress: '0' });
    expect(jobs[2]?.selection).toStrictEqual({ kind: 'pool', pool: 'prod' });
    expect(jobs[2]?.retention).toStrictEqual({ keepAll: false, keepWeekly: 4, keepMonthly: 6 });
    expect(parseRetention(undefined)).toStrictEqual({ keepAll: false });
  });
});
