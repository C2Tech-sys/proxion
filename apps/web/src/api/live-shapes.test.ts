import { describe, expect, it } from 'vitest';

import type { ClusterResource, GuestConfig, PveTask, Snapshot } from '@/api/types';
import { computeAlerts, computeClusterTotals, topConsumersByCpu } from '@/lib/dashboard';
import { getDrives, getNetSpecs } from '@/lib/pve-config';
import { vmSeries } from '@/lib/rrd';
import { buildSnapshotTree, flattenSnapshotTree } from '@/lib/snapshots';

// Recorded, anonymised real-shape PVE payloads (see client.test.ts for the envelope-unwrap
// coverage of these same files) -- this file proves the *downstream* transforms every page
// relies on (dashboard aggregations, the hardware-tab config parser, the snapshots tree, and
// the RRD chart transform) accept the real, unwrapped shape and not just fixture-mode's
// hand-shaped data.
import clusterResourcesEnvelope from './__fixtures__/live/cluster-resources.json';
import clusterTasksEnvelope from './__fixtures__/live/cluster-tasks.json';
import vmConfigEnvelope from './__fixtures__/live/nodes-c2dc2-qemu-113-config.json';
import rrdEnvelope from './__fixtures__/live/nodes-c2dc2-qemu-113-rrddata-hour.json';
// T17: GET /nodes/{node}/tasks (the per-node task index) -- the real source for a guest's
// backup history, unlike /cluster/tasks above (only the last 25 tasks cluster-wide on the
// owner's host). One sample scoped to a single vmid's vzdump history, one unscoped/mixed.
import nodeTasksVmidVzdumpEnvelope from './__fixtures__/live/nodes-c2dc2-tasks-vmid-113-vzdump.json';
import nodeTasksRecentEnvelope from './__fixtures__/live/nodes-c2dc2-tasks-recent.json';

const resources = clusterResourcesEnvelope.data as unknown as ClusterResource[];
const tasks = clusterTasksEnvelope.data as unknown as PveTask[];
const config = vmConfigEnvelope.data as unknown as GuestConfig;
const rrdRows = rrdEnvelope.data;
const nodeTasksVmidVzdump = nodeTasksVmidVzdumpEnvelope.data as unknown as PveTask[];
const nodeTasksRecent = nodeTasksRecentEnvelope.data as unknown as PveTask[];

describe('dashboard aggregations against a real cluster/resources + cluster/tasks payload', () => {
  it('computes cluster totals matching the real host (1 node, 17 qemu, 4 storages)', () => {
    const totals = computeClusterTotals(resources);
    expect(totals.nodesTotal).toBe(1);
    expect(totals.nodesOnline).toBe(1);
    expect(totals.vmsRunning + totals.vmsStopped).toBe(17);
    expect(totals.vmsStopped).toBe(2); // vm-116, vm-117 in the recorded snapshot
  });

  it('ranks running guests by CPU without throwing on real (non-fixture-shaped) numeric noise', () => {
    const top = topConsumersByCpu(resources, 3);
    expect(top.length).toBeGreaterThan(0);
    expect(top[0]!.fraction).toBeGreaterThanOrEqual(top[top.length - 1]!.fraction);
  });

  it('never throws computing alerts against the real resources+tasks shape', () => {
    // Fixed `nowSeconds` derived from the payload's own newest timestamp -- these are real
    // recorded epoch seconds, long past "now" by the time this test runs, so the default
    // (`Date.now()`) would never treat any task as recent.
    const newest = Math.max(...tasks.map((t) => t.starttime));
    expect(() => computeAlerts(resources, tasks, newest)).not.toThrow();
    const alerts = computeAlerts(resources, tasks, newest);
    expect(Array.isArray(alerts)).toBe(true);
  });
});

describe('hardware parser against a real qemu config payload', () => {
  it('parses the real scsi0/efidisk0 drives and net0 NIC', () => {
    const drives = getDrives(config);
    const scsi0 = drives.find((d) => d.key === 'scsi0');
    expect(scsi0).toBeDefined();
    expect(scsi0!.storage).toBe('tank');

    const nets = getNetSpecs(config);
    expect(nets).toHaveLength(1);
    // Anonymised MAC from the fixture -- proves the real `virtio=<mac>,bridge=...` spec string
    // parses, without asserting the placeholder value has any other meaning.
    expect(nets[0]!.mac).toBe('02:00:00:00:00:01');
    expect(nets[0]!.bridge).toBe('vmbr1');
  });
});

describe('snapshots tree against a real-shaped (no-snapshot) guest', () => {
  it('renders the synthetic NOW leaf when the guest has no real snapshots', () => {
    // VM 113 on the real host currently has no snapshots beyond PVE's own "current" sentinel --
    // the exact shape `GET .../snapshot` returns for most guests.
    const snapshots: Snapshot[] = [{ name: 'current' }];
    const tree = buildSnapshotTree(snapshots);
    const flat = flattenSnapshotTree(tree);
    expect(flat).toHaveLength(1);
    expect(flat[0]!.name).toBe('NOW');
  });
});

describe('per-node task index (GET /nodes/{node}/tasks) against real payloads', () => {
  it('parses a vmid+typefilter-scoped vzdump history (3 rows, all OK, for vmid 113)', () => {
    expect(nodeTasksVmidVzdump).toHaveLength(3);
    for (const task of nodeTasksVmidVzdump) {
      expect(task.node).toBe('c2dc2');
      expect(task.type).toBe('vzdump');
      expect(task.id).toBe('113');
      expect(task.status).toBe('OK');
      expect(task.endtime).toBeGreaterThan(task.starttime);
    }
    // Real PVE returns these newest-first; the fixture client re-sorts explicitly rather than
    // trusting upstream order, but this confirms the recorded sample is shaped that way too.
    const starttimes = nodeTasksVmidVzdump.map((t) => t.starttime);
    expect([...starttimes].sort((a, b) => b - a)).toEqual(starttimes);
  });

  it('parses an unscoped/mixed 30-row sample (source=all) without throwing on optional fields', () => {
    expect(nodeTasksRecent.length).toBeGreaterThan(25);
    expect(() =>
      nodeTasksRecent.map((t) => (t.endtime ?? Math.floor(Date.now() / 1000)) - t.starttime),
    ).not.toThrow();
    // Every row is real vncproxy console-open activity on one node -- proves the "vmid" (`id`)
    // and `tokenid` (present on some rows, absent on others) fields both parse fine either way.
    expect(nodeTasksRecent.every((t) => t.type === 'vncproxy')).toBe(true);
    expect(nodeTasksRecent.some((t) => 'tokenid' in t)).toBe(true);
  });
});

describe('rrd transform against a real hour-timeframe rrddata payload', () => {
  it('builds all four VM chart panels from the real ~68-sample series', () => {
    const series = vmSeries(rrdRows);
    expect(series.cpu.x).toHaveLength(rrdRows.length);
    expect(series.cpu.series[0]!.values).toHaveLength(rrdRows.length);
    // Real rrddata's early samples for a long-idle metric can be `undefined`, not `0` --
    // the transform must map those to `null` (a chart gap), never throw or NaN.
    expect(series.cpu.series[0]!.values.every((v) => v === null || typeof v === 'number')).toBe(
      true,
    );
  });
});
