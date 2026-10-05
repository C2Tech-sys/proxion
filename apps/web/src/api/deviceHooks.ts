import { useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';

import { CLUSTER_RESOURCES_QUERY_KEY } from '@/api/liveState';
import {
  deleteDevice,
  getNextDeviceSlot,
  listHostPci,
  listHostUsb,
  listPciMappings,
  listUsbMappings,
  upsertDevice,
  type DeviceBody,
} from '@/api/devices';
import type { DeviceKind } from '@/lib/pve-config';

export interface UpsertDeviceVars {
  node: string;
  vmid: number;
  /** `usb0`, `hostpci1`, `serial0`, ... */
  slot: string;
  body: DeviceBody;
}

export interface DeleteDeviceVars {
  node: string;
  vmid: number;
  slot: string;
}

/** The guest queries a device change can make stale. */
function invalidateGuest(queryClient: QueryClient, node: string, vmid: number): void {
  void queryClient.invalidateQueries({ queryKey: ['vm-config', node, 'qemu', vmid] });
  void queryClient.invalidateQueries({ queryKey: ['vm-pending', node, 'qemu', vmid] });
  void queryClient.invalidateQueries({ queryKey: ['device-next-slot', node, vmid] });
  void queryClient.invalidateQueries({ queryKey: CLUSTER_RESOURCES_QUERY_KEY });
}

/**
 * Creates or edits one device (`src/api/devices.ts`). On success: a "Device usb0 saved" toast --
 * with "; restart the guest to apply" when PVE holds the change back -- and invalidates this
 * guest's config/pending queries plus the cluster-wide resources query. On error: no toast here;
 * the dialog shows the server's message inline and stays open, same convention as `useUpsertNic`.
 */
export function useUpsertDevice() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (vars: UpsertDeviceVars) => upsertDevice(vars.node, vars.vmid, vars.slot, vars.body),
    onSuccess: (result, vars) => {
      toast.success(
        result.pending.length > 0 ? `Device ${vars.slot} saved; restart the guest to apply` : `Device ${vars.slot} saved`,
      );
      invalidateGuest(queryClient, vars.node, vars.vmid);
    },
  });
}

/** Removes one device. Same toast/invalidation convention as `useUpsertDevice`. */
export function useDeleteDevice() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (vars: DeleteDeviceVars) => deleteDevice(vars.node, vars.vmid, vars.slot),
    onSuccess: (result, vars) => {
      toast.success(
        result.pending.length > 0
          ? `Device ${vars.slot} removed; restart the guest to apply`
          : `Device ${vars.slot} removed`,
      );
      invalidateGuest(queryClient, vars.node, vars.vmid);
    },
  });
}

/** The lowest unused slot of `kind`, for the "Add" dialogs. Always re-read (a slot may have been
 * taken since the last open); disabled unless `enabled`. */
export function useNextDeviceSlot(node: string, vmid: number, kind: DeviceKind, enabled = true) {
  return useQuery({
    queryKey: ['device-next-slot', node, vmid, kind],
    queryFn: () => getNextDeviceSlot(node, vmid, kind),
    enabled: enabled && Boolean(node && vmid),
    staleTime: 0,
    gcTime: 0,
    retry: false,
  });
}

// The four lookups below are near-static and PVE may refuse them (403): `retry: false` so the
// dialog falls back to manual entry instead of waiting on a failing lookup.

export function useHostUsb(node: string) {
  return useQuery({
    queryKey: ['host-usb', node],
    queryFn: () => listHostUsb(node),
    enabled: Boolean(node),
    staleTime: 60 * 1000,
    retry: false,
  });
}

export function useHostPci(node: string) {
  return useQuery({
    queryKey: ['host-pci', node],
    queryFn: () => listHostPci(node),
    enabled: Boolean(node),
    staleTime: 60 * 1000,
    retry: false,
  });
}

export function useUsbMappings() {
  return useQuery({
    queryKey: ['device-mappings', 'usb'],
    queryFn: () => listUsbMappings(),
    staleTime: 60 * 1000,
    retry: false,
  });
}

export function usePciMappings() {
  return useQuery({
    queryKey: ['device-mappings', 'pci'],
    queryFn: () => listPciMappings(),
    staleTime: 60 * 1000,
    retry: false,
  });
}
