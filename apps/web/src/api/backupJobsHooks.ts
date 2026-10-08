import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';

import { GuestActionError } from '@/api/actions';
import { TASKS_QUERY_KEY } from '@/api/liveState';
import {
  createBackupJob,
  deleteBackupJob,
  getBackupJobs,
  getBackupStorages,
  getIncludedVolumes,
  getPools,
  runBackupJob,
  updateBackupJob,
  type BackupJobCreateBody,
  type BackupJobUpdateBody,
} from '@/api/backupJobs';

export const BACKUP_JOBS_QUERY_KEY = ['backup-jobs'] as const;

/** The server's message for a failed backup-job request (an inline dialog error or a toast). */
export function backupJobErrorMessage(error: unknown, fallback: string): string {
  return error instanceof GuestActionError ? error.message : fallback;
}

/** The cluster's vzdump jobs (`GET /cluster/backup`). */
export function useBackupJobs() {
  return useQuery({
    queryKey: BACKUP_JOBS_QUERY_KEY,
    queryFn: getBackupJobs,
    staleTime: 15_000,
  });
}

/** The guests/volumes a job covers; only fetched while the sheet is open. */
export function useIncludedVolumes(id: string | undefined) {
  return useQuery({
    queryKey: ['backup-job-volumes', id],
    queryFn: () => getIncludedVolumes(id as string),
    enabled: id !== undefined,
    staleTime: 0,
    gcTime: 0,
    retry: false,
  });
}

/** Storages that can hold backups, for the job dialog's picker. `retry: false`: the dialog shows
 * an inline message instead of waiting on a failing lookup. */
export function useBackupStorages() {
  return useQuery({
    queryKey: ['backup-storages'],
    queryFn: getBackupStorages,
    staleTime: 5 * 60 * 1000,
    retry: false,
  });
}

/** Resource pools, for the job dialog's pool picker (falls back to a text field when unreadable). */
export function usePools() {
  return useQuery({
    queryKey: ['pools'],
    queryFn: getPools,
    staleTime: 5 * 60 * 1000,
    retry: false,
  });
}

/**
 * Creates a job. On success: a "Backup job created" toast and a refreshed job list. On error: no
 * toast here; the dialog shows the server's message inline and stays open (same convention as
 * `useUpsertNic`).
 */
export function useCreateBackupJob() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (body: BackupJobCreateBody) => createBackupJob(body),
    onSuccess: () => {
      toast.success('Backup job created');
      void queryClient.invalidateQueries({ queryKey: BACKUP_JOBS_QUERY_KEY });
    },
  });
}

export interface UpdateBackupJobVars {
  id: string;
  body: BackupJobUpdateBody;
}

/** Edits a job (only the changed keys). Same toast/inline-error convention as `useCreateBackupJob`. */
export function useUpdateBackupJob() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (vars: UpdateBackupJobVars) => updateBackupJob(vars.id, vars.body),
    onSuccess: (_result, vars) => {
      toast.success(`Backup job ${vars.id} saved`);
      void queryClient.invalidateQueries({ queryKey: BACKUP_JOBS_QUERY_KEY });
    },
  });
}

/**
 * The inline Enabled switch: `{ enabled }` only. There is no dialog to show an error in, so a
 * failure is a toast here.
 */
export function useToggleBackupJob() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (vars: { id: string; enabled: boolean }) => updateBackupJob(vars.id, { enabled: vars.enabled }),
    onSuccess: (_result, vars) => {
      toast.success(`Backup job ${vars.id} ${vars.enabled ? 'enabled' : 'disabled'}`);
      void queryClient.invalidateQueries({ queryKey: BACKUP_JOBS_QUERY_KEY });
    },
    onError: (error) => {
      toast.error(backupJobErrorMessage(error, 'The backup job could not be changed.'));
    },
  });
}

/** Deletes a job; the confirm dialog shows a failure inline. */
export function useDeleteBackupJob() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (id: string) => deleteBackupJob(id),
    onSuccess: (_result, id) => {
      toast.success(`Backup job ${id} deleted`);
      void queryClient.invalidateQueries({ queryKey: BACKUP_JOBS_QUERY_KEY });
    },
  });
}

/** "Run now": toasts the number of backup tasks PVE started; a failure is a toast too (no dialog). */
export function useRunBackupJob() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (id: string) => runBackupJob(id),
    onSuccess: (result, id) => {
      const count = result.upids.length;
      toast.success(`Backup job ${id} started (${count} ${count === 1 ? 'task' : 'tasks'})`);
      void queryClient.invalidateQueries({ queryKey: TASKS_QUERY_KEY });
    },
    onError: (error) => {
      toast.error(backupJobErrorMessage(error, 'The backup job could not be started.'));
    },
  });
}
