import { describe, expect, it } from 'vitest';

import { computeAlerts, computeClusterTotals, recentTasks, topConsumersByCpu, topConsumersByMemory } from '@/lib/dashboard';
import type { ClusterResource, PveTask } from '@/api/types';

function guest(overrides: Partial<ClusterResource> & { id: string; type: 'qemu' | 'lxc'; vmid: number }): ClusterResource {
  return {
    node: 'pve1',
    status: 'running',
    template: 0,
    ...overrides,
  } as ClusterResource;
}

function storage(overrides: Partial<ClusterResource> & { id: string }): ClusterResource {
  return {
    type: 'storage',
    node: 'pve1',
    status: 'available',
    storage: 'tank',
    plugintype: 'zfspool',
    content: 'images',
    ...overrides,
  } as ClusterResource;
}

// `type: 'qmstart'` (not `vzdump`): the `computeAlerts` describe block below exercises the
// generic "any task that failed" path -- `vzdump` tasks are handled separately, by
// `@proxion/core`'s backup-incident rule (see `packages/core/test/alerts.test.ts`).
function task(overrides: Partial<PveTask> & { upid: string }): PveTask {
  return {
    node: 'pve1',
    pid: 1,
    pstart: 1,
    type: 'qmstart',
    id: '100',
    user: 'root@pam',
    starttime: 1000,
    ...overrides,
  } as PveTask;
}

describe('computeClusterTotals', () => {
  it('tallies nodes/guests/storage across resource types', () => {
    const totals = computeClusterTotals([
      { id: 'node/pve1', type: 'node', node: 'pve1', status: 'online' } as ClusterResource,
      guest({ id: 'qemu/100', type: 'qemu', vmid: 100, status: 'running' }),
      guest({ id: 'qemu/101', type: 'qemu', vmid: 101, status: 'stopped' }),
      guest({ id: 'lxc/200', type: 'lxc', vmid: 200, status: 'running' }),
      storage({ id: 'storage/pve1/tank', disk: 50, maxdisk: 100 }),
    ]);
    expect(totals).toMatchObject({
      nodesOnline: 1,
      nodesTotal: 1,
      vmsRunning: 1,
      vmsStopped: 1,
      ctsRunning: 1,
      ctsStopped: 0,
      storageUsed: 50,
      storageTotal: 100,
    });
  });
});

describe('topConsumersByCpu / topConsumersByMemory', () => {
  const resources: ClusterResource[] = [
    guest({ id: 'qemu/100', type: 'qemu', vmid: 100, name: 'a', cpu: 0.1, mem: 10, maxmem: 100 }),
    guest({ id: 'qemu/101', type: 'qemu', vmid: 101, name: 'b', cpu: 0.9, mem: 80, maxmem: 100 }),
    guest({ id: 'lxc/200', type: 'lxc', vmid: 200, name: 'c', cpu: 0.5, mem: 90, maxmem: 100 }),
    guest({ id: 'qemu/102', type: 'qemu', vmid: 102, name: 'stopped', status: 'stopped', cpu: 0.99, mem: 99, maxmem: 100 }),
    guest({ id: 'qemu/103', type: 'qemu', vmid: 103, name: 'template', template: 1, cpu: 0.99, mem: 99, maxmem: 100 }),
  ];

  it('ranks running, non-template guests by CPU descending', () => {
    const top = topConsumersByCpu(resources, 2);
    expect(top.map((r) => r.id)).toEqual(['qemu/101', 'lxc/200']);
  });

  it('ranks running, non-template guests by memory fraction descending', () => {
    const top = topConsumersByMemory(resources, 2);
    expect(top.map((r) => r.id)).toEqual(['lxc/200', 'qemu/101']);
  });

  it('excludes stopped guests and templates', () => {
    const top = topConsumersByCpu(resources, 10);
    expect(top.map((r) => r.id)).not.toContain('qemu/102');
    expect(top.map((r) => r.id)).not.toContain('qemu/103');
  });
});

describe('computeAlerts', () => {
  const now = 100_000;

  it('flags a task that failed within the last 24h', () => {
    const alerts = computeAlerts(
      [],
      [task({ upid: 'UPID:1', status: 'some error', starttime: now - 3600 })],
      now,
    );
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({ severity: 'error', id: 'UPID:1' });
  });

  it('ignores a failed task older than 24h', () => {
    const alerts = computeAlerts([], [task({ upid: 'UPID:1', status: 'error', starttime: now - 90_000 })], now);
    expect(alerts).toHaveLength(0);
  });

  it('ignores a running or OK task', () => {
    const alerts = computeAlerts(
      [],
      [
        task({ upid: 'UPID:1', status: 'running', starttime: now - 10 }),
        task({ upid: 'UPID:2', status: 'OK', starttime: now - 10 }),
      ],
      now,
    );
    expect(alerts).toHaveLength(0);
  });

  it('flags storage over 85% full', () => {
    const alerts = computeAlerts(
      [storage({ id: 'storage/pve1/tank', storage: 'tank', disk: 90, maxdisk: 100 })],
      [],
      now,
    );
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({ severity: 'warning' });
  });

  it('does not flag storage at or below 85% full', () => {
    const alerts = computeAlerts(
      [storage({ id: 'storage/pve1/tank', storage: 'tank', disk: 85, maxdisk: 100 })],
      [],
      now,
    );
    expect(alerts).toHaveLength(0);
  });

  it('returns [] when nothing is wrong', () => {
    expect(computeAlerts([], [], now)).toEqual([]);
  });

  it('delegates vzdump tasks to the backup-incident rule (soft, not the generic task-failure alert)', () => {
    const alerts = computeAlerts(
      [],
      [task({ upid: 'UPID:vz1', type: 'vzdump', status: 'ERROR: job errors', starttime: now - 60 })],
      now,
    );
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({ kind: 'backup', severity: 'warning' });
  });
});

describe('recentTasks', () => {
  it('returns the newest `limit` tasks, newest first', () => {
    const tasks = [
      task({ upid: 'a', starttime: 1 }),
      task({ upid: 'b', starttime: 3 }),
      task({ upid: 'c', starttime: 2 }),
    ];
    expect(recentTasks(tasks, 2).map((t) => t.upid)).toEqual(['b', 'c']);
  });
});
