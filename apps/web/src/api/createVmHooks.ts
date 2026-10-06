import { useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { toast } from 'sonner';

import { USE_FIXTURES } from '@/api/client';
import { createVm, type CreateVmBody } from '@/api/createVm';
import { getNextId, listIsos, listNodes, listStoragesWithContent } from '@/api/create';
import { CLUSTER_RESOURCES_QUERY_KEY, TASKS_QUERY_KEY } from '@/api/liveState';
import type { StorageContentKind } from '@/api/disks';
import type { PveTask } from '@/api/types';

export interface CreateVmVars {
  node: string;
  body: CreateVmBody;
}

/** How long a task watch keeps its live-feed subscription open before giving up (same bound the
 * other guest actions use) -- a UPID that never shows up in `['tasks']` must not leak it. */
const TASK_WATCH_TIMEOUT_MS = 60_000;

/**
 * Watches the shared `['tasks']` query (kept live by `subscribeLiveEvents` in `liveState.ts`) for
 * `upid` to show up with an `endtime`, then calls `onFinished` (task status `OK`) or `onFailed`
 * (anything else) once and stops watching. A deliberate copy of `watchTaskCompletion` in
 * `actionHooks.ts`, which keeps its own private.
 */
function watchTask(
  queryClient: QueryClient,
  upid: string,
  onFinished: () => void,
  onFailed: (message: string) => void,
): void {
  const stop = queryClient.getQueryCache().subscribe((event) => {
    const key = event.query.queryKey;
    if (key.length !== TASKS_QUERY_KEY.length || key[0] !== TASKS_QUERY_KEY[0]) return;
    const task = queryClient.getQueryData<PveTask[]>(TASKS_QUERY_KEY)?.find((t) => t.upid === upid);
    if (task && task.endtime !== undefined) {
      if (task.status !== undefined && task.status !== 'OK') onFailed(task.status);
      else onFinished();
      clearTimeout(timeout);
      stop();
    }
  });
  const timeout = setTimeout(stop, TASK_WATCH_TIMEOUT_MS);
}

/**
 * Creates a VM (`src/api/createVm.ts`) and follows the task. On success: a "Creating VM <id>…"
 * toast right away; once the task finishes (immediately in fixture mode, where the guest was added
 * synchronously) the cluster resources are re-read, a "VM <id> created" toast shows and the app
 * navigates to the new VM's Summary tab. A failed task toasts its PVE status instead. On a request
 * error: no toast here -- the wizard shows the server's message inline and stays open.
 *
 * Mount this where it outlives the wizard (the dialog's always-mounted shell), because the task
 * outlives the dialog that started it.
 */
export function useCreateVm() {
  const queryClient = useQueryClient();
  const navigate = useNavigate();

  return useMutation({
    mutationFn: (vars: CreateVmVars) => createVm(vars.node, vars.body),
    onSuccess: (result, vars) => {
      const vmid = result.vmid;
      toast.success(`Creating VM ${vmid}…`);
      void queryClient.invalidateQueries({ queryKey: CLUSTER_RESOURCES_QUERY_KEY });

      const finish = () => {
        void queryClient.invalidateQueries({ queryKey: CLUSTER_RESOURCES_QUERY_KEY });
        toast.success(`VM ${vmid} created`);
        void navigate({
          to: '/vm/$node/$type/$vmid',
          params: { node: vars.node, type: 'qemu', vmid: String(vmid) },
          search: { tab: 'summary' },
        });
      };
      const failed = (message: string) => {
        void queryClient.invalidateQueries({ queryKey: CLUSTER_RESOURCES_QUERY_KEY });
        toast.error(`VM ${vmid} could not be created: ${message}`);
      };

      if (USE_FIXTURES) finish();
      else watchTask(queryClient, result.upid, finish, failed);
    },
  });
}

/** The next free VM id, read once when the wizard opens (always fresh: another session may have
 * taken it since). */
export function useNextVmId(enabled: boolean) {
  return useQuery({
    queryKey: ['create', 'nextid'],
    queryFn: getNextId,
    enabled,
    staleTime: 0,
    gcTime: 0,
    retry: false,
  });
}

/** The cluster's nodes for the wizard's node picker. */
export function useCreateNodes(enabled: boolean) {
  return useQuery({
    queryKey: ['create', 'nodes'],
    queryFn: listNodes,
    enabled,
    staleTime: 30_000,
    retry: false,
  });
}

/** The storages on `node` that hold `content` (`iso` for the media picker, `images` for disks). */
export function useNodeStorages(node: string, content: StorageContentKind) {
  return useQuery({
    queryKey: ['create', 'storages', node, content],
    queryFn: () => listStoragesWithContent(node, content),
    enabled: Boolean(node),
    staleTime: 30_000,
    retry: false,
  });
}

/** The ISO images on one storage. */
export function useIsoImages(node: string, storage: string) {
  return useQuery({
    queryKey: ['create', 'isos', node, storage],
    queryFn: () => listIsos(node, storage),
    enabled: Boolean(node && storage),
    staleTime: 30_000,
    retry: false,
  });
}
