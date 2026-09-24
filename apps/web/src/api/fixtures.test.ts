import { describe, expect, it } from 'vitest';
import { fixtureClient } from './fixtures';
import { NotFoundError, isNotFoundError } from './errors';
import { computeAlerts } from '@/lib/dashboard';

describe('fixtureClient not-found behavior', () => {
  it('rejects getVmStatus for an unknown vmid with a NotFoundError', async () => {
    await expect(fixtureClient.getVmStatus('pve1', 'qemu', 999)).rejects.toBeInstanceOf(NotFoundError);
  });

  it('rejects getVmConfig for an unknown vmid with a NotFoundError', async () => {
    await expect(fixtureClient.getVmConfig('pve1', 'qemu', 999)).rejects.toBeInstanceOf(NotFoundError);
  });

  it('rejects getVmStatus for a real vmid on an unknown node with a NotFoundError', async () => {
    await expect(fixtureClient.getVmStatus('nope', 'qemu', 100)).rejects.toBeInstanceOf(NotFoundError);
  });

  it('rejects getNodeStatus for an unknown node with a NotFoundError', async () => {
    await expect(fixtureClient.getNodeStatus('nope')).rejects.toBeInstanceOf(NotFoundError);
  });

  it('isNotFoundError distinguishes NotFoundError from a generic Error', () => {
    expect(isNotFoundError(new NotFoundError('x'))).toBe(true);
    expect(isNotFoundError(new Error('x'))).toBe(false);
  });

  it('resolves getVmStatus/getVmConfig/getNodeStatus for real objects', async () => {
    await expect(fixtureClient.getVmStatus('pve1', 'qemu', 100)).resolves.toBeDefined();
    await expect(fixtureClient.getVmConfig('pve1', 'qemu', 100)).resolves.toBeDefined();
    await expect(fixtureClient.getNodeStatus('pve1')).resolves.toBeDefined();
  });
});

describe('fixture realism for the dashboard demo', () => {
  it('rebases task timestamps so the fixture ERROR task never ages out of the 24h alert window', async () => {
    // Regression coverage: the checked-in tasks.json has whatever timestamps were current when
    // it was captured. Without rebasing (see getRebasedTasks in fixtures.ts), real wall-clock
    // time keeps moving further past them until the one ERROR task in the fixture falls outside
    // computeAlerts' 24h lookback and the dashboard's error alert silently disappears.
    const tasks = await fixtureClient.getTasks();
    // Not a `vzdump` task: those failures are handled separately, by the backup-incident rule
    // (T23) -- see the `getAlerts()` test below for that path.
    const errorTask = tasks.find((t) => t.type !== 'vzdump' && t.status?.toLowerCase().includes('error'));
    expect(errorTask).toBeDefined();

    // No injected `nowSeconds` -- this is the same call the dashboard itself makes.
    const alerts = computeAlerts([], tasks);
    expect(alerts.some((a) => a.id === errorTask!.upid && a.severity === 'error')).toBe(true);
  });

  it('has a fixture storage resource over the 85% alert threshold', async () => {
    const resources = await fixtureClient.getClusterResources();
    const tankBackups = resources.find((r) => r.type === 'storage' && r.storage === 'tank-backups');
    expect(tankBackups).toBeDefined();

    const alerts = computeAlerts(resources, []);
    expect(alerts.some((a) => a.id === tankBackups!.id && a.severity === 'warning')).toBe(true);
  });

  it('getAlerts() produces all three backup-incident states from the fixture data (T23)', async () => {
    const alerts = await fixtureClient.getAlerts();
    const backups = alerts.filter((a) => a.kind === 'backup');

    // VMID 304 (queue-worker-01): 3 failures overnight, never healed -> hard/error.
    expect(backups.some((a) => a.vmid === '304' && a.severity === 'error')).toBe(true);
    // VMID 305 (search-prod-01): failed, a retry is currently running -> soft/warning.
    expect(
      backups.some(
        (a) => a.vmid === '305' && a.severity === 'warning' && a.incident?.runningUpid,
      ),
    ).toBe(true);
    // VMID 300 (app-prod-01): healed within 5 minutes -> healed.
    expect(backups.some((a) => a.vmid === '300' && a.severity === 'healed')).toBe(true);
  });

  it('caps getTasks() (the cluster recent-task list) at 25 rows, mirroring real PVE', async () => {
    const tasks = await fixtureClient.getTasks();
    expect(tasks.length).toBeLessThanOrEqual(25);
    // Still sorted newest-first -- callers (the Recent Tasks drawer, /tasks) read `tasks[0]` as
    // "latest".
    const starttimes = tasks.map((t) => t.starttime);
    expect([...starttimes].sort((a, b) => b - a)).toEqual(starttimes);
  });
});

describe('getNodeTasks (the per-node task index -- T17)', () => {
  it('filters by vmid: guest 102 (db-prod-01) has deep backup+activity history (>25 rows)', async () => {
    const tasks = await fixtureClient.getNodeTasks('pve1', { vmid: 102, limit: 200, source: 'all' });
    expect(tasks.length).toBeGreaterThan(25);
    expect(tasks.every((t) => t.id === '102')).toBe(true);
  });

  it('filters by typefilter=vzdump for the Last backup panel (limit 1 returns the newest one)', async () => {
    const tasks = await fixtureClient.getNodeTasks('pve1', {
      vmid: 102,
      typefilter: 'vzdump',
      limit: 1,
      source: 'all',
    });
    expect(tasks).toHaveLength(1);
    expect(tasks[0]!.type).toBe('vzdump');
    // Sorted starttime desc -- this is the single newest vzdump row for this guest.
    const all = await fixtureClient.getNodeTasks('pve1', {
      vmid: 102,
      typefilter: 'vzdump',
      limit: 200,
      source: 'all',
    });
    expect(tasks[0]!.starttime).toBe(Math.max(...all.map((t) => t.starttime)));
  });

  it('returns nothing for a guest with no vzdump history (empty-state guest)', async () => {
    const tasks = await fixtureClient.getNodeTasks('pve1', {
      vmid: 202,
      typefilter: 'vzdump',
      limit: 1,
      source: 'all',
    });
    expect(tasks).toHaveLength(0);
  });

  it('sorts by starttime desc regardless of the fixture file order', async () => {
    const tasks = await fixtureClient.getNodeTasks('pve1', { limit: 200, source: 'all' });
    const starttimes = tasks.map((t) => t.starttime);
    expect([...starttimes].sort((a, b) => b - a)).toEqual(starttimes);
  });

  it('applies start/limit as a page over the sorted list', async () => {
    const first = await fixtureClient.getNodeTasks('pve1', { vmid: 102, limit: 3, source: 'all' });
    const skipped = await fixtureClient.getNodeTasks('pve1', {
      vmid: 102,
      start: 1,
      limit: 2,
      source: 'all',
    });
    expect(skipped).toEqual(first.slice(1, 3));
  });

  it('filters by node (a different node has no rows)', async () => {
    const tasks = await fixtureClient.getNodeTasks('some-other-node', { limit: 200, source: 'all' });
    expect(tasks).toHaveLength(0);
  });

  it('includes the running (no-endtime) fixture task when it matches', async () => {
    const tasks = await fixtureClient.getNodeTasks('pve1', {
      vmid: 100,
      typefilter: 'vzdump',
      limit: 200,
      source: 'all',
    });
    expect(tasks.some((t) => t.endtime === undefined && t.status === 'running')).toBe(true);
  });

  it('defaults to a page size of 50 when limit is omitted', async () => {
    const tasks = await fixtureClient.getNodeTasks('pve1', { source: 'all' });
    expect(tasks.length).toBeLessThanOrEqual(50);
  });
});
