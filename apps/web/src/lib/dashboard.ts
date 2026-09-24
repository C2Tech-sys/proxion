import { computeAlerts as computeAlertsCore, type Alert } from '@proxion/core';
import type { ClusterResource, ClusterTotals, GuestType, PveTask } from '@/api/types';

/** Reduces a flat /cluster/resources list into the totals the Dashboard header cards show. */
export function computeClusterTotals(resources: ClusterResource[]): ClusterTotals {
  const totals: ClusterTotals = {
    nodesOnline: 0,
    nodesTotal: 0,
    vmsRunning: 0,
    vmsStopped: 0,
    ctsRunning: 0,
    ctsStopped: 0,
    storageUsed: 0,
    storageTotal: 0,
  };

  for (const r of resources) {
    if (r.type === 'node') {
      totals.nodesTotal += 1;
      if (r.status === 'online') totals.nodesOnline += 1;
    } else if (r.type === 'qemu') {
      if (r.status === 'running') totals.vmsRunning += 1;
      else totals.vmsStopped += 1;
    } else if (r.type === 'lxc') {
      if (r.status === 'running') totals.ctsRunning += 1;
      else totals.ctsStopped += 1;
    } else if (r.type === 'storage') {
      totals.storageUsed += r.disk ?? 0;
      totals.storageTotal += r.maxdisk ?? 0;
    }
  }

  return totals;
}

export interface ConsumerRow {
  id: string;
  name: string;
  node: string;
  type: GuestType;
  vmid: number;
  /** 0..1 fraction: CPU utilisation or `mem / maxmem`, depending on which list this came from. */
  fraction: number;
}

function isRunningGuest(r: ClusterResource): r is ClusterResource & { type: 'qemu' | 'lxc'; vmid: number } {
  return (r.type === 'qemu' || r.type === 'lxc') && r.status === 'running' && r.template !== 1;
}

/** The top `limit` running guests by CPU utilisation, across all nodes. */
export function topConsumersByCpu(resources: ClusterResource[], limit = 5): ConsumerRow[] {
  return resources
    .filter(isRunningGuest)
    .map((r) => ({
      id: r.id,
      name: r.name ?? `${r.type}/${r.vmid}`,
      node: r.node,
      type: r.type,
      vmid: r.vmid,
      fraction: r.cpu ?? 0,
    }))
    .sort((a, b) => b.fraction - a.fraction)
    .slice(0, limit);
}

/** The top `limit` running guests by memory utilisation (`mem / maxmem`), across all nodes. */
export function topConsumersByMemory(resources: ClusterResource[], limit = 5): ConsumerRow[] {
  return resources
    .filter(isRunningGuest)
    .map((r) => ({
      id: r.id,
      name: r.name ?? `${r.type}/${r.vmid}`,
      node: r.node,
      type: r.type,
      vmid: r.vmid,
      fraction: r.maxmem ? (r.mem ?? 0) / r.maxmem : 0,
    }))
    .sort((a, b) => b.fraction - a.fraction)
    .slice(0, limit);
}

/** @deprecated Kept as an alias of `@proxion/core`'s `Alert` for any existing importers of the
 * name; the alerts strip's contents are now computed there (see that package's `computeAlerts`
 * and its doc comment for the backup-incident rule), not duplicated here. */
export type DashboardAlert = Alert;

/**
 * Thin adapter over `@proxion/core`'s `computeAlerts`: this module used to duplicate the whole
 * computation (task-failure + storage-full alerts only, no backup-incident healing); that logic
 * now lives in the dependency-free package so the server's poller can share it. `nowSeconds` is
 * kept as a positional, seconds-based argument (rather than the package's `now`-in-milliseconds,
 * options-object shape) purely for this function's own existing callers.
 */
export function computeAlerts(
  resources: ClusterResource[],
  tasks: PveTask[],
  nowSeconds: number = Date.now() / 1000,
): Alert[] {
  return computeAlertsCore({ resources, tasks, now: nowSeconds * 1000 });
}

/** The `limit` most recently started tasks, newest first. */
export function recentTasks(tasks: PveTask[], limit = 8): PveTask[] {
  return [...tasks].sort((a, b) => b.starttime - a.starttime).slice(0, limit);
}
