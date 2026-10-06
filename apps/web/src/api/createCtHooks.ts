import { useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { toast } from 'sonner';

import { GuestActionError } from '@/api/actions';
import { USE_FIXTURES } from '@/api/client';
import { createCt, type CreateCtBody } from '@/api/createCt';
import { getNextId, listContainerTemplates, listNodes, listStoragesWithContent } from '@/api/create';
import type { StorageContentKind } from '@/api/disks';
import { CLUSTER_RESOURCES_QUERY_KEY, TASKS_QUERY_KEY } from '@/api/liveState';
import type { PveTask } from '@/api/types';

/** How long to keep waiting for the create task before giving up on it (the container then simply
 * shows up in the inventory when the live feed catches up). */
const TASK_WATCH_TIMEOUT_MS = 5 * 60_000;

/**
 * Calls `onFinished` / `onFailed` once the live `['tasks']` query shows `upid` with an end time (PVE
 * reports `"OK"` on success, anything else is the error text). A no-op in fixture mode, which has no
 * task feed. Same approach as `watchTaskCompletion` in `actionHooks.ts` (module-private there).
 */
function watchTask(
  queryClient: QueryClient,
  upid: string,
  onFinished: () => void,
  onFailed: (message: string) => void,
): void {
  if (USE_FIXTURES) return;
  const stop = queryClient.getQueryCache().subscribe((event) => {
    const key = event.query.queryKey;
    if (key.length !== TASKS_QUERY_KEY.length || key[0] !== TASKS_QUERY_KEY[0]) return;
    const task = queryClient.getQueryData<PveTask[]>(TASKS_QUERY_KEY)?.find((t) => t.upid === upid);
    if (task === undefined || task.endtime === undefined) return;
    clearTimeout(timeout);
    stop();
    if (task.status !== undefined && task.status !== 'OK') onFailed(task.status);
    else onFinished();
  });
  const timeout = setTimeout(stop, TASK_WATCH_TIMEOUT_MS);
}

export interface CreateCtVars {
  node: string;
  body: CreateCtBody;
}

/**
 * Creates a container (`src/api/createCt.ts`). On success: a "Creating container <hostname>
 * (<vmid>)..." toast right away, then (once the create task finishes -- immediately in fixture
 * mode) invalidates the cluster resources, navigates to the new container's Summary tab and toasts
 * "Container <vmid> created". A create task that ends with an error is reported as its own error
 * toast. On a request-level error: no toast here -- the wizard shows the server's message inline
 * and stays open, same convention as `useUpsertNic`.
 */
export function useCreateCt() {
  const queryClient = useQueryClient();
  const navigate = useNavigate();

  return useMutation({
    mutationFn: (vars: CreateCtVars) => createCt(vars.node, vars.body),
    onSuccess: (result, vars) => {
      toast.success(`Creating container ${vars.body.hostname} (${result.vmid})…`);
      const finish = () => {
        void queryClient.invalidateQueries({ queryKey: CLUSTER_RESOURCES_QUERY_KEY });
        void navigate({
          to: '/vm/$node/$type/$vmid',
          params: { node: vars.node, type: 'lxc', vmid: String(result.vmid) },
          search: { tab: 'summary' },
        });
        toast.success(`Container ${result.vmid} created`);
      };
      if (USE_FIXTURES) {
        finish();
      } else {
        watchTask(queryClient, result.upid, finish, (message) => {
          void queryClient.invalidateQueries({ queryKey: CLUSTER_RESOURCES_QUERY_KEY });
          toast.error(message || 'The container create task failed.');
        });
      }
    },
  });
}

/** The server's message for a failed create, or `fallback`. */
export function createCtErrorMessage(error: unknown, fallback: string): string {
  return error instanceof GuestActionError ? error.message : fallback;
}

/** The next free CT ID, read once per wizard open (never refetched under the user's hands: a
 * refetch would change the prefilled id while they fill in the other steps). */
export function useCreateNextId(enabled = true) {
  return useQuery({
    queryKey: ['create-nextid'],
    queryFn: () => getNextId(),
    enabled,
    staleTime: Infinity,
    gcTime: 0,
    retry: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });
}

/** The cluster's nodes, for the General step's node picker. */
export function useCreateNodes() {
  return useQuery({ queryKey: ['create-nodes'], queryFn: () => listNodes(), staleTime: 30_000, retry: false });
}

/** The storages on `node` that can hold `content` (`vztmpl` for templates, `rootdir` for the root disk). */
export function useCreateStorages(node: string, content: StorageContentKind) {
  return useQuery({
    queryKey: ['create-storages', node, content],
    queryFn: () => listStoragesWithContent(node, content),
    enabled: Boolean(node),
    staleTime: 30_000,
    retry: false,
  });
}

/** The container templates on one storage, sorted by name by the caller. */
export function useContainerTemplates(node: string, storage: string) {
  return useQuery({
    queryKey: ['create-templates', node, storage],
    queryFn: () => listContainerTemplates(node, storage),
    enabled: Boolean(node && storage),
    staleTime: 30_000,
    retry: false,
  });
}
