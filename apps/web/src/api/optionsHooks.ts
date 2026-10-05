import { useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';

import { CLUSTER_RESOURCES_QUERY_KEY } from '@/api/liveState';
import { updateGuestOptions, type OptionsPatch } from '@/api/options';
import type { GuestType } from '@/api/types';

export interface UpdateOptionsVars {
  node: string;
  type: GuestType;
  vmid: number;
  patch: OptionsPatch;
}

/**
 * Requests one guest options edit (`src/api/options.ts`). On success: an "Options saved" toast --
 * with "; restart the guest to apply: agent, tablet" when PVE holds some keys back -- and
 * invalidates this guest's config/pending queries plus the cluster-wide resources query (tags are
 * shown off `/cluster/resources` too). On error: no toast here; the dialog shows the server's
 * message inline and stays open, same convention as `useUpdateHardware`.
 */
export function useUpdateGuestOptions() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (vars: UpdateOptionsVars) => updateGuestOptions(vars.node, vars.type, vars.vmid, vars.patch),
    onSuccess: (result, vars) => {
      toast.success(
        result.pending.length > 0
          ? `Options saved; restart the guest to apply: ${result.pending.join(', ')}`
          : 'Options saved',
      );
      void queryClient.invalidateQueries({ queryKey: ['vm-config', vars.node, vars.type, vars.vmid] });
      void queryClient.invalidateQueries({ queryKey: ['vm-pending', vars.node, vars.type, vars.vmid] });
      void queryClient.invalidateQueries({ queryKey: CLUSTER_RESOURCES_QUERY_KEY });
    },
  });
}
