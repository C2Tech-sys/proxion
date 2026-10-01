import { useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';

import { CLUSTER_RESOURCES_QUERY_KEY } from '@/api/liveState';
import { getBridges, getNextNicSlot, deleteNic, upsertNic, type NicBody } from '@/api/network';
import type { GuestType } from '@/api/types';

export interface UpsertNicVars {
  node: string;
  type: GuestType;
  vmid: number;
  /** `net0`, `net2`, ... */
  slot: string;
  body: NicBody;
}

export interface DeleteNicVars {
  node: string;
  type: GuestType;
  vmid: number;
  slot: string;
}

/** The guest queries a network change can make stale. */
function invalidateGuest(queryClient: QueryClient, node: string, type: GuestType, vmid: number): void {
  void queryClient.invalidateQueries({ queryKey: ['vm-config', node, type, vmid] });
  void queryClient.invalidateQueries({ queryKey: ['vm-pending', node, type, vmid] });
  void queryClient.invalidateQueries({ queryKey: ['nic-next-slot', node, type, vmid] });
  void queryClient.invalidateQueries({ queryKey: CLUSTER_RESOURCES_QUERY_KEY });
}

/**
 * Creates or edits one network device (`src/api/network.ts`). On success: a "Network device net0
 * saved" toast -- with "; restart the guest to apply" when PVE holds the change back -- and
 * invalidates this guest's config/pending queries plus the cluster-wide resources query. On error:
 * no toast here; the dialog shows the server's message inline and stays open, same convention as
 * `useUpdateHardware`.
 */
export function useUpsertNic() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (vars: UpsertNicVars) => upsertNic(vars.node, vars.type, vars.vmid, vars.slot, vars.body),
    onSuccess: (result, vars) => {
      toast.success(
        result.pending.length > 0
          ? `Network device ${vars.slot} saved; restart the guest to apply`
          : `Network device ${vars.slot} saved`,
      );
      invalidateGuest(queryClient, vars.node, vars.type, vars.vmid);
    },
  });
}

/** Removes one network device. Same toast/invalidation convention as `useUpsertNic`. */
export function useDeleteNic() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (vars: DeleteNicVars) => deleteNic(vars.node, vars.type, vars.vmid, vars.slot),
    onSuccess: (result, vars) => {
      toast.success(
        result.pending.length > 0
          ? `Network device ${vars.slot} removed; restart the guest to apply`
          : `Network device ${vars.slot} removed`,
      );
      invalidateGuest(queryClient, vars.node, vars.type, vars.vmid);
    },
  });
}

/** The node's bridges for the NIC dialog's picker. Near-static, so cached for a while;
 * `retry: false` because the dialog falls back to a free-text field instead of waiting on a
 * failing lookup. */
export function useBridges(node: string) {
  return useQuery({
    queryKey: ['bridges', node],
    queryFn: () => getBridges(node),
    enabled: Boolean(node),
    staleTime: 5 * 60 * 1000,
    retry: false,
  });
}

/** The lowest unused `net<n>` slot, for the "Add network device" dialog. Always re-read (a slot
 * may have been taken since the last open); disabled unless `enabled`. */
export function useNextNicSlot(node: string, type: GuestType, vmid: number, enabled = true) {
  return useQuery({
    queryKey: ['nic-next-slot', node, type, vmid],
    queryFn: () => getNextNicSlot(node, type, vmid),
    enabled: enabled && Boolean(node && type && vmid),
    staleTime: 0,
    gcTime: 0,
    retry: false,
  });
}
