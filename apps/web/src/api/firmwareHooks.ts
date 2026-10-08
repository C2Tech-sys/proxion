import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';

import { USE_FIXTURES } from '@/api/client';
import { CLUSTER_RESOURCES_QUERY_KEY } from '@/api/liveState';
import { useClusterResources } from '@/api/hooks';
import { useStoragePermissions } from '@/api/actionHooks';
import { diskCapableStorages, type DiskStorage } from '@/api/disks';
import { getFirmwareFixturePending, getQemuMachines, updateFirmware, type FirmwareBody } from '@/api/firmware';

export interface FirmwareUpdateVars {
  node: string;
  vmid: number;
  body: FirmwareBody;
}

/**
 * Requests one firmware edit (`src/api/firmware.ts`). On success: a "Hardware updated" toast --
 * or, when PVE is holding keys back until the guest restarts, "Hardware updated; restart the guest
 * to apply: bios, machine" -- and invalidates this guest's config, pending and status queries plus
 * the cluster resources. On error: no toast here; every dialog shows the server's message inline
 * and stays open, same convention as `useUpdateHardware`.
 */
export function useUpdateFirmware() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (vars: FirmwareUpdateVars) => updateFirmware(vars.node, vars.vmid, vars.body),
    onSuccess: (result, vars) => {
      toast.success(
        result.pending.length > 0
          ? `Hardware updated; restart the guest to apply: ${result.pending.join(', ')}`
          : 'Hardware updated',
      );
      void queryClient.invalidateQueries({ queryKey: ['vm-config', vars.node, 'qemu', vars.vmid] });
      void queryClient.invalidateQueries({ queryKey: ['vm-pending', vars.node, 'qemu', vars.vmid] });
      void queryClient.invalidateQueries({ queryKey: ['vm-firmware-pending', vars.vmid] });
      void queryClient.invalidateQueries({ queryKey: ['vm-status', vars.node, 'qemu', vars.vmid] });
      void queryClient.invalidateQueries({ queryKey: CLUSTER_RESOURCES_QUERY_KEY });
    },
  });
}

/** The machine types the node's PVE offers. Near-static, so cached for a while; `retry: false`
 * because the machine dialog falls back to "Latest (default)" instead of waiting on a failing
 * lookup. */
export function useQemuMachines(node: string) {
  return useQuery({
    queryKey: ['qemu-machines', node],
    queryFn: () => getQemuMachines(node),
    enabled: Boolean(node),
    staleTime: 60 * 60 * 1000,
    retry: false,
  });
}

/** Demo mode only: the config keys a firmware edit is holding back for a running guest. Against a
 * real PVE host the tab's own pending query already carries them, so this stays disabled. */
export function useFirmwareFixturePending(vmid: number): string[] {
  const query = useQuery({
    queryKey: ['vm-firmware-pending', vmid],
    queryFn: () => getFirmwareFixturePending(vmid),
    enabled: USE_FIXTURES && Boolean(vmid),
  });
  return query.data ?? [];
}

/** The storage an EFI disk / TPM state is created on, with the caller's allocate right on it. */
export interface StorageChoice {
  storages: DiskStorage[];
  selected: DiskStorage | undefined;
  setChoice: (id: string) => void;
  /** Whether the caller holds `Datastore.AllocateSpace` on the selected storage (`false` while the
   * answer is still loading, so the action stays disabled until it is known). */
  canAllocate: boolean;
}

/** The node's image-capable storages and the user's pick among them (the first one by default),
 * plus the `Datastore.AllocateSpace` check on the picked one. */
export function useStorageChoice(node: string): StorageChoice {
  const resources = useClusterResources();
  const storages = useMemo(() => diskCapableStorages(resources.data, node, 'qemu'), [resources.data, node]);
  const [choice, setChoice] = useState('');
  const selected = storages.find((s) => s.id === choice) ?? storages[0];
  const permissions = useStoragePermissions(selected?.id ?? '');
  return {
    storages,
    selected,
    setChoice,
    canAllocate: permissions.data?.can('Datastore.AllocateSpace') === true,
  };
}
