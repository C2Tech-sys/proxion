import { describe, expect, it } from 'vitest';
import { computeAlerts, type ResourceLike } from '../src/alerts.js';
import type { TaskLike } from '../src/tasks.js';

const HOUR = 3600;
const MIN = 60;
const BASE = 2_000_000_000; // 2033-05-18T03:33:20Z

let seq = 0;
function vzdump(node: string, vmid: string, starttime: number, overrides: Partial<TaskLike> = {}): TaskLike {
  seq += 1;
  return {
    upid: `UPID:${node}:${String(seq).padStart(8, '0')}:00000000:00000000:vzdump:${vmid}:msp360@pve:`,
    node,
    type: 'vzdump',
    id: vmid,
    user: 'msp360@pve',
    starttime,
    ...overrides,
  };
}
function ok(node: string, vmid: string, starttime: number): TaskLike {
  return vzdump(node, vmid, starttime, { endtime: starttime + 60, status: 'OK' });
}
function failed(node: string, vmid: string, starttime: number): TaskLike {
  return vzdump(node, vmid, starttime, { endtime: starttime + 60, status: 'ERROR: job errors' });
}

function guest(vmid: number, name: string, node = 'pve1'): ResourceLike {
  return { id: `qemu/${vmid}`, type: 'qemu', node, vmid, name };
}

function nonVzdumpTask(overrides: Partial<TaskLike> & { upid: string }): TaskLike {
  return {
    node: 'pve1',
    type: 'qmstart',
    id: '100',
    user: 'root@pam',
    starttime: 1000,
    ...overrides,
  };
}

function storage(overrides: Partial<ResourceLike> & { id: string }): ResourceLike {
  return {
    type: 'storage',
    node: 'pve1',
    storage: 'tank',
    ...overrides,
  };
}

describe('computeAlerts: backup incidents', () => {
  it('renders a soft incident as a warning with the retry-pending detail', () => {
    // 20:10 UTC on the BASE day.
    const failAt = Math.floor(BASE / 86400) * 86400 + 20 * HOUR + 10 * MIN;
    const tasks = [failed('pve1', '100', failAt)];
    const alerts = computeAlerts({
      resources: [guest(100, 'web-prod-01')],
      tasks,
      now: (failAt + 20 * MIN) * 1000,
    });
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({
      kind: 'backup',
      severity: 'warning',
      title: 'Backup of web-prod-01 (100) failed at 20:10 — waiting for a retry',
    });
    // windowEndsAt = 20:10 + 6h = 02:10 (next day; formatTime only ever renders HH:MM).
    expect(alerts[0]!.detail).toBe('retry pending · window until 02:10');
  });

  it('renders a 3-strike hard incident as an error with the "N times tonight" wording', () => {
    const failAt = Math.floor(BASE / 86400) * 86400 + 20 * HOUR;
    const tasks = [
      failed('pve1', '100', failAt),
      failed('pve1', '100', failAt + 10 * MIN),
      failed('pve1', '100', failAt + 20 * MIN),
    ];
    const alerts = computeAlerts({
      resources: [guest(100, 'web-prod-01')],
      tasks,
      now: (failAt + 21 * MIN) * 1000,
    });
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({
      severity: 'error',
      title: 'Backup of web-prod-01 (100) failed 3 times tonight',
    });
  });

  it('renders a timed-out hard incident as an error with the "no successful retry" wording', () => {
    const failAt = Math.floor(BASE / 86400) * 86400 + 20 * HOUR + 10 * MIN;
    const tasks = [failed('pve1', '100', failAt)];
    const alerts = computeAlerts({
      resources: [guest(100, 'web-prod-01')],
      tasks,
      now: (failAt + 7 * HOUR) * 1000,
    });
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({
      severity: 'error',
      title: 'Backup of web-prod-01 (100) failed at 20:10 — no successful retry within 6 h',
    });
  });

  it('renders a healed incident, muted, with both timestamps', () => {
    const failAt = Math.floor(BASE / 86400) * 86400 + 20 * HOUR + 10 * MIN;
    const healAt = failAt + 5 * MIN;
    const tasks = [failed('pve1', '100', failAt), ok('pve1', '100', healAt - 60)]; // lands at healAt
    const alerts = computeAlerts({
      resources: [guest(100, 'web-prod-01')],
      tasks,
      now: (healAt + MIN) * 1000,
    });
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({
      severity: 'healed',
      title: 'Backup of web-prod-01 (100) failed at 20:10 · healed by retry at 20:15',
    });
  });

  it('stops showing a healed incident once it has been healed for longer than the visibility window', () => {
    const failAt = BASE;
    const healAt = failAt + 5 * MIN;
    const tasks = [failed('pve1', '100', failAt), ok('pve1', '100', healAt - 60)]; // lands at healAt
    const stillVisible = computeAlerts({ resources: [], tasks, now: (healAt + 5 * HOUR) * 1000 });
    const noLongerVisible = computeAlerts({ resources: [], tasks, now: (healAt + 7 * HOUR) * 1000 });
    expect(stillVisible).toHaveLength(1);
    expect(noLongerVisible).toHaveLength(0);
  });

  it('falls back to "VM <vmid>" when no matching resource has a name', () => {
    const tasks = [failed('pve1', '999', BASE)];
    const alerts = computeAlerts({ resources: [], tasks, now: (BASE + MIN) * 1000 });
    expect(alerts[0]!.title).toContain('VM 999');
  });

  it('sorts errors first, then warnings, then healed by healedAt descending', () => {
    const t0 = BASE;
    const tasks: TaskLike[] = [
      // hard (error): 3 strikes
      failed('pve1', '1', t0),
      failed('pve1', '1', t0 + MIN),
      failed('pve1', '1', t0 + 2 * MIN),
      // soft (warning)
      failed('pve1', '2', t0),
      // healed, older heal
      failed('pve1', '3', t0),
      ok('pve1', '3', t0 + MIN),
      // healed, more recent heal
      failed('pve1', '4', t0 + 10 * MIN),
      ok('pve1', '4', t0 + 11 * MIN),
    ];
    const alerts = computeAlerts({ resources: [], tasks, now: (t0 + 12 * MIN) * 1000 });
    expect(alerts.map((a) => a.severity)).toEqual(['error', 'warning', 'healed', 'healed']);
    expect(alerts.map((a) => a.vmid).slice(2)).toEqual(['4', '3']); // more recently healed first
  });
});

describe('computeAlerts: non-vzdump task failures (unchanged behaviour)', () => {
  const now = 100_000 * 1000; // ms

  it('flags a task that failed within the last 24h', () => {
    const alerts = computeAlerts({
      resources: [],
      tasks: [nonVzdumpTask({ upid: 'UPID:1', status: 'some error', starttime: 100_000 - 3600 })],
      now,
    });
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({
      severity: 'error',
      id: 'UPID:1',
      title: 'qmstart failed on pve1 (100) — root@pam',
    });
  });

  it('ignores a failed task older than 24h', () => {
    const alerts = computeAlerts({
      resources: [],
      tasks: [nonVzdumpTask({ upid: 'UPID:1', status: 'error', starttime: 100_000 - 90_000 })],
      now,
    });
    expect(alerts).toHaveLength(0);
  });

  it('ignores a running or OK task', () => {
    const alerts = computeAlerts({
      resources: [],
      tasks: [
        nonVzdumpTask({ upid: 'UPID:1', status: 'running', starttime: 100_000 - 10 }),
        nonVzdumpTask({ upid: 'UPID:2', status: 'OK', starttime: 100_000 - 10 }),
      ],
      now,
    });
    expect(alerts).toHaveLength(0);
  });
});

describe('computeAlerts: storage-full warnings (unchanged behaviour)', () => {
  const now = 100_000 * 1000;

  it('flags storage over 85% full', () => {
    const alerts = computeAlerts({
      resources: [storage({ id: 'storage/pve1/tank', disk: 90, maxdisk: 100 })],
      tasks: [],
      now,
    });
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({
      severity: 'warning',
      title: 'Storage "tank" on pve1 is 90% full',
    });
  });

  it('does not flag storage at or below 85% full', () => {
    const alerts = computeAlerts({
      resources: [storage({ id: 'storage/pve1/tank', disk: 85, maxdisk: 100 })],
      tasks: [],
      now,
    });
    expect(alerts).toHaveLength(0);
  });

  it('returns [] when nothing is wrong', () => {
    expect(computeAlerts({ resources: [], tasks: [], now })).toEqual([]);
  });
});
