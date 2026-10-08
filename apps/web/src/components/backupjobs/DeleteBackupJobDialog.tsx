import { useState } from 'react';
import { Loader2 } from 'lucide-react';

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Input } from '@/components/ui/input';
import { backupJobErrorMessage, useDeleteBackupJob } from '@/api/backupJobsHooks';

export interface DeleteBackupJobDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The job's id, which must be typed to confirm. */
  jobId: string;
}

/**
 * Confirmation for deleting a backup job: an `AlertDialog` whose destructive confirm only enables
 * once the job's id is typed exactly (same pattern as `DeleteGuestDialog`). The job is only the
 * schedule: backups it already made stay on the storage. A server error stays inline and the
 * dialog stays open. Mount it fresh per open.
 */
export function DeleteBackupJobDialog({ open, onOpenChange, jobId }: DeleteBackupJobDialogProps) {
  const mutation = useDeleteBackupJob();
  const [confirmText, setConfirmText] = useState('');
  const canConfirm = confirmText === jobId && !mutation.isPending;

  function handleConfirm() {
    if (!canConfirm) return;
    mutation.mutate(jobId, { onSuccess: () => onOpenChange(false) });
  }

  return (
    <AlertDialog
      open={open}
      onOpenChange={(next) => {
        if (!next && mutation.isPending) return;
        onOpenChange(next);
      }}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete backup job {jobId}?</AlertDialogTitle>
          <AlertDialogDescription>
            The guests it covers are no longer backed up on this schedule; backups it already made stay on the
            storage. This cannot be undone.
          </AlertDialogDescription>
        </AlertDialogHeader>

        <div className="flex flex-col gap-1.5">
          <label htmlFor="delete-backup-job-confirm" className="text-sm text-muted-foreground">
            Type the job ID to confirm
          </label>
          <Input
            id="delete-backup-job-confirm"
            autoFocus
            value={confirmText}
            onChange={(e) => setConfirmText(e.target.value)}
            disabled={mutation.isPending}
            placeholder={jobId}
            autoComplete="off"
            spellCheck={false}
          />
        </div>

        {mutation.isError && (
          <p role="alert" className="text-xs text-status-error">
            {backupJobErrorMessage(mutation.error, 'The backup job could not be deleted.')}
          </p>
        )}

        <AlertDialogFooter>
          <AlertDialogCancel disabled={mutation.isPending}>Cancel</AlertDialogCancel>
          <AlertDialogAction
            variant="destructive"
            disabled={!canConfirm}
            onClick={(event) => {
              // Radix closes an AlertDialogAction on click by default; wait for the request to be
              // accepted instead (and stay open on an error), same convention as the other
              // destructive dialogs.
              event.preventDefault();
              handleConfirm();
            }}
          >
            {mutation.isPending && <Loader2 className="size-4 animate-spin" />}
            Delete job
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
