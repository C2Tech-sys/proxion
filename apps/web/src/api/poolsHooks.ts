import { useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';

import { CLUSTER_RESOURCES_QUERY_KEY } from '@/api/liveState';
import { createPool, deletePool, getPools, updatePool, type PoolUpdateBody } from '@/api/pools';

export const POOLS_QUERY_KEY = ['pools'] as const;

export interface CreatePoolVars {
  poolid: string;
  comment?: string;
}

export interface UpdatePoolVars {
  poolid: string;
  body: PoolUpdateBody;
}

/** A pool change can move guests/storages between pools, which the cluster resources report. */
function invalidatePools(queryClient: QueryClient): void {
  void queryClient.invalidateQueries({ queryKey: POOLS_QUERY_KEY });
  void queryClient.invalidateQueries({ queryKey: CLUSTER_RESOURCES_QUERY_KEY });
}

/** The pools with their members. */
export function usePools() {
  return useQuery({ queryKey: POOLS_QUERY_KEY, queryFn: getPools, staleTime: 30 * 1000 });
}

/** Creates a pool. On error: no toast; the dialog shows the server's message inline. */
export function useCreatePool() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (vars: CreatePoolVars) => createPool(vars.poolid, vars.comment),
    onSuccess: (_result, vars) => {
      toast.success(`Pool ${vars.poolid} created`);
      invalidatePools(queryClient);
    },
  });
}

/** Changes a pool's comment or members. */
export function useUpdatePool() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (vars: UpdatePoolVars) => updatePool(vars.poolid, vars.body),
    onSuccess: (_result, vars) => {
      const members = vars.body.vms !== undefined || vars.body.storage !== undefined;
      toast.success(
        members
          ? vars.body.remove === true
            ? `Removed members from pool ${vars.poolid}`
            : `Added members to pool ${vars.poolid}`
          : `Pool ${vars.poolid} updated`,
      );
      invalidatePools(queryClient);
    },
  });
}

/** Deletes an empty pool. */
export function useDeletePool() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (poolid: string) => deletePool(poolid),
    onSuccess: (_result, poolid) => {
      toast.success(`Pool ${poolid} deleted`);
      invalidatePools(queryClient);
    },
  });
}
