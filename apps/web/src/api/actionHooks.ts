import { useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { useNavigate, useSearch } from '@tanstack/react-router';
import { toast } from 'sonner';

import { isVmTab, type VmTab } from '@/pages/vm/tabs';

import { USE_FIXTURES } from '@/api/client';
import { CLUSTER_RESOURCES_QUERY_KEY, TASKS_QUERY_KEY } from '@/api/liveState';
import {
  guestAction,
  updateGuestConfig,
  createSnapshot,
  deleteSnapshot,
  rollbackSnapshot,
  migrateGuest,
  getMigratePrecheck,
  nodeAction,
  downloadUrlToStorage,
  deleteStorageContent,
  backupGuest,
  restoreGuest,
  getRestoreNextId,
  cloneGuest,
  getCloneNextId,
  destroyGuest,
  convertToTemplate,
  GuestActionError,
  type GuestAction,
  type GuestActionBody,
  type GuestConfigPatch,
  type CreateSnapshotBody,
  type DeleteSnapshotOptions,
  type RollbackSnapshotOptions,
  type SnapshotActionResult,
  type MigrateGuestBody,
  type NodeActionCommand,
  type DownloadUrlToStorageBody,
  type BackupGuestBody,
  type RestoreGuestBody,
  type CloneGuestBody,
  type DestroyGuestBody,
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
function watchTaskCompletion(
  queryClient: QueryClient,
  upid: string,
  onFinished: () => void,
  /** Optional -- called instead of `onFinished` when the finished task's own `status` reports a
   * failure (PVE reports `"OK"` on success, anything else is the error text). Every caller before
   * `useCloneGuest` (T42) omits this and always treats a finished task as success, unchanged. */
  onFailed?: (message: string) => void,
): void {
  if (USE_FIXTURES) return;

  const stop = queryClient.getQueryCache().subscribe((event) => {
    const key = event.query.queryKey;
    if (key.length !== TASKS_QUERY_KEY.length || key[0] !== TASKS_QUERY_KEY[0]) return;
    const tasks = queryClient.getQueryData<PveTask[]>(TASKS_QUERY_KEY);
    const task = tasks?.find((t) => t.upid === upid);
    if (task && task.endtime !== undefined) {
      if (onFailed && task.status !== undefined && task.status !== 'OK') {
        onFailed(task.status);
      } else {
        onFinished();
      }
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

export interface MigrateGuestVars {
  node: string;
  type: GuestType;
  vmid: number;
  /** The guest's display name, for the "Migrating <name> to <target>…" toast only -- never sent
   * to the server. */
  name: string;
  body: MigrateGuestBody;
}

/**
 * Requests one guest migrate (`src/api/actions.ts`). On success: a "Migrating <name> to
 * <target>…" toast right away, then waits for the task to finish (`watchTaskCompletion` -- a
 * no-op in fixture mode, where the in-memory move already happened synchronously inside
 * `migrateGuest` itself) before invalidating this guest's status query (both its old and new
 * node, since the node it lives under just changed) and the cluster-wide resources query,
 * navigating to the guest's new URL (same `tab`), and toasting "Migrated to <target>". On error:
 * a toast with the server's message, same convention as `useGuestAction`/`useSnapshotAction`.
 */
export function useMigrateGuest() {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  // Not every surface that opens `MigrateGuestDialog` is itself the VM route (the inventory rail
  // and `/guests` render it too) -- `strict: false` reads whatever the current route's search is
  // without requiring this hook to be scoped to the VM route, and only `tab` (validated with the
  // VM route's own `isVmTab`) is ever carried over to the post-migration navigate below.
  const currentSearch = useSearch({ strict: false }) as { tab?: unknown };
  const currentTab: VmTab = isVmTab(currentSearch.tab) ? currentSearch.tab : 'summary';

  return useMutation({
    mutationFn: (vars: MigrateGuestVars) => migrateGuest(vars.node, vars.type, vars.vmid, vars.body),
    onSuccess: (result, vars) => {
      toast.success(`Migrating ${vars.name} to ${vars.body.target}…`);

      const finish = () => {
        void queryClient.invalidateQueries({ queryKey: ['vm-status', vars.node, vars.type, vars.vmid] });
        void queryClient.invalidateQueries({ queryKey: ['vm-status', vars.body.target, vars.type, vars.vmid] });
        void queryClient.invalidateQueries({ queryKey: CLUSTER_RESOURCES_QUERY_KEY });
        void navigate({
          to: '/vm/$node/$type/$vmid',
          params: { node: vars.body.target, type: vars.type, vmid: String(vars.vmid) },
          search: { tab: currentTab },
        });
        toast.success(`Migrated to ${vars.body.target}`);
      };

      if (USE_FIXTURES) {
        finish();
      } else {
        watchTaskCompletion(queryClient, result.upid, finish);
      }
    },
    onError: (error: unknown) => {
      toast.error(error instanceof GuestActionError ? error.message : 'The migration could not be started.');
    },
  });
}

/**
 * The guest's migrate precheck, keyed on `target` -- which is a valid key on its own:
 * `MigrateGuestDialog` queries this once with `target: undefined` as soon as it opens (PVE's own
 * precheck endpoint accepts an absent `target` too, and reports cluster-wide
 * `allowedNodes`/`notAllowedNodes` either way -- see `migrateRoutes.ts`), so every node's
 * eligibility for the picker is known before any target is chosen, then again with whichever
 * node is picked, refining the guest-intrinsic (`running`) and target-specific (local disks/
 * storage) detail. `placeholderData` keeps the last response visible while a newly-keyed query
 * (e.g. the moment a target is first chosen) is in flight, so the picker's eligibility list never
 * flickers back to "unknown" mid-choice. `enabled` is wired to the dialog's own `open` state --
 * this component stays mounted, just hidden, between opens, and would otherwise fire a precheck
 * request for every closed dialog on the page.
 */
export function useMigratePrecheck(
  node: string,
  type: GuestType,
  vmid: number,
  target: string | undefined,
  enabled = true,
) {
  return useQuery({
    queryKey: ['migrate-precheck', node, type, vmid, target ?? null],
    queryFn: () => getMigratePrecheck(node, type, vmid, target),
    enabled,
    placeholderData: (previousData) => previousData,
  });
}

export interface NodeActionVars {
  node: string;
  command: NodeActionCommand;
}

const NODE_ACTION_LABEL: Record<NodeActionCommand, string> = {
  reboot: 'Reboot requested for',
  shutdown: 'Shutdown requested for',
};

/**
 * Requests one node power action (`src/api/actions.ts`). On success: a "<Reboot/Shutdown>
 * requested for <node>" toast, and invalidates this node's own status query plus the cluster-wide
 * resources query, same convention as `useGuestAction`. There is no UPID to watch for completion
 * (PVE's `/nodes/{node}/status` returns nothing useful -- see `nodeRoutes.ts`), so unlike
 * `useMigrateGuest`/`useSnapshotAction` this doesn't wait on the live task feed. On error: a
 * toast with the server's message.
 */
export function useNodeAction() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (vars: NodeActionVars) => nodeAction(vars.node, vars.command),
    onSuccess: (_result, vars) => {
      toast.success(`${NODE_ACTION_LABEL[vars.command]} ${vars.node}`);
      void queryClient.invalidateQueries({ queryKey: ['node-status', vars.node] });
      void queryClient.invalidateQueries({ queryKey: CLUSTER_RESOURCES_QUERY_KEY });
    },
    onError: (error: unknown) => {
      toast.error(error instanceof GuestActionError ? error.message : 'The node action could not be started.');
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

/**
 * The caller's PVE permissions on one node (`GET /access/permissions?path=/nodes/{node}`, through
 * the existing read-only `/api/pve/*` proxy) -- same shape and rationale as `usePermissions`
 * above, scoped to `/nodes/{node}` instead of `/vms/{vmid}` for `NodePowerMenu`'s own gating
 * (`Sys.PowerMgmt`). Fixture mode never makes the request -- the demo always reports every
 * privilege as granted, same as `usePermissions`.
 */
export function useNodePermissions(node: string) {
  const nodePath = `/nodes/${node}`;

  return useQuery({
    queryKey: ['node-permissions', node],
    queryFn: async (): Promise<GuestPermissions> => {
      const res = await fetch(`/api/pve/access/permissions?path=${encodeURIComponent(nodePath)}`);
      if (!res.ok) throw new Error(`Failed to load permissions for node ${node}: ${res.status}`);
      const envelope = (await res.json()) as { data?: unknown };
      const scoped = scopedPermissions(envelope.data, nodePath);
      return { can: (privilege: string) => Boolean(scoped[privilege]) };
    },
    enabled: !USE_FIXTURES && Boolean(node),
    staleTime: 5 * 60 * 1000,
    ...(USE_FIXTURES ? { initialData: ALL_PRIVILEGES } : {}),
  });
}

/**
 * The caller's PVE permissions on one storage (`GET /access/permissions?path=/storage/{storage}`,
 * through the existing read-only `/api/pve/*` proxy) -- same shape and rationale as
 * `usePermissions`/`useNodePermissions` above, scoped to `/storage/{storage}` for the storage
 * page's Upload/Download-from-URL buttons (`Datastore.AllocateTemplate`) (T32). Fixture mode never
 * makes the request -- the demo always reports every privilege as granted, same as the other two.
 */
export function useStoragePermissions(storage: string) {
  const storagePath = `/storage/${storage}`;

  return useQuery({
    queryKey: ['storage-permissions', storage],
    queryFn: async (): Promise<GuestPermissions> => {
      const res = await fetch(`/api/pve/access/permissions?path=${encodeURIComponent(storagePath)}`);
      if (!res.ok) throw new Error(`Failed to load permissions for storage ${storage}: ${res.status}`);
      const envelope = (await res.json()) as { data?: unknown };
      const scoped = scopedPermissions(envelope.data, storagePath);
      return { can: (privilege: string) => Boolean(scoped[privilege]) };
    },
    enabled: !USE_FIXTURES && Boolean(storage),
    staleTime: 5 * 60 * 1000,
    ...(USE_FIXTURES ? { initialData: ALL_PRIVILEGES } : {}),
  });
}

// Storage uploads (T32) moved to `useUploadStore` (`src/store/uploadStore.ts`, T39): tracked
// app-wide instead of in a `useMutation`/dialog-local `useState`, so an in-progress upload survives
// the dialog that started it unmounting or closing. `useStorageUpload` used to live here as a thin
// `useMutation` wrapper around `uploadToStorage`; nothing outside `UploadDialog` ever called it, and
// `UploadDialog` now calls `useUploadStore.getState().start()` directly, so it was removed rather
// than kept as a second, now-redundant toast/invalidate code path.

export interface StorageDownloadUrlVars {
  node: string;
  storage: string;
  body: DownloadUrlToStorageBody;
}

/**
 * Requests one "download from URL" onto a storage (`src/api/actions.ts`). Same toast/invalidation
 * convention as `useStorageUpload` above: "Download started: <filename>" right away, then
 * "<filename> is ready" once the task finishes (or immediately in fixture mode).
 */
export function useStorageDownloadUrl() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (vars: StorageDownloadUrlVars) => downloadUrlToStorage(vars.node, vars.storage, vars.body),
    onSuccess: (result, vars) => {
      toast.success(`Download started: ${vars.body.filename}`);
      const finish = () => {
        void queryClient.invalidateQueries({ queryKey: ['storage-content', vars.node, vars.storage] });
        toast.success(`${vars.body.filename} is ready`);
      };
      if (USE_FIXTURES) finish();
      else watchTaskCompletion(queryClient, result.upid, finish);
    },
    onError: (error: unknown, vars) => {
      toast.error(error instanceof GuestActionError ? error.message : `${vars.body.filename} could not be downloaded.`);
    },
  });
}

export interface StorageDeleteVars {
  node: string;
  storage: string;
  volid: string;
  /** The volume's owner vmid, when it has one -- forwarded so the server's
   * `Datastore.AllocateSpace` + `VM.Backup` carve-out can apply (see `deleteStorageContent`). */
  vmid?: number;
  /** A short display name for the toast (e.g. the volid with its storage prefix stripped) --
   * never sent to the server. */
  name: string;
}

/**
 * Requests one storage content delete (`src/api/actions.ts`, T32 addendum). On success: a
 * "Deleting <name>…" toast right away, then waits for the task to finish (`watchTaskCompletion` --
 * a no-op in fixture mode, same convention as `useStorageUpload`/`useStorageDownloadUrl`) before
 * invalidating this storage's own `['storage-content', ...]` query and toasting "<name> deleted".
 * On error: a toast with the server's message (PVE's own refusal for a protected/in-use volume
 * surfaces here verbatim).
 */
export function useStorageDelete() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (vars: StorageDeleteVars) =>
      deleteStorageContent(vars.node, vars.storage, vars.volid, { vmid: vars.vmid }),
    onSuccess: (result, vars) => {
      toast.success(`Deleting ${vars.name}…`);
      const finish = () => {
        void queryClient.invalidateQueries({ queryKey: ['storage-content', vars.node, vars.storage] });
        toast.success(`${vars.name} deleted`);
      };
      if (USE_FIXTURES) finish();
      else watchTaskCompletion(queryClient, result.upid, finish);
    },
    onError: (error: unknown, vars) => {
      toast.error(error instanceof GuestActionError ? error.message : `${vars.name} could not be deleted.`);
    },
  });
}

export interface BackupGuestVars {
  node: string;
  type: GuestType;
  vmid: number;
  /** The guest's display name, for the "Backup started"/"finished" toasts only -- never sent to
   * the server. */
  name: string;
  body: BackupGuestBody;
}

/**
 * Requests one guest backup (vzdump) start (`src/api/actions.ts`, T41). On success: a "Backup
 * started: <name>" toast right away, then waits for the task to finish (`watchTaskCompletion` --
 * a no-op in fixture mode, where the in-memory backup volume already exists by the time this
 * fires) before invalidating this tab's own `['storage-content', node, storage]` query (so the new
 * backup volume shows up) and the shared `['tasks']` query, then toasting "Backup of <name>
 * finished". On error: a toast with the server's message, same convention as `useGuestAction`.
 */
export function useBackupGuest() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (vars: BackupGuestVars) => backupGuest(vars.node, vars.type, vars.vmid, vars.body),
    onSuccess: (result, vars) => {
      toast.success(`Backup started: ${vars.name}`);
      const finish = () => {
        void queryClient.invalidateQueries({ queryKey: ['storage-content', vars.node, vars.body.storage] });
        void queryClient.invalidateQueries({ queryKey: TASKS_QUERY_KEY });
        toast.success(`Backup of ${vars.name} finished`);
      };
      if (USE_FIXTURES) finish();
      else watchTaskCompletion(queryClient, result.upid, finish);
    },
    onError: (error: unknown, vars) => {
      toast.error(error instanceof GuestActionError ? error.message : `Backup of ${vars.name} could not be started.`);
    },
  });
}

export interface RestoreGuestVars {
  node: string;
  type: GuestType;
  vmid: number;
  /** The restore's actual target vmid -- equal to `vmid` for an in-place restore, or a different
   * (existing-overwrite or brand-new) id otherwise. Drives the post-restore navigate/toast below. */
  targetVmid: number;
  body: RestoreGuestBody;
}

/**
 * Requests one guest restore-from-backup (`src/api/actions.ts`, T41). On success: a "Restore
 * started…" toast right away, then waits for the task to finish (`watchTaskCompletion`) before
 * invalidating the cluster-wide resources query and the target guest's own status query; when
 * `targetVmid` differs from the source guest's own `vmid` (a new-id or cross-id overwrite restore),
 * also navigates to the target guest's own URL (Summary tab) and toasts "Restored as <targetVmid>".
 * On error: a toast with the server's message, same convention as `useMigrateGuest`.
 */
export function useRestoreGuest() {
  const queryClient = useQueryClient();
  const navigate = useNavigate();

  return useMutation({
    mutationFn: (vars: RestoreGuestVars) => restoreGuest(vars.node, vars.type, vars.vmid, vars.body),
    onSuccess: (result, vars) => {
      toast.success('Restore started…');

      const finish = () => {
        void queryClient.invalidateQueries({ queryKey: CLUSTER_RESOURCES_QUERY_KEY });
        void queryClient.invalidateQueries({ queryKey: ['vm-status', vars.node, vars.type, vars.targetVmid] });
        if (vars.targetVmid !== vars.vmid) {
          void navigate({
            to: '/vm/$node/$type/$vmid',
            params: { node: vars.node, type: vars.type, vmid: String(vars.targetVmid) },
            search: { tab: 'summary' },
          });
          toast.success(`Restored as ${vars.targetVmid}`);
        }
      };

      if (USE_FIXTURES) finish();
      else watchTaskCompletion(queryClient, result.upid, finish);
    },
    onError: (error: unknown) => {
      toast.error(error instanceof GuestActionError ? error.message : 'The restore could not be started.');
    },
  });
}

/**
 * The next free vmid in the cluster, for `RestoreBackupDialog`'s "Use next free ID" button
 * (`src/api/actions.ts`, T41). `enabled` is wired to the dialog's own `open` state, same
 * convention as `useMigratePrecheck` -- this component stays mounted, just hidden, between opens.
 */
export function useRestoreNextId(node: string, type: GuestType, vmid: number, enabled = true) {
  return useQuery({
    queryKey: ['restore-nextid', node, type, vmid],
    queryFn: () => getRestoreNextId(node, type, vmid),
    enabled,
  });
}

export interface CloneGuestVars {
  node: string;
  type: GuestType;
  vmid: number;
  /** The source guest's display name, for the "Cloning <name> -> <newid>..." toast only -- never
   * sent to the server. */
  name: string;
  body: CloneGuestBody;
}

/**
 * Requests one guest clone (`src/api/actions.ts`, T42). On success: a "Cloning <name> -> <newid>..."
 * toast right away, then waits for the task to finish (`watchTaskCompletion` -- a no-op in fixture
 * mode, where the in-memory clone already exists by the time this fires) before invalidating the
 * cluster-wide resources query, navigating to the new guest's own URL (Summary tab), and toasting
 * "Clone created: <newid>". Unlike `useMigrateGuest`/`useRestoreGuest`, a *failed* clone task (PVE
 * reports a `status` other than `"OK"` once it ends) is reported as its own error toast instead of
 * the success toast/navigate -- a clone can fail well after this route's own 202 (e.g. the target
 * storage runs out of space mid-copy), and there is no in-place guest left to navigate to in that
 * case. On a request-level error (never reached PVE, or a 4xx before the task started): a toast
 * with the server's message, same convention as `useMigrateGuest`.
 */
export function useCloneGuest() {
  const queryClient = useQueryClient();
  const navigate = useNavigate();

  return useMutation({
    mutationFn: (vars: CloneGuestVars) => cloneGuest(vars.node, vars.type, vars.vmid, vars.body),
    onSuccess: (result, vars) => {
      toast.success(`Cloning ${vars.name} → ${vars.body.newid}…`);
      const target = vars.body.target ?? vars.node;

      const finish = () => {
        void queryClient.invalidateQueries({ queryKey: CLUSTER_RESOURCES_QUERY_KEY });
        void navigate({
          to: '/vm/$node/$type/$vmid',
          params: { node: target, type: vars.type, vmid: String(vars.body.newid) },
          search: { tab: 'summary' },
        });
        toast.success(`Clone created: ${vars.body.newid}`);
      };
      const failed = (message: string) => {
        toast.error(message || 'The clone task failed.');
      };

      if (USE_FIXTURES) {
        finish();
      } else {
        watchTaskCompletion(queryClient, result.upid, finish, failed);
      }
    },
    onError: (error: unknown) => {
      toast.error(error instanceof GuestActionError ? error.message : 'The clone could not be started.');
    },
  });
}

/**
 * The next free vmid in the cluster, for `CloneGuestDialog`'s "Use next free ID" button
 * (`src/api/actions.ts`, T42). Same shape/rationale as `useRestoreNextId`.
 */
export function useCloneNextId(node: string, type: GuestType, vmid: number, enabled = true) {
  return useQuery({
    queryKey: ['clone-nextid', node, type, vmid],
    queryFn: () => getCloneNextId(node, type, vmid),
    enabled,
  });
}

export interface DestroyGuestVars {
  node: string;
  type: GuestType;
  vmid: number;
  /** The guest's display name, for the toasts only -- never sent to the server. */
  name: string;
  body: DestroyGuestBody;
}

/**
 * Requests one guest delete (`src/api/actions.ts`, T47). On success: a "Deleting <name>..." toast
 * right away, then waits for the task to finish (`watchTaskCompletion` -- a no-op in fixture mode,
 * where the in-memory guest is already gone by the time this fires) before navigating to the
 * guest's node page (Summary tab; the guest's own page no longer exists), invalidating the
 * cluster-wide resources query, and toasting "Deleted <name> (<vmid>)". A *failed* destroy task
 * (PVE reports a `status` other than `"OK"` once it ends, e.g. a locked guest) is reported as its
 * own error toast instead, same as `useCloneGuest`. On a request-level error (never reached PVE,
 * or a 4xx before the task started): a toast with the server's message.
 */
export function useDestroyGuest() {
  const queryClient = useQueryClient();
  const navigate = useNavigate();

  return useMutation({
    mutationFn: (vars: DestroyGuestVars) => destroyGuest(vars.node, vars.type, vars.vmid, vars.body),
    onSuccess: (result, vars) => {
      toast.success(`Deleting ${vars.name}…`);

      const finish = () => {
        void navigate({ to: '/node/$node', params: { node: vars.node }, search: { tab: 'summary' } });
        void queryClient.invalidateQueries({ queryKey: CLUSTER_RESOURCES_QUERY_KEY });
        toast.success(`Deleted ${vars.name} (${vars.vmid})`);
      };
      const failed = (message: string) => {
        toast.error(message || 'The delete task failed.');
      };

      if (USE_FIXTURES) {
        finish();
      } else {
        watchTaskCompletion(queryClient, result.upid, finish, failed);
      }
    },
    onError: (error: unknown) => {
      toast.error(error instanceof GuestActionError ? error.message : 'The delete could not be started.');
    },
  });
}

export interface ConvertToTemplateVars {
  node: string;
  type: GuestType;
  vmid: number;
  /** The guest's display name, for the toasts only -- never sent to the server. */
  name: string;
}

/**
 * Requests converting one guest to a template (`src/api/actions.ts`, T63). On success: a
 * "Converting <name> to a template..." toast right away, then -- once the conversion is actually
 * done -- invalidates the guest's config/status and the cluster-wide resources query (the tree's
 * template badge reads the latter) and toasts "<name> is now a template". qemu answers with a task
 * UPID, so completion is awaited through `watchTaskCompletion` (a no-op in fixture mode, where the
 * in-memory change already happened); lxc answers with no task and is done as soon as the request
 * returns. A *failed* qemu task (PVE reports a `status` other than `"OK"`) is its own error toast.
 * On a request-level error: a toast with the server's message, same convention as
 * `useDestroyGuest`.
 */
export function useConvertToTemplate() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (vars: ConvertToTemplateVars) => convertToTemplate(vars.node, vars.type, vars.vmid),
    onSuccess: (result, vars) => {
      toast.success(`Converting ${vars.name} to a template…`);

      const finish = () => {
        void queryClient.invalidateQueries({ queryKey: ['vm-config', vars.node, vars.type, vars.vmid] });
        void queryClient.invalidateQueries({ queryKey: ['vm-status', vars.node, vars.type, vars.vmid] });
        void queryClient.invalidateQueries({ queryKey: CLUSTER_RESOURCES_QUERY_KEY });
        toast.success(`${vars.name} is now a template`);
      };
      const failed = (message: string) => {
        toast.error(message || 'The convert-to-template task failed.');
      };

      if (USE_FIXTURES || !result.upid) {
        finish();
      } else {
        watchTaskCompletion(queryClient, result.upid, finish, failed);
      }
    },
    onError: (error: unknown) => {
      toast.error(
        error instanceof GuestActionError ? error.message : 'The convert to template could not be started.',
      );
    },
  });
}
