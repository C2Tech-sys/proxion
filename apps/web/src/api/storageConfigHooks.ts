import { useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';

import { CLUSTER_RESOURCES_QUERY_KEY } from '@/api/liveState';
import {
  addStorage,
  editStorage,
  getStorageConfigs,
  removeStorage,
  scanStorage,
  type ScanRequest,
  type StorageAddBody,
  type StorageEditBody,
} from '@/api/storageConfig';

export const STORAGE_CONFIGS_QUERY_KEY = ['storage-configs'] as const;

export interface EditStorageVars {
  storage: string;
  body: StorageEditBody;
}

/** What a storage-definition change can make stale: the definitions and the cluster-wide
 * resources (which carry each storage's per-node status). */
function invalidateStorage(queryClient: QueryClient): void {
  void queryClient.invalidateQueries({ queryKey: STORAGE_CONFIGS_QUERY_KEY });
  void queryClient.invalidateQueries({ queryKey: CLUSTER_RESOURCES_QUERY_KEY });
}

/** The storage definitions (`GET /storage`). */
export function useStorageConfigs() {
  return useQuery({
    queryKey: STORAGE_CONFIGS_QUERY_KEY,
    queryFn: getStorageConfigs,
    staleTime: 30 * 1000,
  });
}

/** Adds a storage. On success: a toast and a refresh. On error: no toast; the dialog shows the
 * server's message inline and stays open (same convention as `useUpsertNic`). */
export function useAddStorage() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: StorageAddBody) => addStorage(body),
    onSuccess: (_result, body) => {
      toast.success(`Storage ${body.storage} added`);
      invalidateStorage(queryClient);
    },
  });
}

/** Edits a storage definition. Same toast/invalidation convention as `useAddStorage`. */
export function useEditStorage() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (vars: EditStorageVars) => editStorage(vars.storage, vars.body),
    onSuccess: (_result, vars) => {
      toast.success(`Storage ${vars.storage} updated`);
      invalidateStorage(queryClient);
    },
  });
}

/** Removes a storage definition (never the data on it). */
export function useRemoveStorage() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (storage: string) => removeStorage(storage),
    onSuccess: (_result, storage) => {
      toast.success(`Storage ${storage} removed from Proxmox`);
      invalidateStorage(queryClient);
    },
  });
}

/** A scan button's request (NFS exports, CIFS shares, ZFS pools, LVM groups / thin pools). */
export function useStorageScan() {
  return useMutation({ mutationFn: (request: ScanRequest) => scanStorage(request) });
}
