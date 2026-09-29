import { create } from 'zustand';
import type { QueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';

import { uploadToStorage, GuestActionError, type StorageUploadContent } from '@/api/actions';
import { USE_FIXTURES } from '@/api/client';
import { TASKS_QUERY_KEY } from '@/api/liveState';
import type { PveTask } from '@/api/types';

export type UploadStatus = 'uploading' | 'processing' | 'done' | 'error';

export interface UploadEntry {
  id: string;
  node: string;
  storage: string;
  content: StorageUploadContent;
  filename: string;
  total: number;
  sent: number;
  status: UploadStatus;
  error?: string;
  upid?: string;
  startedAt: number;
}

export interface StartUploadVars {
  node: string;
  storage: string;
  content: StorageUploadContent;
  filename: string;
  file: File;
}

/** How long a settled (`done`/`error`) entry stays in the store before it is removed on its own --
 * long enough to actually read the result in `UploadsIndicator`, short enough that a page left open
 * doesn't accumulate stale rows forever. The user's own Dismiss (X) removes it sooner. */
export const UPLOAD_AUTO_REMOVE_MS = 15_000;

/** How long `watchUploadTask` below keeps a task's live-feed subscription open before giving up --
 * same value and reasoning as `actionHooks.ts`'s own `TASK_WATCH_TIMEOUT_MS` (this store
 * deliberately doesn't import that internal helper -- see the module doc comment). */
const TASK_WATCH_TIMEOUT_MS = 60_000;

let sharedQueryClient: QueryClient | undefined;

/**
 * Injects the app's `QueryClient` so `start()` can invalidate `['storage-content', ...]` and read
 * the live `['tasks']` cache once an upload's task finishes -- call this once from `main.tsx`.
 * Tests never need it: they pass their own `QueryClient` straight to `start()`'s second argument
 * instead of relying on this module-level singleton, so multiple test files each keep their own
 * `QueryClient` fully isolated from one another and from whatever a real app render set here.
 */
export function initUploadStore(queryClient: QueryClient): void {
  sharedQueryClient = queryClient;
}

/**
 * Watches the shared `['tasks']` query (kept live by `liveState.ts`'s `subscribeLiveEvents`, which
 * this only ever reads, never modifies) for `upid` to show up with an `endtime`, then calls
 * `onFinished` with that task (or `undefined` if the subscription timed out first) and stops
 * watching. Deliberately a local copy of `actionHooks.ts`'s own `watchTaskCompletion` rather than
 * an import of it: that function only reports *that* a task finished, not its final `status`, and
 * this store needs the latter to tell a successful upload from one whose PVE task itself failed
 * (an invalid ISO, a full datastore, etc.) -- see `start()`'s `finish` below.
 */
function watchUploadTask(queryClient: QueryClient, upid: string, onFinished: (task: PveTask | undefined) => void): void {
  const stop = queryClient.getQueryCache().subscribe((event) => {
    const key = event.query.queryKey;
    if (key.length !== TASKS_QUERY_KEY.length || key[0] !== TASKS_QUERY_KEY[0]) return;
    const tasks = queryClient.getQueryData<PveTask[]>(TASKS_QUERY_KEY);
    const task = tasks?.find((t) => t.upid === upid);
    if (task && task.endtime !== undefined) {
      onFinished(task);
      clearTimeout(timeout);
      stop();
    }
  });
  const timeout = setTimeout(() => {
    stop();
    onFinished(undefined);
  }, TASK_WATCH_TIMEOUT_MS);
}

let nextId = 0;
function makeId(): string {
  nextId += 1;
  return `upload-${Date.now()}-${nextId}`;
}

const controllers = new Map<string, AbortController>();
const removalTimers = new Map<string, ReturnType<typeof setTimeout>>();

function clearRemovalTimer(id: string): void {
  const timer = removalTimers.get(id);
  if (timer) {
    clearTimeout(timer);
    removalTimers.delete(id);
  }
}

export interface UploadStoreState {
  uploads: Record<string, UploadEntry>;
  /**
   * Starts one storage upload (`uploadToStorage`, `src/api/actions.ts`) and tracks it in the
   * store under a fresh id (returned) so it survives the dialog that started it unmounting,
   * closing, or never having been the one reattached to it in the first place. `queryClient`
   * defaults to whatever `initUploadStore` set (the app's real client); tests pass their own.
   *
   * Lifecycle: the entry starts `uploading`, its `sent`/`total` updated from the upload's own
   * `onProgress`. Once the server answers 202: toasts "Upload started: <filename>" (same text the
   * old `useStorageUpload` toasted), status moves to `processing` with the task's `upid`, and
   * (skipped in fixture mode, where the fixture upload has already finished synchronously)
   * `watchUploadTask` waits for that task to finish -- `done` (invalidates this storage's
   * `['storage-content', ...]` query, toasts "<filename> is ready") if the task's own `status` was
   * `'OK'` or unknown, `error` (toasts the task's status) otherwise. If `uploadToStorage` itself
   * rejects (a cancelled upload included -- see `cancel` below), the entry moves straight to
   * `error` with that message and toasts it. Either settled state schedules the entry's own
   * removal after `UPLOAD_AUTO_REMOVE_MS` unless `dismiss` removes it first.
   */
  start: (vars: StartUploadVars, queryClient?: QueryClient) => string;
  /** Aborts an in-flight upload via its own `AbortController` -- `uploadToStorage`'s rejection
   * (`GuestActionError(0, 'Upload cancelled')`) is what actually moves the entry to `error`; a
   * cancel on an id that has already settled (or never existed) is a no-op. */
  cancel: (id: string) => void;
  /** Removes an entry immediately, whatever its status -- also cancels its pending auto-removal
   * timer and drops its `AbortController`, if either is still around. */
  dismiss: (id: string) => void;
}

export const useUploadStore = create<UploadStoreState>((set, get) => ({
  uploads: {},

  start: (vars, queryClient) => {
    const client = queryClient ?? sharedQueryClient;
    const id = makeId();
    const controller = new AbortController();
    controllers.set(id, controller);

    const entry: UploadEntry = {
      id,
      node: vars.node,
      storage: vars.storage,
      content: vars.content,
      filename: vars.filename,
      total: vars.file.size,
      sent: 0,
      status: 'uploading',
      startedAt: Date.now(),
    };
    set((s) => ({ uploads: { ...s.uploads, [id]: entry } }));

    const patch = (fields: Partial<UploadEntry>) => {
      set((s) => {
        const current = s.uploads[id];
        if (!current) return s;
        return { uploads: { ...s.uploads, [id]: { ...current, ...fields } } };
      });
    };

    const settleRemoval = () => {
      clearRemovalTimer(id);
      removalTimers.set(
        id,
        setTimeout(() => {
          removalTimers.delete(id);
          get().dismiss(id);
        }, UPLOAD_AUTO_REMOVE_MS),
      );
    };

    uploadToStorage(vars.node, vars.storage, {
      file: vars.file,
      content: vars.content,
      filename: vars.filename,
      onProgress: (sent, total) => patch({ sent, total }),
      signal: controller.signal,
    }).then(
      (result) => {
        controllers.delete(id);
        toast.success(`Upload started: ${vars.filename}`);
        patch({ status: 'processing', upid: result.upid });

        const finish = (task: PveTask | undefined) => {
          const failed = task?.status !== undefined && task.status !== 'OK';
          if (failed) {
            const message = `${vars.filename} failed: ${task!.status}`;
            patch({ status: 'error', error: message });
            toast.error(message);
          } else {
            if (client) void client.invalidateQueries({ queryKey: ['storage-content', vars.node, vars.storage] });
            patch({ status: 'done' });
            toast.success(`${vars.filename} is ready`);
          }
          settleRemoval();
        };

        if (USE_FIXTURES || !client) finish(undefined);
        else watchUploadTask(client, result.upid, finish);
      },
      (error: unknown) => {
        controllers.delete(id);
        const message = error instanceof GuestActionError ? error.message : `${vars.filename} could not be uploaded.`;
        patch({ status: 'error', error: message });
        toast.error(message);
        settleRemoval();
      },
    );

    return id;
  },

  cancel: (id) => {
    controllers.get(id)?.abort();
  },

  dismiss: (id) => {
    clearRemovalTimer(id);
    controllers.delete(id);
    set((s) => {
      if (!(id in s.uploads)) return s;
      const rest = { ...s.uploads };
      delete rest[id];
      return { uploads: rest };
    });
  },
}));

/** All tracked uploads for one node/storage, newest first -- what `UploadsIndicator` and
 * `UploadDialog`'s own reattach-on-mount lookup both filter down to. */
export function selectUploadsFor(uploads: Record<string, UploadEntry>, node: string, storage: string): UploadEntry[] {
  return Object.values(uploads)
    .filter((u) => u.node === node && u.storage === storage)
    .sort((a, b) => b.startedAt - a.startedAt);
}

/** The active (still-uploading) entry for one node/storage, if any -- what a freshly (re)mounted
 * `UploadDialog` reattaches to so a remount never loses track of an upload already in flight. */
export function findActiveUpload(uploads: Record<string, UploadEntry>, node: string, storage: string): UploadEntry | undefined {
  return Object.values(uploads).find((u) => u.node === node && u.storage === storage && u.status === 'uploading');
}

/**
 * Test-only reset: clears every tracked upload plus this module's own `AbortController`/
 * auto-removal-timer maps and the injected `QueryClient`. `useUploadStore` is a module-level
 * singleton (the same instance every import shares, by design -- it's how a dialog and
 * `UploadsIndicator` see the same uploads), so without this, state from one test would otherwise
 * leak into the next one in the same file. Not used by app code.
 */
export function __resetUploadStoreForTests(): void {
  for (const timer of removalTimers.values()) clearTimeout(timer);
  removalTimers.clear();
  controllers.clear();
  sharedQueryClient = undefined;
  useUploadStore.setState({ uploads: {} });
}
