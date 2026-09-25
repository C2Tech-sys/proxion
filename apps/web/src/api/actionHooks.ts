import { useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';

import { USE_FIXTURES } from '@/api/client';
import { CLUSTER_RESOURCES_QUERY_KEY, TASKS_QUERY_KEY } from '@/api/liveState';
import {
  guestAction,
  updateGuestConfig,
  createSnapshot,
  deleteSnapshot,
  rollbackSnapshot,
  GuestActionError,
  type GuestAction,
  type GuestActionBody,
  type GuestConfigPatch,
  type CreateSnapshotBody,
  type DeleteSnapshotOptions,
  type RollbackSnapshotOptions,
  type SnapshotActionResult,
} from '@/api/actions';
import type { GuestType, PveTask } from '@/api/types';

const ACTION_LABELS: Record<GuestAction, string> = {
  start: 'Start',
  shutdown: 'Shut down',
  stop: 'Stop',
  reboot: 'Reboot',
  reset: 'Reset',
  suspend: 'Pause',
  resume: 'Resume',
};

export interface GuestActionVars {
  node: string;
  type: GuestType;
  vmid: number;
  action: GuestAction;
  body?: GuestActionBody;
}

/** A short form of a UPID for a toast: `UPID:<node>:<pid>:...` -> `<pid>`, falling back to the
 * whole string if it isn't UPID-shaped (defensive -- every real and fixture UPID is). */
function shortUpid(upid: string): string {
  const parts = upid.split(':');
  return parts[2] ?? upid;
}

/**
 * Requests one guest power action (`src/api/actions.ts`). On success: a "<Action> requested"
 * toast with the task's short UPID, and invalidates this guest's own status query plus the
 * cluster-wide resources query, so the header's status chip and the inventory tree pick up the
 * change as soon as the live feed/poll settles. On error: a toast with the server's message.
 */
export function useGuestAction() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (vars: GuestActionVars) => guestAction(vars.node, vars.type, vars.vmid, vars.action, vars.body),
    onSuccess: (result, vars) => {
      toast.success(`${ACTION_LABELS[vars.action]} requested — task ${shortUpid(result.upid)}`);
      void queryClient.invalidateQueries({ queryKey: ['vm-status', vars.node, vars.type, vars.vmid] });
      void queryClient.invalidateQueries({ queryKey: CLUSTER_RESOURCES_QUERY_KEY });
    },
    onError: (error: unknown) => {
      toast.error(error instanceof GuestActionError ? error.message : 'The action could not be started.');
    },
  });
}

export interface GuestConfigUpdateVars {
  node: string;
  type: GuestType;
  vmid: number;
  patch: GuestConfigPatch;
}

/**
 * Requests one guest rename/notes update (`src/api/actions.ts`). On success: invalidates this
 * guest's own config and status queries plus the cluster-wide resources query -- a rename changes
 * the `name`/`hostname` PVE reports on `/cluster/resources` too, which is what the inventory tree
 * and dashboard read, so it needs the same invalidation `useGuestAction` gives a status change --
 * and, only when `description` was part of the change, a "Notes saved" toast (`NotesEditor`'s own
 * success feedback; `RenameGuestDialog` closing is enough feedback for a rename, same as the
 * power-action dialogs closing is). On error: no toast here -- both callers show the server's
 * message inline instead, staying open rather than dismissing with a toast.
 */
export function useUpdateGuestConfig() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (vars: GuestConfigUpdateVars) => updateGuestConfig(vars.node, vars.type, vars.vmid, vars.patch),
    onSuccess: (result, vars) => {
      if (result.changed.includes('description')) {
        toast.success('Notes saved');
      }
      void queryClient.invalidateQueries({ queryKey: ['vm-config', vars.node, vars.type, vars.vmid] });
      void queryClient.invalidateQueries({ queryKey: ['vm-status', vars.node, vars.type, vars.vmid] });
      void queryClient.invalidateQueries({ queryKey: CLUSTER_RESOURCES_QUERY_KEY });
    },
  });
}

/** One snapshot create/delete/rollback, as `useSnapshotAction`'s single mutation dispatches it --
 * mirrors the three server routes (`apps/server/src/actions/snapshotRoutes.ts`) and their web
 * `src/api/actions.ts` counterparts. */
export type SnapshotActionVars =
  | { op: 'create'; node: string; type: GuestType; vmid: number; body: CreateSnapshotBody }
  | { op: 'delete'; node: string; type: GuestType; vmid: number; snapname: string; options?: DeleteSnapshotOptions }
  | {
      op: 'rollback';
      node: string;
      type: GuestType;
      vmid: number;
      snapname: string;
      options?: RollbackSnapshotOptions;
    };

const SNAPSHOT_ACTION_LABEL: Record<SnapshotActionVars['op'], string> = {
  create: 'Snapshot requested',
  delete: 'Snapshot delete requested',
  rollback: 'Rollback requested',
};

function runSnapshotAction(vars: SnapshotActionVars): Promise<SnapshotActionResult> {
  switch (vars.op) {
    case 'create':
      return createSnapshot(vars.node, vars.type, vars.vmid, vars.body);
    case 'delete':
      return deleteSnapshot(vars.node, vars.type, vars.vmid, vars.snapname, vars.options);
    case 'rollback':
      return rollbackSnapshot(vars.node, vars.type, vars.vmid, vars.snapname, vars.options);
  }
}

/** How long after a snapshot mutation succeeds to invalidate `['snapshots', ...]` a second time,
 * on top of the immediate invalidation -- PVE's own snapshot create/delete/rollback are
 * asynchronous tasks (this mutation only gets a UPID back, not the finished result), so a second
 * pass a few seconds later catches the common case where the task has already finished by then,
 * without waiting on the live task feed. */
const SNAPSHOT_REFETCH_DELAY_MS = 3000;

/** How long `watchTaskCompletion` keeps a task's live-feed subscription open before giving up --
 * belt-and-suspenders so a UPID that never shows up in `['tasks']` (e.g. it scrolled out of the
 * cluster-wide recent-task window before this ever saw it) doesn't leak a subscription forever. */
const TASK_WATCH_TIMEOUT_MS = 60_000;

/**
 * Watches the shared `['tasks']` query (kept live by `subscribeLiveEvents` in `liveState.ts`,
 * which this never imports or modifies -- only reads its cache) for `upid` to show up with an
 * `endtime`, then calls `onFinished` once and stops watching. A no-op in fixture mode: the fixture
 * client has no live task feed, and `SNAPSHOT_REFETCH_DELAY_MS`'s delayed invalidation alone is
 * enough there (the fixture mutation has already completed synchronously by the time it fires).
 */
function watchTaskCompletion(queryClient: QueryClient, upid: string, onFinished: () => void): void {
  if (USE_FIXTURES) return;

  const stop = queryClient.getQueryCache().subscribe((event) => {
    const key = event.query.queryKey;
    if (key.length !== TASKS_QUERY_KEY.length || key[0] !== TASKS_QUERY_KEY[0]) return;
    const tasks = queryClient.getQueryData<PveTask[]>(TASKS_QUERY_KEY);
    const task = tasks?.find((t) => t.upid === upid);
    if (task && task.endtime !== undefined) {
      onFinished();
      clearTimeout(timeout);
      stop();
    }
  });
  const timeout = setTimeout(stop, TASK_WATCH_TIMEOUT_MS);
}

/**
 * Requests one snapshot create/delete/rollback (`src/api/actions.ts`). On success: a
 * "<Snapshot action> requested — task <short upid>" toast, and invalidates this guest's own
 * `['snapshots', ...]` query immediately, again ~3s later (`SNAPSHOT_REFETCH_DELAY_MS`), and once
 * more the moment the live task feed reports the task finished (`watchTaskCompletion`) -- PVE's
 * snapshot operations are all asynchronous tasks, so none of the three alone is reliably both
 * fast and correct. A rollback also invalidates this guest's status query and the cluster-wide
 * resources query, since `start: true` can boot a stopped guest back up. On error: a toast with
 * the server's message, same convention as `useGuestAction`.
 */
export function useSnapshotAction() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: runSnapshotAction,
    onSuccess: (result, vars) => {
      toast.success(`${SNAPSHOT_ACTION_LABEL[vars.op]} — task ${shortUpid(result.upid)}`);

      const snapshotsKey = ['snapshots', vars.node, vars.type, vars.vmid];
      const invalidateSnapshots = () => void queryClient.invalidateQueries({ queryKey: snapshotsKey });
      invalidateSnapshots();
      setTimeout(invalidateSnapshots, SNAPSHOT_REFETCH_DELAY_MS);
      watchTaskCompletion(queryClient, result.upid, invalidateSnapshots);

      if (vars.op === 'rollback') {
        void queryClient.invalidateQueries({ queryKey: ['vm-status', vars.node, vars.type, vars.vmid] });
        void queryClient.invalidateQueries({ queryKey: CLUSTER_RESOURCES_QUERY_KEY });
      }
    },
    onError: (error: unknown) => {
      toast.error(error instanceof GuestActionError ? error.message : 'The snapshot action could not be started.');
    },
  });
}

export interface GuestPermissions {
  /** Whether the caller holds the given PVE privilege on this guest (e.g. `"VM.PowerMgmt"`). */
  can: (privilege: string) => boolean;
}

const ALL_PRIVILEGES: GuestPermissions = { can: () => true };

/** Real PVE nests the result under the requested path (`{ "/vms/113": { "VM.PowerMgmt": 1 } }`);
 * fall back to a flat map in case that ever changes (mirrors the server's own handling). */
function scopedPermissions(envelopeData: unknown, vmPath: string): Record<string, unknown> {
  if (!envelopeData || typeof envelopeData !== 'object') return {};
  const record = envelopeData as Record<string, unknown>;
  const scoped = record[vmPath];
  if (scoped && typeof scoped === 'object') return scoped as Record<string, unknown>;
  return record;
}

/**
 * The caller's PVE permissions on one guest (`GET /access/permissions?path=/vms/{vmid}`, through
 * the existing read-only `/api/pve/*` proxy). Fixture mode never makes the request -- the demo
 * always reports every privilege as granted, matching `usePermissions`'s job of gating *quick
 * actions*, not PVE authorization itself (the server enforces that independently either way).
 */
export function usePermissions(vmid: number) {
  const vmPath = `/vms/${vmid}`;

  return useQuery({
    queryKey: ['permissions', vmid],
    queryFn: async (): Promise<GuestPermissions> => {
      const res = await fetch(`/api/pve/access/permissions?path=${encodeURIComponent(vmPath)}`);
      if (!res.ok) throw new Error(`Failed to load permissions for vmid ${vmid}: ${res.status}`);
      const envelope = (await res.json()) as { data?: unknown };
      const scoped = scopedPermissions(envelope.data, vmPath);
      return { can: (privilege: string) => Boolean(scoped[privilege]) };
    },
    enabled: !USE_FIXTURES && Boolean(vmid),
    staleTime: 5 * 60 * 1000,
    ...(USE_FIXTURES ? { initialData: ALL_PRIVILEGES } : {}),
  });
}
