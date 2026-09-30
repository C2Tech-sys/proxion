import { useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';

import { setBootOrder } from '@/api/bootOrder';
import type { GuestType } from '@/api/types';

export interface SetBootOrderVars {
  node: string;
  type: GuestType;
  vmid: number;
  /** The enabled devices in boot priority; `[]` = nothing bootable. */
  order: string[];
}

/**
 * Sets a VM's boot order (`src/api/bootOrder.ts`). On success: a "Boot order updated" toast -- or,
 * when PVE is holding the change back until the guest restarts, "Boot order updated; restart the
 * guest to apply" -- and invalidates this guest's config and pending queries. On error: no toast
 * here; the dialog shows the server's message inline and stays open (same convention as
 * `useUpdateHardware`).
 */
export function useSetBootOrder() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (vars: SetBootOrderVars) => setBootOrder(vars.node, vars.type, vars.vmid, vars.order),
    onSuccess: (result, vars) => {
      toast.success(
        result.pending.length > 0 ? 'Boot order updated; restart the guest to apply' : 'Boot order updated',
      );
      void queryClient.invalidateQueries({ queryKey: ['vm-config', vars.node, vars.type, vars.vmid] });
      void queryClient.invalidateQueries({ queryKey: ['vm-pending', vars.node, vars.type, vars.vmid] });
    },
  });
}
