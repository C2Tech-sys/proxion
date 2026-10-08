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
import type { FirewallRule } from '@/api/firewall';
import { computeAlerts } from '@proxion/core';
import type { ApiClient, HealthResponse, NodeTaskParams, ThumbnailCacheEntry } from '@/api/client-types';
import { NotFoundError } from '@/api/errors';
import { RRD_STEP_SECONDS, rebaseRrdTimestamps } from '@/lib/rrd';
import { taskStatusState } from '@/lib/status';
import { generateThumbnailPlaceholder } from '@/fixtures/thumbnails';
import { APP_VERSION } from '@/version';

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
  // The demo has no real backend to fall behind -- always reports the bundle's OWN version, so
  // `useServerVersion()`'s comparison never disagrees with `__APP_VERSION__` and the
  // `UpdateAvailableBanner` never shows in fixture mode (see T38).
  async getHealth(): Promise<HealthResponse> {
    return delay({ ok: true, name: 'proxion', version: APP_VERSION });
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

/**
 * Test/demo-only mutator (T32): appends one item to the shared in-memory `storageContent` map's
 * `<node>/<storage>` array, in place, creating that array if this is its first item -- same
 * convention as the other fixture mutators above. Used by the storage-upload and
 * download-from-URL fixture flows (`src/api/actionsFixture.ts`) to simulate the new volume showing
 * up in `getStorageContent` without a real backend.
 */
export function addFixtureStorageContent(node: string, storage: string, item: StorageContentItem): void {
  const key = `${node}/${storage}`;
  (storageContent[key] ??= []).push(item);
}

/**
 * Test/demo-only mutator (T32 addendum): removes one item (by `volid`) from the shared in-memory
 * `storageContent` map's `<node>/<storage>` array, in place -- the delete counterpart to
 * `addFixtureStorageContent` above. A no-op if no matching storage/volid exists (kept lenient,
 * same as the other fixture mutators).
 */
export function removeFixtureStorageContent(node: string, storage: string, volid: string): void {
  const key = `${node}/${storage}`;
  const items = storageContent[key];
  if (!items) return;
  const index = items.findIndex((item) => item.volid === volid);
  if (index !== -1) items.splice(index, 1);
}

/**
 * Test/demo-only lookup: the one guest (qemu or lxc) at `vmid` in the shared in-memory `resources`
 * array, or `undefined` if none exists -- used by `actionsFixture.ts`'s `fixtureRestoreGuest` to
 * tell an in-place restore (the target vmid already exists) from a restore-to-a-new-id.
 */
export function getFixtureGuestByVmid(vmid: number): ClusterResource | undefined {
  return resources.find((r) => (r.type === 'qemu' || r.type === 'lxc') && r.vmid === vmid);
}

/**
 * Test/demo-only mutator: appends one new guest row to the shared in-memory `resources` array, in
 * place -- same convention as the other fixture mutators above. Used by `actionsFixture.ts`'s
 * `fixtureRestoreGuest` to simulate a restore-to-a-new-id creating a brand new guest, since (unlike
 * every other fixture mutator here) there is no existing row to update.
 */
export function addFixtureGuest(resource: ClusterResource): void {
  resources.push(resource);
}

/**
 * Test/demo-only mutator: removes one guest from the shared in-memory `resources` array, in place,
 * along with its per-vmid `configs` entry and its `snapshots` tree (`<type>-<vmid>`) -- the
 * inverse of `addFixtureGuest`, used by `actionsFixture.ts`'s `fixtureDestroyGuest`. A no-op if no
 * matching guest exists.
 */
export function removeFixtureGuest(node: string, type: GuestType, vmid: number): void {
  const index = resources.findIndex((r) => r.node === node && r.type === type && r.vmid === vmid);
  if (index === -1) return;
  resources.splice(index, 1);
  delete configs[String(vmid)];
  delete snapshots[`${type}-${vmid}`];
}

/**
 * Test/demo-only: one past the highest vmid currently in the shared in-memory `resources` array
 * (any resource type, matching real PVE's own `GET /cluster/nextid`, which considers every id in
 * the cluster) -- used by `actionsFixture.ts`'s `fixtureRestoreNextId` for the restore dialog's
 * "Use next free ID" button.
 */
export function getFixtureNextId(): number {
  const highest = resources.reduce((max, r) => (typeof r.vmid === 'number' ? Math.max(max, r.vmid) : max), 0);
  return highest + 1;
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
 * `target` is optional, mirroring the real precheck endpoint (and the server route -- see
 * `migrateRoutes.ts`): every other node's eligibility is reported the same way whether or not one
 * was given, matching real PVE's own precheck, which reports the whole cluster's candidates in
 * one call, target or no.
 */
export function getFixtureMigratePrecheck(
  node: string,
  type: GuestType,
  vmid: number,
  target: string | undefined,
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

/**
 * Test/demo-only mutator (T48): shallow-merges arbitrary config keys into one guest's fixture
 * config (`configs[vmid]`, served by `getVmConfig`), in place -- the generalisation of
 * `setFixtureGuestConfig` (which only knows `name`/`description`) that the hardware edit fixture
 * flow (`src/api/hardware.ts`) needs for `cores`/`memory`/`ideN`/`scsiN`/... An `undefined` value
 * deletes the key. A no-op if no config exists for `vmid` (kept lenient, same as the other
 * fixture mutators).
 */
export function patchFixtureGuestConfig(
  _node: string,
  _type: GuestType,
  vmid: number,
  patch: Record<string, string | number | undefined>,
): void {
  const key = String(vmid);
  const config = configs[key];
  if (!config) return;
  const next: GuestConfig = { ...config };
  for (const [field, value] of Object.entries(patch)) {
    if (value === undefined) delete next[field];
    else next[field] = value;
  }
  configs[key] = next;
}

/** Test/demo-only lookup (T48): one guest's current fixture config, or `undefined` if none. */
export function getFixtureGuestConfig(vmid: number): GuestConfig | undefined {
  return configs[String(vmid)];
}

// --- T54 cloud-init ---------------------------------------------------------------------------

/**
 * Demo state for the Cloud-Init tab (T54): per guest, the cloud-init config keys PVE would hold
 * back as "pending" (a change made while the guest runs) until the image is regenerated. The
 * settings themselves live in the guest's fixture config (`ciuser`, `ipconfig0`, `sshkeys`, ...),
 * written through `patchFixtureGuestConfig`; a typed password is never stored -- the config only
 * ever holds PVE's own `********` mask, same as a real `GET .../config`.
 */
export const fixtureCloudInit = {
  pending: new Map<number, Set<string>>(),
  /** How many times each guest's image was regenerated in this session. */
  regenerated: new Map<number, number>(),
};

/** Replaces one guest's held-back cloud-init keys. */
export function setFixtureCloudInitPending(vmid: number, keys: Iterable<string>): void {
  const next = new Set(keys);
  if (next.size === 0) fixtureCloudInit.pending.delete(vmid);
  else fixtureCloudInit.pending.set(vmid, next);
}

/** The cloud-init keys currently held back for one guest, in insertion order. */
export function getFixtureCloudInitPending(vmid: number): string[] {
  return [...(fixtureCloudInit.pending.get(vmid) ?? [])];
}

/** Marks one guest's cloud-init image as regenerated: PVE applies every held-back value. */
export function regenerateFixtureCloudInit(vmid: number): void {
  fixtureCloudInit.pending.delete(vmid);
  fixtureCloudInit.regenerated.set(vmid, (fixtureCloudInit.regenerated.get(vmid) ?? 0) + 1);
}

// The demo's VM 100 already carries a cloud-init drive (`ide3`); give it settings too, so the
// Cloud-Init tab shows a populated panel. Appended here rather than edited into `configs.json`.
patchFixtureGuestConfig('pve1', 'qemu', 100, {
  ciuser: 'debian',
  cipassword: '********',
  searchdomain: 'lab.example.com',
  nameserver: '10.0.20.2 10.0.20.3',
  sshkeys: encodeURIComponent(
    'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIDemoFixtureKeyOnlyNotARealKey000000000000 admin@lab',
  ),
  ipconfig0: 'ip=10.0.20.15/24,gw=10.0.20.1',
});
// --- T55: USB / PCI / serial device pickers ---------------------------------------------------

/** One USB device `GET /nodes/{node}/hardware/usb` lists (the fields the picker shows). */
export interface HostUsbDevice {
  /** `vendid:prodid`, e.g. `1d6b:0003`. */
  id: string;
  vendid: string;
  prodid: string;
  manufacturer?: string;
  product?: string;
  /** `bus-port`, e.g. `1-2` (absent for a root hub). */
  usbpath?: string;
  speed?: number;
}

/** One PCI device `GET /nodes/{node}/hardware/pci` lists. */
export interface HostPciDevice {
  /** `0000:01:00.0`. */
  id: string;
  class?: string;
  vendor_name?: string;
  device_name?: string;
  iommugroup: number;
}

/** One cluster-wide hardware mapping (`/cluster/mapping/usb|pci`). */
export interface HardwareMapping {
  id: string;
  description?: string;
}

export const fixtureHostUsb: HostUsbDevice[] = [
  { id: '1d6b:0003', vendid: '1d6b', prodid: '0003', manufacturer: 'Linux Foundation', product: '3.0 root hub', speed: 5000 },
  { id: '046d:c52b', vendid: '046d', prodid: 'c52b', manufacturer: 'Logitech, Inc.', product: 'Unifying Receiver', usbpath: '1-2', speed: 12 },
  { id: '0781:5581', vendid: '0781', prodid: '5581', manufacturer: 'SanDisk Corp.', product: 'Ultra', usbpath: '2-1.3', speed: 5000 },
];

export const fixtureHostPci: HostPciDevice[] = [
  { id: '0000:00:02.0', class: '0x030000', vendor_name: 'Intel Corporation', device_name: 'UHD Graphics 630', iommugroup: 0 },
  { id: '0000:01:00.0', class: '0x030000', vendor_name: 'NVIDIA Corporation', device_name: 'GA102 [GeForce RTX 3090]', iommugroup: 1 },
  { id: '0000:01:00.1', class: '0x040300', vendor_name: 'NVIDIA Corporation', device_name: 'GA102 High Definition Audio Controller', iommugroup: 1 },
  { id: '0000:03:00.0', class: '0x010802', vendor_name: 'Samsung Electronics Co Ltd', device_name: 'NVMe SSD Controller 980', iommugroup: 2 },
];

export const fixtureUsbMappings: HardwareMapping[] = [
  { id: 'mykeyboard', description: 'Front-desk keyboard' },
  { id: 'license-dongle', description: 'Accounting license key' },
];

export const fixturePciMappings: HardwareMapping[] = [{ id: 'gpu0', description: 'RTX 3090 (passthrough)' }];

let hostListsForbidden = false;

/**
 * Test/demo-only (T55): when on, the host USB/PCI lists and the hardware mappings answer as if the
 * caller lacked `Sys.Modify` / `Mapping.Audit` (the device dialogs then fall back to manual entry).
 */
export function setFixtureHostListsForbidden(forbidden: boolean): void {
  hostListsForbidden = forbidden;
}

export function areFixtureHostListsForbidden(): boolean {
  return hostListsForbidden;
}

// --- T56 guest firewall ---------------------------------------------------------------------

/** One guest's firewall in the demo: the options (PVE's wire shape: 0/1 for booleans), the rules in
 * evaluation order, and the config digest every read carries (bumped on every change). */
export interface FixtureFirewallEntry {
  options: Record<string, number | string>;
  rules: FirewallRule[];
  digest: string;
  version: number;
}

function initialFixtureFirewall(): Record<string, FixtureFirewallEntry> {
  const entry = (
    vmid: number,
    options: Record<string, number | string>,
    rules: Array<Omit<FirewallRule, 'pos' | 'digest'>>,
  ): FixtureFirewallEntry => ({
    options,
    rules: rules.map((rule, pos) => ({ ...rule, pos })),
    digest: `fixture-fw-${vmid}-1`,
    version: 1,
  });
  return {
    '100': entry(
      100,
      { enable: 0, policy_in: 'DROP', policy_out: 'ACCEPT', dhcp: 1, ndp: 1, macfilter: 1, log_level_in: 'nolog' },
      [
        { type: 'in', action: 'ACCEPT', enable: 1, macro: 'SSH', source: '10.0.0.0/24', comment: 'SSH from the office' },
        { type: 'in', action: 'ACCEPT', enable: 1, proto: 'tcp', dport: '80,443', comment: 'Web' },
        { type: 'in', action: 'ACCEPT', enable: 0, proto: 'icmp', comment: 'Ping' },
        { type: 'group', action: 'webservers', enable: 1, iface: 'net0' },
      ],
    ),
    '200': entry(
      200,
      { enable: 1, policy_in: 'DROP', policy_out: 'ACCEPT', radv: 0, log_level_out: 'info' },
      [
        { type: 'out', action: 'DROP', enable: 1, proto: 'tcp', dport: '25', log: 'info', comment: 'No outbound SMTP' },
        { type: 'in', action: 'ACCEPT', enable: 1, proto: 'tcp', dport: '80,443', comment: 'Reverse proxy' },
        { type: 'in', action: 'ACCEPT', enable: 1, proto: 'udp', source: '192.168.0.0/16', dport: '53', iface: 'net0' },
      ],
    ),
  };
}

let fixtureFirewall = initialFixtureFirewall();

/** The demo's cluster security groups (the group-rule picker's options). */
export const FIXTURE_SECURITY_GROUPS: Array<{ group: string; comment?: string }> = [
  { group: 'dbservers', comment: 'Database ports' },
  { group: 'webservers', comment: 'HTTP and HTTPS' },
];

/** The demo's firewall macros (the macro picker's options). */
export const FIXTURE_FIREWALL_MACROS: Array<{ macro: string; descr?: string }> = [
  { macro: 'DNS', descr: 'Domain Name System' },
  { macro: 'HTTP', descr: 'Hypertext Transfer Protocol' },
  { macro: 'HTTPS', descr: 'Hypertext Transfer Protocol over SSL/TLS' },
  { macro: 'MySQL', descr: 'MySQL server' },
  { macro: 'Ping', descr: 'ICMP echo request' },
  { macro: 'PostgreSQL', descr: 'PostgreSQL server' },
  { macro: 'RDP', descr: 'Microsoft Remote Desktop Protocol' },
  { macro: 'SMTP', descr: 'Simple Mail Transfer Protocol' },
  { macro: 'SSH', descr: 'Secure shell' },
];

/** Test/demo-only lookup (T56): one guest's fixture firewall (an empty one for a guest without one). */
export function getFixtureFirewall(vmid: number): FixtureFirewallEntry {
  return fixtureFirewall[String(vmid)] ?? { options: {}, rules: [], digest: `fixture-fw-${vmid}-1`, version: 1 };
}

function touchFixtureFirewall(vmid: number, mutate: (entry: FixtureFirewallEntry) => void): void {
  const key = String(vmid);
  const entry = fixtureFirewall[key] ?? { options: {}, rules: [], digest: '', version: 0 };
  mutate(entry);
  entry.rules = entry.rules.map((rule, pos) => ({ ...rule, pos }));
  entry.version += 1;
  entry.digest = `fixture-fw-${vmid}-${entry.version}`;
  fixtureFirewall[key] = entry;
}

function stripUndefined<T extends object>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as T;
}

/** Test/demo-only mutator (T56): inserts a rule at `pos` (default: the end), renumbering. */
export function addFixtureFirewallRule(vmid: number, rule: Omit<FirewallRule, 'pos' | 'digest'>, pos?: number): void {
  touchFixtureFirewall(vmid, (entry) => {
    const at = pos === undefined ? entry.rules.length : Math.min(Math.max(pos, 0), entry.rules.length);
    entry.rules.splice(at, 0, { ...stripUndefined(rule), pos: at });
  });
}

/** Test/demo-only mutator (T56): applies `patch`, clears the `clear` fields, and optionally moves
 * the rule to `moveto`. `false` when no rule sits at `pos`. */
export function updateFixtureFirewallRule(
  vmid: number,
  pos: number,
  patch: Partial<Omit<FirewallRule, 'pos' | 'digest'>>,
  clear: string[],
  moveto?: number,
): boolean {
  if (getFixtureFirewall(vmid).rules[pos] === undefined) return false;
  touchFixtureFirewall(vmid, (entry) => {
    const next: Record<string, unknown> = { ...entry.rules[pos], ...stripUndefined(patch) };
    for (const field of clear) delete next[field];
    entry.rules.splice(pos, 1);
    const at = moveto === undefined ? pos : Math.min(Math.max(moveto, 0), entry.rules.length);
    entry.rules.splice(at, 0, next as unknown as FirewallRule);
  });
  return true;
}

/** Test/demo-only mutator (T56): removes the rule at `pos`; `false` when there is none. */
export function deleteFixtureFirewallRule(vmid: number, pos: number): boolean {
  if (getFixtureFirewall(vmid).rules[pos] === undefined) return false;
  touchFixtureFirewall(vmid, (entry) => {
    entry.rules.splice(pos, 1);
  });
  return true;
}

/** Test/demo-only mutator (T56): merges options; booleans are stored 0/1 like PVE reports them. */
export function patchFixtureFirewallOptions(vmid: number, patch: Record<string, boolean | string | undefined>): void {
  touchFixtureFirewall(vmid, (entry) => {
    for (const [key, value] of Object.entries(patch)) {
      if (value === undefined) continue;
      entry.options[key] = typeof value === 'boolean' ? (value ? 1 : 0) : value;
    }
  });
}

/** Test-only (T56): puts every guest's fixture firewall back to its initial state. */
export function resetFixtureFirewall(): void {
  fixtureFirewall = initialFixtureFirewall();
}

// --- T62 create container ---------------------------------------------------------------------

/**
 * Test/demo-only mutator (T62): sets (or replaces) one guest's whole fixture config. Unlike
 * `patchFixtureGuestConfig`, which is a no-op for a vmid without a config, this creates the entry --
 * `createCt` (`src/api/createCt.ts`) needs it for a brand-new container. The caller never puts a
 * secret in `config` (the root password is never stored).
 */
export function setFixtureGuestConfigRecord(vmid: number, config: GuestConfig): void {
  configs[String(vmid)] = config;
}

// --- T61 create VM ---

/**
 * Test/demo-only mutator (T61): stores a complete config for a guest that has none yet (a freshly
 * created VM -- `addFixtureGuest` only adds the cluster-resource row, and `patchFixtureGuestConfig`
 * is a no-op without an existing config). Replaces whatever config `vmid` had.
 */
export function addFixtureGuestConfig(vmid: number, config: GuestConfig): void {
  configs[String(vmid)] = { ...config };
}

// --- T64 notification settings --------------------------------------------------------------

export type FixtureMuteSpan = '1h' | '8h' | '24h' | '7d';
type FixtureNotifyKind = 'backup' | 'task' | 'storage';
type FixtureKeep = { keep: true };

/** The masked settings view `GET /api/notify/settings` returns (mirrors `NotifySettingsView` in
 *  `api/notify.ts`; declared here so this append-only block needs no new import). */
export interface FixtureNotifySettingsView {
  source: 'file' | 'env';
  enabled: boolean;
  muteUntil?: string;
  mutedKinds: FixtureNotifyKind[];
  minSeverity: 'warning' | 'error';
  includeResolved: boolean;
  debounceMs: number;
  siteName: string;
  publicUrl?: string;
  webhook?: {
    url: { host: string; masked: true };
    format: 'generic' | 'discord' | 'slack' | 'ntfy' | 'gotify';
    token: { set: boolean };
  };
  email?: {
    smtpUrl: { host: string; port: number; secure: boolean; user?: string; set: true };
    from: string;
    to: string[];
  };
  channels: { webhook: boolean; email: boolean };
  error?: string;
}

/** The body `PUT /api/notify/settings` takes (mirrors `NotifySettingsPutBody` in `api/notify.ts`). */
export interface FixtureNotifySettingsPut {
  enabled: boolean;
  muteUntil?: string | null;
  mutedKinds: FixtureNotifyKind[];
  minSeverity: 'warning' | 'error';
  includeResolved: boolean;
  debounceMs: number;
  siteName: string;
  publicUrl?: string | null;
  webhook?: {
    url: string | FixtureKeep;
    format: 'generic' | 'discord' | 'slack' | 'ntfy' | 'gotify';
    token?: string | FixtureKeep | null;
  } | null;
  email?: { smtpUrl: string | FixtureKeep; from: string; to: string[] } | null;
}

interface FixtureNotifyStored {
  source: 'file' | 'env';
  enabled: boolean;
  muteUntil?: string;
  mutedKinds: FixtureNotifyKind[];
  minSeverity: 'warning' | 'error';
  includeResolved: boolean;
  debounceMs: number;
  siteName: string;
  publicUrl?: string;
  webhook?: { url: string; format: 'generic' | 'discord' | 'slack' | 'ntfy' | 'gotify'; token?: string };
  email?: { smtpUrl: string; from: string; to: string[] };
}

function initialFixtureNotifyStored(): FixtureNotifyStored {
  return {
    source: 'env',
    enabled: true,
    mutedKinds: [],
    minSeverity: 'warning',
    includeResolved: true,
    debounceMs: 10_000,
    siteName: 'Proxion',
    publicUrl: 'https://proxion.example.com',
    webhook: { url: 'https://ntfy.example.com/proxion-alerts', format: 'ntfy', token: 'fixture-token' },
  };
}

let fixtureNotifyStored: FixtureNotifyStored = initialFixtureNotifyStored();

const FIXTURE_NOTIFY_KINDS: readonly FixtureNotifyKind[] = ['backup', 'task', 'storage'];

function maskFixtureNotify(stored: FixtureNotifyStored, nowMs: number): FixtureNotifySettingsView {
  const view: FixtureNotifySettingsView = {
    source: stored.source,
    enabled: stored.enabled,
    mutedKinds: FIXTURE_NOTIFY_KINDS.filter((kind) => stored.mutedKinds.includes(kind)),
    minSeverity: stored.minSeverity,
    includeResolved: stored.includeResolved,
    debounceMs: stored.debounceMs,
    siteName: stored.siteName,
    channels: { webhook: Boolean(stored.webhook), email: Boolean(stored.email) },
  };
  if (stored.muteUntil && Date.parse(stored.muteUntil) > nowMs) view.muteUntil = stored.muteUntil;
  if (stored.publicUrl) view.publicUrl = stored.publicUrl;
  if (stored.webhook) {
    view.webhook = {
      url: { host: new URL(stored.webhook.url).host, masked: true },
      format: stored.webhook.format,
      token: { set: Boolean(stored.webhook.token) },
    };
  }
  if (stored.email) {
    const url = new URL(stored.email.smtpUrl);
    const secure = url.protocol === 'smtps:';
    view.email = {
      smtpUrl: {
        host: url.hostname,
        port: url.port ? Number(url.port) : secure ? 465 : 587,
        secure,
        ...(url.username ? { user: decodeURIComponent(url.username) } : {}),
        set: true,
      },
      from: stored.email.from,
      to: stored.email.to,
    };
  }
  return view;
}

function fixtureUrlHas(value: string, protocols: readonly string[]): boolean {
  try {
    return protocols.includes(new URL(value).protocol);
  } catch {
    return false;
  }
}

/** Demo/test-only (T64): the masked notification settings. */
export function getFixtureNotifySettings(): FixtureNotifySettingsView {
  return maskFixtureNotify(fixtureNotifyStored, Date.now());
}

/**
 * Demo/test-only (T64): applies a `PUT /api/notify/settings` body the way the server does -- full
 * replace, `{ keep: true }` resolves against what is stored, an omitted `muteUntil` keeps the
 * current snooze. Throws an `Error` carrying the server-style `field: message` text on the
 * validation failures the form can actually hit.
 */
export function putFixtureNotifySettings(body: FixtureNotifySettingsPut): FixtureNotifySettingsView {
  const current = fixtureNotifyStored;
  if (!Number.isInteger(body.debounceMs) || body.debounceMs < 1000 || body.debounceMs > 600_000) {
    throw new Error('debounceMs: Too small: expected number to be >=1000');
  }
  if (body.siteName.trim().length < 1 || body.siteName.length > 64) throw new Error('siteName: Invalid length');
  if (body.publicUrl && !fixtureUrlHas(body.publicUrl, ['http:', 'https:'])) {
    throw new Error('publicUrl: must be an absolute http(s) URL');
  }

  const next: FixtureNotifyStored = {
    source: 'file',
    enabled: body.enabled,
    mutedKinds: FIXTURE_NOTIFY_KINDS.filter((kind) => body.mutedKinds.includes(kind)),
    minSeverity: body.minSeverity,
    includeResolved: body.includeResolved,
    debounceMs: body.debounceMs,
    siteName: body.siteName.trim(),
  };
  const muteUntil = body.muteUntil === undefined ? current.muteUntil : (body.muteUntil ?? undefined);
  if (muteUntil) next.muteUntil = muteUntil;
  if (body.publicUrl) next.publicUrl = body.publicUrl;

  if (body.webhook) {
    let url: string;
    if (typeof body.webhook.url === 'string') {
      if (!fixtureUrlHas(body.webhook.url, ['http:', 'https:'])) throw new Error('webhook.url: must be an absolute http(s) URL');
      url = body.webhook.url;
    } else {
      if (!current.webhook) throw new Error('webhook.url: there is no stored webhook URL to keep');
      url = current.webhook.url;
    }
    let token: string | undefined;
    if (typeof body.webhook.token === 'string') {
      token = body.webhook.token;
    } else if (body.webhook.token && current.webhook?.token) {
      if (new URL(url).origin !== new URL(current.webhook.url).origin) {
        throw new Error('webhook.token: enter the token again when you change the webhook address');
      }
      token = current.webhook.token;
    }
    next.webhook = { url, format: body.webhook.format, ...(token !== undefined ? { token } : {}) };
  }

  if (body.email) {
    let smtpUrl: string;
    if (typeof body.email.smtpUrl === 'string') {
      if (!fixtureUrlHas(body.email.smtpUrl, ['smtp:', 'smtps:'])) throw new Error('email.smtpUrl: must be an smtp:// or smtps:// URL');
      smtpUrl = body.email.smtpUrl;
    } else {
      if (!current.email) throw new Error('email.smtpUrl: there is no stored SMTP URL to keep');
      smtpUrl = current.email.smtpUrl;
    }
    if (body.email.to.length === 0) throw new Error('email.to: Too small: expected array to have >=1 items');
    next.email = { smtpUrl, from: body.email.from, to: body.email.to };
  }

  fixtureNotifyStored = next;
  return maskFixtureNotify(next, Date.now());
}

const FIXTURE_MUTE_MS: Record<FixtureMuteSpan, number> = {
  '1h': 3_600_000,
  '8h': 8 * 3_600_000,
  '24h': 24 * 3_600_000,
  '7d': 7 * 24 * 3_600_000,
};

/** Demo/test-only (T64): the snooze buttons -- `null` clears the mute. */
export function muteFixtureNotifications(span: FixtureMuteSpan | null): FixtureNotifySettingsView {
  const next: FixtureNotifyStored = { ...fixtureNotifyStored, source: 'file' };
  delete next.muteUntil;
  if (span !== null) next.muteUntil = new Date(Date.now() + FIXTURE_MUTE_MS[span]).toISOString();
  fixtureNotifyStored = next;
  return maskFixtureNotify(next, Date.now());
}

/** Test-only (T64): puts the fixture notification settings back to their initial (env) state. */
export function resetFixtureNotifySettings(): void {
  fixtureNotifyStored = initialFixtureNotifyStored();
}
