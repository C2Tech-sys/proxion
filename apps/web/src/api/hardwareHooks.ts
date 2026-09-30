import { useEffect, useRef } from 'react';
import { useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';

import { USE_FIXTURES } from '@/api/client';
import { CLUSTER_RESOURCES_QUERY_KEY } from '@/api/liveState';
import { GuestActionError } from '@/api/actions';
import {
  getCpuModels,
  getPendingConfig,
  resizeDisk,
  updateHardware,
  type HardwarePatch,
  type ResizeDiskBody,
} from '@/api/hardware';
import type { GuestType } from '@/api/types';

export interface HardwareUpdateVars {
  node: string;
  type: GuestType;
  vmid: number;
  patch: HardwarePatch;
}

export interface ResizeDiskVars {
  node: string;
  type: GuestType;
  vmid: number;
  body: ResizeDiskBody;
}

/** The guest queries a hardware change can make stale. */
function invalidateGuest(queryClient: QueryClient, node: string, type: GuestType, vmid: number): void {
  void queryClient.invalidateQueries({ queryKey: ['vm-config', node, type, vmid] });
  void queryClient.invalidateQueries({ queryKey: ['vm-pending', node, type, vmid] });
  void queryClient.invalidateQueries({ queryKey: ['vm-status', node, type, vmid] });
  void queryClient.invalidateQueries({ queryKey: CLUSTER_RESOURCES_QUERY_KEY });
}

/**
 * Requests one guest hardware edit (`src/api/hardware.ts`). On success: a "Hardware updated"
 * toast -- or, when PVE is holding some keys back until the guest restarts, "Hardware updated;
 * restart the guest to apply: memory, cores" -- and invalidates this guest's config, pending and
 * status queries plus the cluster-wide resources query (a memory/core change shows up on
 * `/cluster/resources` too). On error: no toast here; every dialog shows the server's message
 * inline and stays open, same convention as `useUpdateGuestConfig`.
 */
export function useUpdateHardware() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (vars: HardwareUpdateVars) => updateHardware(vars.node, vars.type, vars.vmid, vars.patch),
    onSuccess: (result, vars) => {
      toast.success(
        result.pending.length > 0
          ? `Hardware updated; restart the guest to apply: ${result.pending.join(', ')}`
          : 'Hardware updated',
      );
      invalidateGuest(queryClient, vars.node, vars.type, vars.vmid);
    },
  });
}

/** PVE's resize is an asynchronous task on modern releases (this mutation only gets a UPID
 * back), so the guest's config -- which carries the new `size=` -- is re-read at these delays
 * after the request, on top of the immediate invalidation. (`watchTaskCompletion` lives
 * unexported inside `actionHooks.ts`, which this ticket may not touch, so a short fixed-delay
 * pass stands in for it.) */
const RESIZE_REFETCH_DELAYS_MS = [2000, 6000];

/**
 * Requests one disk grow (`src/api/hardware.ts`). On success: a toast -- "Disk resize requested"
 * while a task is running, "Disk resized" when PVE answered synchronously or in fixture mode --
 * and invalidates this guest's config/pending/status/cluster queries immediately and again at
 * `RESIZE_REFETCH_DELAYS_MS` when a UPID came back. On error: no toast here (the dialog shows the
 * message inline).
 *
 * The delayed invalidations are tracked and cleared when the component that called this hook
 * unmounts, so nothing fires after it is gone. That also means the caller must outlive the
 * resize dialog for them to run: `HardwareTab` owns the hook and hands the mutation to
 * `ResizeDiskDialog`, which unmounts as soon as a resize succeeds.
 */
export function useResizeDisk() {
  const queryClient = useQueryClient();
  const timers = useRef<Set<ReturnType<typeof setTimeout>>>(new Set());

  useEffect(() => {
    const pending = timers.current;
    return () => {
      for (const timer of pending) clearTimeout(timer);
      pending.clear();
    };
  }, []);

  return useMutation({
    mutationFn: (vars: ResizeDiskVars) => resizeDisk(vars.node, vars.type, vars.vmid, vars.body),
    onSuccess: (result, vars) => {
      const asynchronous = result.upid !== undefined && !USE_FIXTURES;
      toast.success(asynchronous ? 'Disk resize requested' : 'Disk resized');
      invalidateGuest(queryClient, vars.node, vars.type, vars.vmid);
      if (asynchronous) {
        for (const delay of RESIZE_REFETCH_DELAYS_MS) {
          const timer = setTimeout(() => {
            timers.current.delete(timer);
            invalidateGuest(queryClient, vars.node, vars.type, vars.vmid);
          }, delay);
          timers.current.add(timer);
        }
      }
    },
  });
}

/** How often the pending list is re-read: quickly in the demo (so stopping the guest clears the
 * banner without a reload), calmly against a real PVE host. */
const PENDING_REFETCH_MS = USE_FIXTURES ? 3000 : 15000;

/** The guest's pending (applied-on-restart) config changes. */
export function usePendingConfig(node: string, type: GuestType, vmid: number) {
  return useQuery({
    queryKey: ['vm-pending', node, type, vmid],
    queryFn: () => getPendingConfig(node, type, vmid),
    enabled: Boolean(node && type && vmid),
    refetchInterval: PENDING_REFETCH_MS,
  });
}

/** The CPU models the node's PVE offers. Near-static, so cached for a while; `retry: false`
 * because the CPU dialog falls back to a built-in list instead of waiting on a failing lookup. */
export function useCpuModels(node: string) {
  return useQuery({
    queryKey: ['cpu-models', node],
    queryFn: () => getCpuModels(node),
    enabled: Boolean(node),
    staleTime: 60 * 60 * 1000,
    retry: false,
  });
}

/** The message a hardware mutation's inline error line shows. */
export function hardwareErrorMessage(error: unknown, fallback: string): string {
  return error instanceof GuestActionError ? error.message : fallback;
}
