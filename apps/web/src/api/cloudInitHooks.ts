import { useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';

import {
  getCloudInitPending,
  regenerateCloudInit,
  updateCloudInit,
  type CloudInitUpdate,
} from '@/api/cloudInit';

export interface UpdateCloudInitVars {
  node: string;
  vmid: number;
  body: CloudInitUpdate;
}

export interface RegenerateCloudInitVars {
  node: string;
  vmid: number;
}

const PENDING_REFETCH_MS = 15000;

/** The guest queries a cloud-init change can make stale. */
function invalidateGuest(queryClient: QueryClient, node: string, vmid: number): void {
  void queryClient.invalidateQueries({ queryKey: ['vm-config', node, 'qemu', vmid] });
  void queryClient.invalidateQueries({ queryKey: ['vm-pending', node, 'qemu', vmid] });
  void queryClient.invalidateQueries({ queryKey: ['cloudinit-pending', node, vmid] });
}

/** PVE's per-key cloud-init list (values and pending changes) for the Cloud-Init tab's banner. */
export function useCloudInitPending(node: string, vmid: number) {
  return useQuery({
    queryKey: ['cloudinit-pending', node, vmid],
    queryFn: () => getCloudInitPending(node, vmid),
    enabled: Boolean(node && vmid),
    refetchInterval: PENDING_REFETCH_MS,
  });
}

/**
 * Changes cloud-init settings (`src/api/cloudInit.ts`). On success: a "Cloud-Init settings saved"
 * toast -- with a "regenerate the image to apply" hint when PVE holds changes back -- and
 * invalidates this guest's config/cloud-init queries. On error: no toast here; the dialog shows
 * the server's message inline and stays open, same convention as `useUpsertNic`. The toast never
 * mentions what was changed, so a password cannot leak into it.
 */
export function useUpdateCloudInit() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (vars: UpdateCloudInitVars) => updateCloudInit(vars.node, vars.vmid, vars.body),
    onSuccess: (result, vars) => {
      toast.success(
        result.pending.length > 0
          ? 'Cloud-Init settings saved; regenerate the image to apply them'
          : 'Cloud-Init settings saved',
      );
      invalidateGuest(queryClient, vars.node, vars.vmid);
    },
  });
}

/** Regenerates the guest's cloud-init image. */
export function useRegenerateCloudInit() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (vars: RegenerateCloudInitVars) => regenerateCloudInit(vars.node, vars.vmid),
    onSuccess: (_result, vars) => {
      toast.success('Cloud-Init image regenerated');
      invalidateGuest(queryClient, vars.node, vars.vmid);
    },
    onError: (error) => {
      toast.error(error instanceof Error ? error.message : 'The Cloud-Init image could not be regenerated');
    },
  });
}
