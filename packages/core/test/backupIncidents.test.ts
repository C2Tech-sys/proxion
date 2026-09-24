import { describe, expect, it } from 'vitest';
import { computeBackupIncidents, DEFAULT_HEAL_WINDOW_MS, DEFAULT_LOOKBACK_MS } from '../src/backupIncidents.js';
import type { TaskLike } from '../src/tasks.js';

const HOUR = 3600;
const MIN = 60;
/** Arbitrary fixed reference point (seconds) every case's timestamps are expressed relative to. */
const BASE = 2_000_000_000;

let seq = 0;
function vzdump(
  node: string,
  vmid: string,
  starttime: number,
  overrides: Partial<TaskLike> = {},
): TaskLike {
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

function ok(node: string, vmid: string, starttime: number, durationSeconds = 60): TaskLike {
  return vzdump(node, vmid, starttime, { endtime: starttime + durationSeconds, status: 'OK' });
}

function failed(node: string, vmid: string, starttime: number, durationSeconds = 60): TaskLike {
  return vzdump(node, vmid, starttime, {
    endtime: starttime + durationSeconds,
    status: 'ERROR: command failed with exit code 1',
  });
}

function running(node: string, vmid: string, starttime: number): TaskLike {
  return vzdump(node, vmid, starttime);
}

describe('computeBackupIncidents', () => {
  it('heals within 5 minutes (VM113 reference case)', () => {
    const tasks = [failed('pve1', '113', BASE), ok('pve1', '113', BASE + 5 * MIN)];
    const incidents = computeBackupIncidents(tasks, { now: (BASE + 10 * MIN) * 1000 });
    expect(incidents).toHaveLength(1);
    expect(incidents[0]).toMatchObject({
      node: 'pve1',
      vmid: '113',
      state: 'healed',
      healedAt: BASE + 5 * MIN + 60, // when the retry finished, not when it started
      healedByUpid: tasks[1]!.upid,
    });
    expect(incidents[0]!.attempts).toHaveLength(1);
  });

  it('heals after a 3.6h forced-full retry (VM109 reference case): healed when the retry lands', () => {
    // The retry started 4 minutes after the failure and ran for 3.6h; "healed at" is when it
    // finished (~06:00 in the owner's report), not when it started (02:24).
    const retryStart = BASE + 4 * MIN;
    const retryDuration = 3.6 * HOUR;
    const tasks = [failed('pve1', '109', BASE), ok('pve1', '109', retryStart, retryDuration)];
    const incidents = computeBackupIncidents(tasks, {
      now: (retryStart + retryDuration + 10 * MIN) * 1000,
    });
    expect(incidents).toHaveLength(1);
    expect(incidents[0]).toMatchObject({ state: 'healed', healedAt: retryStart + retryDuration });
  });

  it('stays soft while a retry is running, even past the 6h window', () => {
    const runningTask = running('pve1', '171', BASE + 10 * MIN);
    const tasks = [failed('pve1', '171', BASE), runningTask];
    const incidents = computeBackupIncidents(tasks, { now: (BASE + 7 * HOUR) * 1000 });
    expect(incidents).toHaveLength(1);
    expect(incidents[0]).toMatchObject({ state: 'soft', runningUpid: runningTask.upid });
  });

  it('goes hard when no OK arrives within 6h', () => {
    const tasks = [failed('pve1', '150', BASE)];
    const incidents = computeBackupIncidents(tasks, { now: (BASE + 7 * HOUR) * 1000 });
    expect(incidents).toHaveLength(1);
    expect(incidents[0]).toMatchObject({ state: 'hard' });
    expect(incidents[0]!.attempts).toHaveLength(1);
  });

  it('goes hard at 3 distinct failures even well inside the heal window', () => {
    const tasks = [
      failed('pve1', '151', BASE),
      failed('pve1', '151', BASE + 10 * MIN),
      failed('pve1', '151', BASE + 20 * MIN),
    ];
    const incidents = computeBackupIncidents(tasks, { now: (BASE + 21 * MIN) * 1000 });
    expect(incidents).toHaveLength(1);
    expect(incidents[0]).toMatchObject({ state: 'hard' });
    expect(incidents[0]!.attempts).toHaveLength(3);
  });

  it('an OK that lands after the window still heals (the backup is good now); a later failure starts a new incident', () => {
    const tasks = [
      failed('pve1', '152', BASE),
      ok('pve1', '152', BASE + 7 * HOUR),
      failed('pve1', '152', BASE + 8 * HOUR),
    ];
    // Before the late OK landed the incident was hard (window passed, nothing running)...
    const before = computeBackupIncidents(tasks.slice(0, 1), { now: (BASE + 6.5 * HOUR) * 1000 });
    expect(before[0]).toMatchObject({ state: 'hard' });

    // ...and once it lands, healed -- a standing error for a backup that has since succeeded
    // is exactly the stale alert this rule exists to avoid.
    const incidents = computeBackupIncidents(tasks, { now: (BASE + 8 * HOUR + 10 * MIN) * 1000 });
    expect(incidents).toHaveLength(2);
    const [first, second] = incidents;
    expect(first).toMatchObject({
      state: 'healed',
      firstFailedAt: BASE,
      lastFailedAt: BASE,
      healedAt: BASE + 7 * HOUR + 60,
    });
    expect(second).toMatchObject({ state: 'soft', firstFailedAt: BASE + 8 * HOUR });
  });

  it('keeps failures on two different guests independent', () => {
    const tasks = [
      failed('pve1', '160', BASE),
      failed('pve1', '161', BASE),
      failed('pve1', '161', BASE + 10 * MIN),
      failed('pve1', '161', BASE + 20 * MIN),
    ];
    const incidents = computeBackupIncidents(tasks, { now: (BASE + 21 * MIN) * 1000 });
    expect(incidents).toHaveLength(2);
    const a = incidents.find((i) => i.vmid === '160')!;
    const b = incidents.find((i) => i.vmid === '161')!;
    expect(a.state).toBe('soft');
    expect(a.attempts).toHaveLength(1);
    expect(b.state).toBe('hard');
    expect(b.attempts).toHaveLength(3);
  });

  it('keeps the same VMID on two different nodes independent', () => {
    const tasks = [
      failed('pve1', '100', BASE),
      failed('pve2', '100', BASE),
      ok('pve2', '100', BASE + 5 * MIN),
    ];
    const incidents = computeBackupIncidents(tasks, { now: (BASE + 10 * MIN) * 1000 });
    expect(incidents).toHaveLength(2);
    const onPve1 = incidents.find((i) => i.node === 'pve1')!;
    const onPve2 = incidents.find((i) => i.node === 'pve2')!;
    expect(onPve1.state).toBe('soft');
    expect(onPve2.state).toBe('healed');
  });

  it('sets runningUpid for a retry currently in progress', () => {
    const runningTask = running('pve1', '170', BASE + 10 * MIN);
    const tasks = [failed('pve1', '170', BASE), runningTask];
    const incidents = computeBackupIncidents(tasks, { now: (BASE + 12 * MIN) * 1000 });
    expect(incidents).toHaveLength(1);
    expect(incidents[0]).toMatchObject({ state: 'soft', runningUpid: runningTask.upid });
    expect(incidents[0]!.healedAt).toBeUndefined();
  });

  it('parses the VMID from the UPID when the task has no id', () => {
    const failTask: TaskLike = {
      upid: 'UPID:pve1:00000001:00000000:00000000:vzdump:113:msp360@pve:',
      node: 'pve1',
      type: 'vzdump',
      id: '',
      user: 'msp360@pve',
      starttime: BASE,
      endtime: BASE + 60,
      status: 'ERROR: job errors',
    };
    const incidents = computeBackupIncidents([failTask], { now: (BASE + HOUR) * 1000 });
    expect(incidents).toHaveLength(1);
    expect(incidents[0]!.vmid).toBe('113');
  });

  it('includes a failure exactly at the look-back boundary', () => {
    const now = (BASE + 100) * 1000;
    const boundaryStart = (now - DEFAULT_LOOKBACK_MS) / 1000;
    const tasks = [failed('pve1', '180', boundaryStart)];
    const incidents = computeBackupIncidents(tasks, { now });
    expect(incidents).toHaveLength(1);
  });

  it('excludes a failure one second older than the look-back window', () => {
    const now = (BASE + 100) * 1000;
    const justOutside = (now - DEFAULT_LOOKBACK_MS) / 1000 - 1;
    const tasks = [failed('pve1', '181', justOutside)];
    const incidents = computeBackupIncidents(tasks, { now });
    expect(incidents).toHaveLength(0);
  });

  it('respects a custom healWindowMs/hardAttempts', () => {
    const tasks = [failed('pve1', '190', BASE), failed('pve1', '190', BASE + MIN)];
    const incidents = computeBackupIncidents(tasks, {
      now: (BASE + 2 * MIN) * 1000,
      healWindowMs: DEFAULT_HEAL_WINDOW_MS,
      hardAttempts: 2,
    });
    expect(incidents[0]).toMatchObject({ state: 'hard' });
  });

  it('returns incidents in deterministic (node, vmid, firstFailedAt) order regardless of input order', () => {
    const tasks = [
      failed('pve2', '100', BASE),
      failed('pve1', '200', BASE),
      failed('pve1', '100', BASE),
    ];
    const now = (BASE + HOUR) * 1000;
    const forward = computeBackupIncidents(tasks, { now });
    const shuffled = computeBackupIncidents([...tasks].reverse(), { now });
    const key = (list: typeof forward) => list.map((i) => `${i.node}:${i.vmid}`);
    expect(key(forward)).toEqual(['pve1:100', 'pve1:200', 'pve2:100']);
    expect(key(shuffled)).toEqual(key(forward));
  });
});
