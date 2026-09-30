import { useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';

import { CLUSTER_RESOURCES_QUERY_KEY } from '@/api/liveState';
import { addDisk, detachDisk, getStorageFormats, removeUnusedDisk, type AddDiskBody } from '@/api/disks';
import type { GuestType } from '@/api/types';

export interface GuestRef {
  node: string;
  type: GuestType;
  vmid: number;
}

export interface AddDiskVars extends GuestRef {
  body: AddDiskBody;
}

export interface DiskSlotVars extends GuestRef {
  slot: string;
}

/** The guest queries a disk change makes stale (config and pending list), plus the cluster-wide
 * resources query (a new or removed volume changes the storage's used space). */
function invalidateGuest(queryClient: QueryClient, ref: GuestRef): void {
  void queryClient.invalidateQueries({ queryKey: ['vm-config', ref.node, ref.type, ref.vmid] });
  void queryClient.invalidateQueries({ queryKey: ['vm-pending', ref.node, ref.type, ref.vmid] });
  void queryClient.invalidateQueries({ queryKey: CLUSTER_RESOURCES_QUERY_KEY });
}

/**
 * Adds a disk (qemu) or mount point (lxc). On success: a toast naming the slot PVE allocated
 * (plus a restart note when PVE is holding it back) and the guest's queries invalidated. On error:
 * no toast -- the dialog shows the server's message inline and stays open.
 */
export function useAddDisk() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (vars: AddDiskVars) => addDisk(vars.node, vars.type, vars.vmid, vars.body),
    onSuccess: (result, vars) => {
      const what = vars.type === 'lxc' ? 'Mount point' : 'Disk';
      toast.success(
        result.pending.length > 0
          ? `${what} added as ${result.slot}; restart the guest to apply`
          : `${what} added as ${result.slot}`,
      );
      invalidateGuest(queryClient, vars);
    },
  });
}

/** Detaches a disk; PVE keeps the volume as `unused[n]`. The toast names where it went. */
export function useDetachDisk() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (vars: DiskSlotVars) => detachDisk(vars.node, vars.type, vars.vmid, vars.slot),
    onSuccess: (result, vars) => {
      toast.success(
        result.unusedSlot !== undefined
          ? `${vars.slot} detached; kept as ${result.unusedSlot}`
          : `${vars.slot} detached`,
      );
      invalidateGuest(queryClient, vars);
    },
  });
}

/** Permanently removes an unused volume. */
export function useRemoveUnusedDisk() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (vars: DiskSlotVars) => removeUnusedDisk(vars.node, vars.type, vars.vmid, vars.slot),
    onSuccess: (_result, vars) => {
      toast.success(`${vars.slot} removed`);
      invalidateGuest(queryClient, vars);
    },
  });
}

/** The image formats each image-capable storage on the node supports. Near-static, so cached for
 * a while; `retry: false` because the add dialog falls back to inferring them from the storage
 * type instead of waiting on a failing lookup. */
export function useStorageFormats(node: string) {
  return useQuery({
    queryKey: ['storage-formats', node],
    queryFn: () => getStorageFormats(node),
    enabled: Boolean(node),
    staleTime: 10 * 60 * 1000,
    retry: false,
  });
}
