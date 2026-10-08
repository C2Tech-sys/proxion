import { useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';

import { USE_FIXTURES } from '@/api/client';
import { GuestActionError } from '@/api/actions';
import { TASKS_QUERY_KEY } from '@/api/liveState';
import {
  applyNodeNetwork,
  createNodeNetIface,
  deleteNodeNetIface,
  getNodeNetwork,
  revertNodeNetwork,
  updateNodeNetIface,
  type CreateNetBody,
  type UpdateNetBody,
} from '@/api/nodeNetwork';
import type { PveTask } from '@/api/types';

/** Not `['node-network', node]`: the node Summary tab's `useNodeNetwork` (`hooks.ts`) caches a
 * different shape under that key. */
export const nodeNetworkQueryKey = (node: string) => ['node-network-config', node] as const;

function invalidateNetwork(queryClient: QueryClient, node: string): void {
  void queryClient.invalidateQueries({ queryKey: nodeNetworkQueryKey(node) });
  // The Summary tab's interface list and the NIC dialog's bridge picker read the same node config.
  void queryClient.invalidateQueries({ queryKey: ['node-network', node] });
  void queryClient.invalidateQueries({ queryKey: ['bridges', node] });
}

/** The server's message for a failed network write (dialogs show it inline). */
export function nodeNetworkErrorMessage(error: unknown, fallback: string): string {
  return error instanceof GuestActionError ? error.message : fallback;
}

/** The node's interfaces plus the pending `changes` diff. Always re-read on mount: a stale
 * "nothing pending" next to an Apply button would be misleading. */
export function useNodeNetworkConfig(node: string) {
  return useQuery({
    queryKey: nodeNetworkQueryKey(node),
    queryFn: () => getNodeNetwork(node),
    enabled: Boolean(node),
    staleTime: 0,
    retry: false,
  });
}

export interface CreateNodeIfaceVars {
  node: string;
  body: CreateNetBody;
}

/** Stages a new interface. Toast + refetch on success; on error no toast -- the dialog shows the
 * server's message inline and stays open, same convention as `useUpsertNic`. */
export function useCreateNodeIface() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (vars: CreateNodeIfaceVars) => createNodeNetIface(vars.node, vars.body),
    onSuccess: (_result, vars) => {
      toast.success(`${vars.body.iface} created; apply the configuration to activate it`);
      invalidateNetwork(queryClient, vars.node);
    },
  });
}

export interface UpdateNodeIfaceVars {
  node: string;
  iface: string;
  body: UpdateNetBody;
}

export function useUpdateNodeIface() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (vars: UpdateNodeIfaceVars) => updateNodeNetIface(vars.node, vars.iface, vars.body),
    onSuccess: (_result, vars) => {
      toast.success(`${vars.iface} saved; apply the configuration to activate it`);
      invalidateNetwork(queryClient, vars.node);
    },
  });
}

export interface DeleteNodeIfaceVars {
  node: string;
  iface: string;
}

export function useDeleteNodeIface() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (vars: DeleteNodeIfaceVars) => deleteNodeNetIface(vars.node, vars.iface),
    onSuccess: (_result, vars) => {
      toast.success(`${vars.iface} deleted; apply the configuration to activate the change`);
      invalidateNetwork(queryClient, vars.node);
    },
  });
}

/** A short form of a UPID for a toast: `UPID:<node>:<pid>:...` -> `<pid>`. */
function shortUpid(upid: string): string {
  return upid.split(':')[2] ?? upid;
}

/** How long to wait for the apply task to show up finished before giving up on the watch. */
const TASK_WATCH_TIMEOUT_MS = 60_000;

/** Calls `onFinished`/`onFailed` once the shared live `['tasks']` query reports `upid` ended. A
 * deliberate local copy of the (module-private) watcher in `actionHooks.ts`. */
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
 * Applies the staged network configuration. On success: an "Applying ... task <pid>" toast right
 * away, then -- when the task has finished (immediately in fixture mode) -- a refetch and an
 * "applied" toast. A failed task is its own error toast. A request-level error stays inline in
 * the confirmation dialog.
 */
export function useApplyNodeNetwork() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (node: string) => applyNodeNetwork(node),
    onSuccess: (result, node) => {
      toast.success(`Applying network configuration — task ${shortUpid(result.upid)}`);
      invalidateNetwork(queryClient, node);
      const finish = () => {
        invalidateNetwork(queryClient, node);
        toast.success('Network configuration applied');
      };
      if (USE_FIXTURES) finish();
      else {
        watchTask(queryClient, result.upid, finish, (message) => {
          invalidateNetwork(queryClient, node);
          toast.error(message || 'Applying the network configuration failed.');
        });
      }
    },
  });
}

/** Discards the staged configuration. A toast either way (no dialog to show an error in). */
export function useRevertNodeNetwork() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (node: string) => revertNodeNetwork(node),
    onSuccess: (_result, node) => {
      toast.success('Pending network changes reverted');
      invalidateNetwork(queryClient, node);
    },
    onError: (error: unknown) => {
      toast.error(nodeNetworkErrorMessage(error, 'The pending changes could not be reverted.'));
    },
  });
}
