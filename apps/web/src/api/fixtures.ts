import resourcesFixture from '@/fixtures/resources.json';
import tasksFixture from '@/fixtures/tasks.json';
import configsFixture from '@/fixtures/configs.json';
import agentInterfacesFixture from '@/fixtures/agent-interfaces.json';
import rrdFixture from '@/fixtures/rrd.json';
import nodeStatusFixture from '@/fixtures/node-status.json';
import nodeNetworkFixture from '@/fixtures/node-network.json';
import nodeServicesFixture from '@/fixtures/node-services.json';
import storageContentFixture from '@/fixtures/storage-content.json';
import taskLogsFixture from '@/fixtures/task-logs.json';
import snapshotsFixture from '@/fixtures/snapshots.json';
import type {
  AgentInterfacesResult,
  ClusterResource,
  GuestConfig,
  GuestType,
  NodeNetworkInterface,
  NodeService,
  NodeStatusCurrent,
  PveTask,
  RrdPoint,
  RrdTimeframe,
  Snapshot,
  StorageContentItem,
  TaskLogLine,
} from '@/api/types';
import type { MigratePrecheck } from '@/api/actions';
import { computeAlerts } from '@proxion/core';
import type { ApiClient, NodeTaskParams, ThumbnailCacheEntry } from '@/api/client-types';
import { NotFoundError } from '@/api/errors';
import { RRD_STEP_SECONDS, rebaseRrdTimestamps } from '@/lib/rrd';
import { taskStatusState } from '@/lib/status';
import { generateThumbnailPlaceholder } from '@/fixtures/thumbnails';

const resources = resourcesFixture as ClusterResource[];
const tasks = tasksFixture as PveTask[];
const configs = configsFixture as Record<string, GuestConfig>;
const agentInterfaces = agentInterfacesFixture as Record<string, AgentInterfacesResult>;
const nodeStatuses = nodeStatusFixture as Record<string, NodeStatusCurrent>;
const nodeNetworks = nodeNetworkFixture as Record<string, NodeNetworkInterface[]>;
const nodeServices = nodeServicesFixture as Record<string, NodeService[]>;
const storageContent = storageContentFixture as Record<string, StorageContentItem[]>;
const taskLogs = taskLogsFixture as Record<string, TaskLogLine[]>;
const snapshots = snapshotsFixture as Record<string, Snapshot[]>;

/**
 * The checked-in RRD fixture's `time` values are whatever was current when it was generated,
 * not real "now minus N steps" timestamps -- so every series is rebased once, on first use:
 * same point count and gaps, walked back from "now" by that timeframe's real PVE step (see
 * `RRD_STEP_SECONDS`), so the demo always reads as live and every chart's x-axis gets the
 * uniform spacing real rrddata has.
 *
 * This is computed lazily (memoized on first call) rather than at module top level so that a
 * production build with fixtures compiled out (`VITE_USE_FIXTURES` statically false) can still
 * tree-shake the ~2MB `rrd.json` fixture entirely: a plain top-level function call is opaque to
 * the bundler's dead-code elimination even when nothing reachable ever calls it, whereas a
 * function body that's never invoked (because every caller lives inside the also-dead
 * `fixtureClient`) drops out cleanly along with its otherwise-unused `rrdFixture` import.
 */
let rebasedRrd: Record<string, Record<RrdTimeframe, RrdPoint[]>> | null = null;

function getRebasedRrd(): Record<string, Record<RrdTimeframe, RrdPoint[]>> {
  if (rebasedRrd) return rebasedRrd;
  const now = Math.floor(Date.now() / 1000);
  const raw = rrdFixture as Record<string, Record<string, RrdPoint[]>>;
  const rebased: Record<string, Record<string, RrdPoint[]>> = {};
  for (const [entity, series] of Object.entries(raw)) {
    const rebasedSeries: Record<string, RrdPoint[]> = {};
    for (const [timeframe, rows] of Object.entries(series)) {
      const step = RRD_STEP_SECONDS[timeframe as keyof typeof RRD_STEP_SECONDS] ?? RRD_STEP_SECONDS.hour;
      rebasedSeries[timeframe] = rebaseRrdTimestamps(rows, step, now);
    }
    rebased[entity] = rebasedSeries;
  }
  rebasedRrd = rebased as Record<string, Record<RrdTimeframe, RrdPoint[]>>;
  return rebasedRrd;
}

/**
 * The checked-in tasks fixture's timestamps are relative to whenever it was captured, same
 * problem as the RRD fixture above: real wall-clock time keeps moving further past them, and
 * `computeAlerts`'s error-task alert only looks back 24h -- so the fixture's one ERROR task
 * (`qmstart:105`) would eventually, silently, stop showing on the dashboard. Rebased once, on
 * first use, by a single constant offset that lands the newest task a few minutes ago: every
 * task's relative spacing and duration (`endtime - starttime`) stays exactly what it was.
 */
let rebasedTasks: PveTask[] | null = null;

/** How long ago the most recent fixture task reads as, after rebasing. */
const NEWEST_TASK_AGE_SECONDS = 5 * 60;

function getRebasedTasks(): PveTask[] {
  if (rebasedTasks) return rebasedTasks;
  const now = Math.floor(Date.now() / 1000);
  const newestStart = Math.max(...tasks.map((t) => t.starttime));
  const offset = now - NEWEST_TASK_AGE_SECONDS - newestStart;
  const next: PveTask[] = tasks.map((t) => {
    // Spread `endtime` in only when the source task has one -- with `exactOptionalPropertyTypes`,
    // assigning `undefined` to it explicitly is a different (disallowed) thing than omitting it.
    const { endtime, ...rest } = t;
    return {
      ...rest,
      starttime: t.starttime + offset,
      ...(endtime !== undefined ? { endtime: endtime + offset } : {}),
    };
  });
  rebasedTasks = next;
  return next;
}

/**
 * Real PVE's `/cluster/tasks` (what `getTasks()`/`useTasks()` model) only ever holds a short,
 * cluster-wide recent-task window (the owner's host: the last 25 tasks total) -- it is NOT a
 * per-guest history, which is the whole reason the VM Summary "Last backup" panel and the node/
 * VM Tasks tabs need `getNodeTasks()` (GET /nodes/{node}/tasks) instead (see T17). The fixture
 * tasks.json was extended with real per-guest nightly-backup history for that new endpoint's
 * fixture path -- capping `getTasks()`'s own output to the newest 25 here keeps the Recent Tasks
 * drawer (and the dashboard's alerts, and the standalone /tasks page) reading the way the real
 * short cluster list does, instead of flooding them with that history.
 */
const CLUSTER_RECENT_TASKS_LIMIT = 25;

/**
 * T23's backup-incident demo data (VMIDs 300-305 in `tasks.json`/`resources.json`) mostly sits
 * well outside this newest-25 window on purpose (a `hard`/error or still-open `soft`/warning
 * incident needs no recency to stay visible -- see `@proxion/core`'s `computeAlerts`). The two
 * exceptions are VMID 300 (healed) and VMID 305 (a running retry): a *currently visible* healed
 * incident's `OK`, or a still-`running` retry, is by construction a recent event, so those two
 * unavoidably land inside this newest-25 window too (displacing a handful of older rows from the
 * Recent Tasks drawer) -- the alternative was no visible `healed`/running-retry example at all.
 */

/** Default page size PVE's own `/nodes/{node}/tasks` applies when `limit` is omitted. */
const NODE_TASKS_DEFAULT_LIMIT = 50;

/** Small deterministic-ish jitter so gauges visibly move between fixture refetches. */
function jitter(value: number, spread: number): number {
  return Math.max(0, value + (Math.random() - 0.5) * 2 * spread);
}

function withJitter(items: ClusterResource[]): ClusterResource[] {
  return items.map((item) => {
    if (item.type !== 'qemu' && item.type !== 'lxc') return item;
    if (item.status !== 'running') return item;
    const cpu = typeof item.cpu === 'number' ? jitter(item.cpu, 0.03) : item.cpu;
    const mem =
      typeof item.mem === 'number' && typeof item.maxmem === 'number'
        ? Math.min(item.maxmem, jitter(item.mem, item.maxmem * 0.01))
        : item.mem;
    return { ...item, cpu, mem };
  });
}

/** Simulated network latency so loading skeletons are visible in fixture mode. */
const FIXTURE_DELAY_MS = 250;

function delay<T>(value: T): Promise<T> {
  return new Promise((resolve) => setTimeout(() => resolve(value), FIXTURE_DELAY_MS));
}

export const fixtureClient: ApiClient = {
  async getClusterResources() {
    return delay(withJitter(resources));
  },
  async getTasks() {
    const sorted = [...getRebasedTasks()].sort((a, b) => b.starttime - a.starttime);
    return delay(sorted.slice(0, CLUSTER_RECENT_TASKS_LIMIT));
  },
  // Computed from the FULL rebased task history (not `getTasks()`'s newest-25-only cluster
  // list) -- same source `getNodeTasks()` reads, and the one the real server's poller uses
  // (each node's 24h vzdump history), so a failure well outside the recent-tasks drawer can
  // still open/heal a backup incident here exactly as it would live.
  async getAlerts() {
    return delay(computeAlerts({ resources, tasks: getRebasedTasks(), now: Date.now() }));
  },
  async getNodeTasks(node: string, params?: NodeTaskParams) {
    const { vmid, typefilter, since, until, errors, source, start, limit } = params ?? {};

    let rows = getRebasedTasks().filter((t) => t.node === node);
    if (vmid !== undefined) rows = rows.filter((t) => t.id === String(vmid));
    if (typefilter !== undefined) rows = rows.filter((t) => t.type === typefilter);
    if (since !== undefined) rows = rows.filter((t) => t.starttime >= since);
    if (until !== undefined) rows = rows.filter((t) => t.starttime <= until);
    if (errors) rows = rows.filter((t) => taskStatusState(t.status) === 'error');
    // `source`: 'active' = still running (no endtime yet), 'archive' = finished, 'all'/omitted =
    // both -- mirrors PVE's own distinction between its in-memory active-task list and its
    // on-disk task-log archive, which per-node fixture data doesn't otherwise model.
    if (source === 'active') rows = rows.filter((t) => t.endtime === undefined);
    if (source === 'archive') rows = rows.filter((t) => t.endtime !== undefined);

    rows = [...rows].sort((a, b) => b.starttime - a.starttime);
    const startIndex = start ?? 0;
    const pageSize = limit ?? NODE_TASKS_DEFAULT_LIMIT;
    return delay(rows.slice(startIndex, startIndex + pageSize));
  },
  async getNodeStatus(node) {
    const status = nodeStatuses[node];
    if (!status) throw new NotFoundError(`Node "${node}" was not found.`);
    return delay(status);
  },
  async getVmStatus(node, type, vmid) {
    const resource = resources.find(
      (r) => r.node === node && r.type === type && r.vmid === vmid,
    );
    if (!resource) {
      throw new NotFoundError(`${type === 'lxc' ? 'Container' : 'VM'} ${vmid} was not found on "${node}".`);
    }
    const [jittered] = withJitter([resource]);
    return delay(jittered!);
  },
  async getVmConfig(node, type, vmid) {
    const config = configs[String(vmid)];
    if (!config) {
      throw new NotFoundError(`${type === 'lxc' ? 'Container' : 'VM'} ${vmid} was not found on "${node}".`);
    }
    return delay(config);
  },
  async getAgentInterfaces(_node, _type, vmid) {
    const result = agentInterfaces[String(vmid)];
    if (!result) throw new Error(`No agent data for vmid ${vmid} (guest agent not running)`);
    return delay(result);
  },
  async getRrd(_node, type, vmid, timeframe) {
    const series = getRebasedRrd()[`${type}-${vmid}`];
    if (!series) throw new Error(`No fixture rrd data for ${type}/${vmid}`);
    return delay(series[timeframe] ?? []);
  },
  async getNodeRrd(node, timeframe) {
    const series = getRebasedRrd()[`node-${node}`];
    if (!series) throw new Error(`No fixture rrd data for node ${node}`);
    return delay(series[timeframe] ?? []);
  },
  async getNodeNetwork(node) {
    const ifaces = nodeNetworks[node];
    if (!ifaces) throw new NotFoundError(`Node "${node}" was not found.`);
    return delay(ifaces);
  },
  async getNodeServices(node) {
    const services = nodeServices[node];
    if (!services) throw new NotFoundError(`Node "${node}" was not found.`);
    return delay(services);
  },
  async getStorageContent(node, storage) {
    return delay(storageContent[`${node}/${storage}`] ?? []);
  },
  async getTaskLog(_node, upid) {
    return delay(taskLogs[upid] ?? []);
  },
  async getSnapshots(_node, type, vmid) {
    return delay(snapshots[`${type}-${vmid}`] ?? []);
  },
  async login() {
    throw new Error('BACKEND_NOT_CONNECTED');
  },
  async getAuthMe() {
    // The demo has no real backend to authenticate against -- always "signed in" as a synthetic
    // token identity, so the auth gate (see routes/_shell.tsx) never redirects the fixture demo
    // to /login, matching the demo's long-standing "just works, no login" behavior.
    return delay({
      username: 'demo@pve!fixtures',
      realm: 'token',
      capabilities: {},
      mode: 'token',
    });
  },
  async logout() {
    throw new Error('BACKEND_NOT_CONNECTED');
  },
  console: {
    async vnc() {
      throw new Error('BACKEND_NOT_CONNECTED');
    },
    async term() {
      throw new Error('BACKEND_NOT_CONNECTED');
    },
  },
  thumbnails: {
    url(node, type, vmid) {
      const resource = resources.find(
        (r) => r.node === node && r.type === type && r.vmid === vmid,
      );
      const config = configs[String(vmid)];
      return generateThumbnailPlaceholder({
        vmid,
        name: config?.name ?? config?.hostname ?? resource?.name,
        ostype: config?.ostype,
        status: resource?.status ?? 'stopped',
        template: resource?.template === 1,
      });
    },
    async status() {
      const now = Date.now();
      const cached: ThumbnailCacheEntry[] = resources
        .filter(
          (r): r is ClusterResource & { type: 'qemu' | 'lxc'; vmid: number } =>
            (r.type === 'qemu' || r.type === 'lxc') && r.status === 'running' && r.template !== 1,
        )
        .map((r) => ({
          node: r.node,
          type: r.type,
          vmid: r.vmid,
          // Deterministic-ish freshness spread (0-45s ago) so the fixture reads as "just captured".
          capturedAt: new Date(now - ((r.vmid * 7) % 45) * 1000).toISOString(),
        }));
      return delay({ inFlight: 0, cached });
    },
  },
};

/**
 * Test/demo-only mutator: flips one guest's `status` in the shared in-memory `resources` array
 * this module serves, in place. Used by the guest-actions fixture flow
 * (`src/api/actionsFixture.ts`) to simulate the effect of a power action (e.g. `start` ->
 * "running") without a real backend -- `resources` has no other exported way to be written to,
 * and every fixture read (`getClusterResources`, `getVmStatus`, the inventory tree, ...) reads
 * off this same array, so the change is visible everywhere immediately. A no-op if no resource
 * matches (kept lenient rather than throwing: the demo has no real consequence either way).
 */
export function setFixtureGuestStatus(node: string, type: GuestType, vmid: number, status: string): void {
  const index = resources.findIndex((r) => r.node === node && r.type === type && r.vmid === vmid);
  if (index === -1) return;
  resources[index] = { ...resources[index], status } as ClusterResource;
}

/**
 * Test/demo-only mutator: applies a rename and/or notes update to one guest's fixture config
 * (`configs[vmid]`, served by `getVmConfig`) AND, when `name` is given, the shared `resources`
 * array's own `name` field -- both in place. Used by the guest-config fixture flow
 * (`src/api/actionsFixture.ts`) to simulate `PATCH /api/actions/guest/.../config` without a real
 * backend, mirroring `setFixtureGuestStatus` above. The resource row's `name` needs its own write
 * because the inventory tree and dashboard read a guest's display name off `resources`, not off
 * `configs` -- only the Summary tab's Notes/Guest panels read `configs` directly -- so without
 * this a rename would update the VM page but leave the tree label and dashboard stale until a
 * full reload re-derived them (which fixture mode never does, since there's no real backend to
 * re-fetch from). qemu's field is `name`; lxc has no `name` config key, so the same rename is
 * written to `hostname` instead, matching the real PVE config shape. A no-op if no matching
 * guest exists (kept lenient rather than throwing, same as `setFixtureGuestStatus`).
 */
export function setFixtureGuestConfig(
  node: string,
  type: GuestType,
  vmid: number,
  patch: { name?: string; description?: string },
): void {
  const key = String(vmid);
  const config = configs[key];
  if (config) {
    configs[key] = {
      ...config,
      ...(patch.name !== undefined ? (type === 'lxc' ? { hostname: patch.name } : { name: patch.name }) : {}),
      ...(patch.description !== undefined ? { description: patch.description } : {}),
    };
  }

  if (patch.name !== undefined) {
    const index = resources.findIndex((r) => r.node === node && r.type === type && r.vmid === vmid);
    if (index !== -1) {
      resources[index] = { ...resources[index], name: patch.name } as ClusterResource;
    }
  }
}

/**
 * Test/demo-only mutator: the ONE way `src/api/actionsFixture.ts`'s `fixtureMigrateGuest` moves a
 * guest to its new node in the shared in-memory `resources` array, in place -- same convention as
 * `setFixtureGuestStatus`/`setFixtureGuestConfig` above. A no-op if no matching guest exists (kept
 * lenient, same as the other fixture mutators).
 */
export function setFixtureGuestNode(node: string, type: GuestType, vmid: number, target: string): void {
  const index = resources.findIndex((r) => r.node === node && r.type === type && r.vmid === vmid);
  if (index === -1) return;
  resources[index] = { ...resources[index], node: target } as ClusterResource;
}

/** Demo-only: which qemu guests' migrate precheck reports a local disk, purely synthetic (not
 * derived from any fixture json -- this app's fixture data has no per-guest storage/disk model)
 * so the "Migrate local disks" checkbox has something to show in the demo. `web-prod-01` (vmid
 * 100) is a running qemu guest, matching the ticket's "one running qemu guest" demo requirement. */
const FIXTURE_LOCAL_DISK_VMIDS = new Set([100]);

/**
 * Test/demo-only: `src/api/actionsFixture.ts`'s `fixtureMigratePrecheck` reads this for a
 * synthetic but demo-plausible migrate precheck -- computed from the shared in-memory `resources`
 * (running state, other-node eligibility) plus the synthetic `FIXTURE_LOCAL_DISK_VMIDS` above.
 * `target` only matters for whether it's excluded from its own `notAllowedNodes`/`allowedNodes`
 * split; every other node's eligibility is reported the same way real PVE's own precheck reports
 * the whole cluster's candidates in one call, target or no.
 */
export function getFixtureMigratePrecheck(
  node: string,
  type: GuestType,
  vmid: number,
  target: string,
): MigratePrecheck {
  const resource = resources.find((r) => r.node === node && r.type === type && r.vmid === vmid);
  const running = resource?.status === 'running';
  const hasLocalDisk = type === 'qemu' && FIXTURE_LOCAL_DISK_VMIDS.has(vmid);

  const otherNodes = resources.filter((r) => r.type === 'node' && r.node !== node);
  const allowedNodes: string[] = [];
  const notAllowedNodes: MigratePrecheck['notAllowedNodes'] = {};
  for (const n of otherNodes) {
    if (n.status === 'online') {
      allowedNodes.push(n.node);
    } else {
      notAllowedNodes[n.node] = { unavailableStorages: [], blockingHaResources: [] };
    }
  }
  // `target` itself is only ever offered as a choice when it was already online (see
  // `MigrateGuestDialog`'s own node picker) -- nothing extra to layer on for it here.
  void target;

  return {
    running,
    allowedNodes,
    notAllowedNodes,
    localDisks: hasLocalDisk
      ? [{ volid: `local-lvm:vm-${vmid}-disk-0`, size: 34_359_738_368, cdrom: false, isUnused: false }]
      : [],
    localResources: [],
  };
}

/** One snapshot create/delete/rollback, as `setFixtureSnapshots` applies it. Mirrors the three
 * server routes in `apps/server/src/actions/snapshotRoutes.ts`. */
export type SnapshotFixtureAction =
  | { op: 'create'; snapname: string; description?: string; vmstate?: boolean }
  | { op: 'delete'; snapname: string }
  | { op: 'rollback'; snapname: string };

/** `s` with its `parent` field set to `parent`, or removed entirely when `parent` is `undefined`
 * -- avoids ever assigning `parent: undefined` explicitly (this codebase's tsconfig has
 * `exactOptionalPropertyTypes`, which treats that as a different, disallowed thing from omitting
 * the key). */
function withParent(s: Snapshot, parent: string | undefined): Snapshot {
  const next: Snapshot = { ...s };
  if (parent === undefined) {
    delete next.parent;
  } else {
    next.parent = parent;
  }
  return next;
}

/**
 * Test/demo-only mutator: the ONE way `src/api/actionsFixture.ts`'s snapshot create/delete/
 * rollback simulate a write against the shared in-memory `snapshots` fixture (served by
 * `getSnapshots()`/`useSnapshots()`), in place -- same convention as `setFixtureGuestStatus`/
 * `setFixtureGuestConfig` above.
 *
 * The fixture tracks where the synthetic "current" (live-state) row sits via its own `parent`
 * field -- unused by `buildSnapshotTree` today (it drops `current` and attaches a "NOW" leaf
 * under every branch tip instead, see `lib/snapshots.ts`), but kept accurate here regardless, the
 * same way a real PVE snapshot tree would track it, in case a future consumer reads it directly:
 *
 * - `create`: the new snapshot becomes a child of wherever `current` was (PVE always snapshots
 *   from the live state), and `current` itself moves to sit under the new snapshot -- exactly
 *   what taking a snapshot does on a real guest.
 * - `delete`: the named snapshot is removed; anything that pointed at it as `parent` (including
 *   `current`, if it was there) is re-parented to the removed snapshot's own parent, so the chain
 *   never orphans.
 * - `rollback`: `current` moves to sit under the chosen snapshot -- matching real PVE, which
 *   doesn't otherwise touch the snapshot list on a rollback (every snapshot, before and after the
 *   rollback target, stays exactly where it was).
 *
 * A no-op if no matching guest exists (kept lenient, same as the other fixture mutators); a
 * `delete`/`rollback` naming a snapshot that doesn't exist is also a no-op.
 */
export function setFixtureSnapshots(
  node: string,
  type: GuestType,
  vmid: number,
  action: SnapshotFixtureAction,
): void {
  const key = `${type}-${vmid}`;
  const list = snapshots[key];
  if (!list) return;

  const currentIndex = list.findIndex((s) => s.name === 'current');
  const currentParent = currentIndex !== -1 ? list[currentIndex]!.parent : undefined;

  if (action.op === 'create') {
    const created: Snapshot = {
      name: action.snapname,
      snaptime: Math.floor(Date.now() / 1000),
      ...(action.description !== undefined ? { description: action.description } : {}),
      ...(currentParent !== undefined ? { parent: currentParent } : {}),
      ...(action.vmstate ? { vmstate: true } : {}),
    };
    const next = [...list, created];
    if (currentIndex !== -1) next[currentIndex] = withParent(next[currentIndex]!, action.snapname);
    snapshots[key] = next;
    return;
  }

  if (action.op === 'delete') {
    const targetIndex = list.findIndex((s) => s.name === action.snapname);
    if (targetIndex === -1) return;
    const targetParent = list[targetIndex]!.parent;
    snapshots[key] = list
      .filter((_, i) => i !== targetIndex)
      .map((s) => (s.parent === action.snapname ? withParent(s, targetParent) : s));
    return;
  }

  // action.op === 'rollback'
  if (currentIndex === -1) return;
  const next = [...list];
  next[currentIndex] = withParent(next[currentIndex]!, action.snapname);
  snapshots[key] = next;
}
