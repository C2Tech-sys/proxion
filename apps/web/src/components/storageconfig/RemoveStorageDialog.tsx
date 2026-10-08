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
import { hardwareErrorMessage } from '@/api/hardwareHooks';
import { useRemoveStorage } from '@/api/storageConfigHooks';

export interface RemoveStorageDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  storage: string;
}

/**
 * Confirmation for removing a storage definition: an `AlertDialog` whose destructive confirm only
 * enables once the storage ID is typed exactly (same pattern as `DeleteGuestDialog`). It spells out
 * the consequence: guests and backup jobs that reference the storage lose it, but PVE deletes only
 * the definition, never the data. A server error stays inline and the dialog stays open.
 *
 * Mount it fresh per open (the Storage tab renders it conditionally).
 */
export function RemoveStorageDialog({ open, onOpenChange, storage }: RemoveStorageDialogProps) {
  const mutation = useRemoveStorage();
  const [confirmText, setConfirmText] = useState('');
  const canConfirm = confirmText === storage && !mutation.isPending;

  function confirm() {
    if (!canConfirm) return;
    mutation.mutate(storage, { onSuccess: () => onOpenChange(false) });
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
          <AlertDialogTitle>Remove {storage}?</AlertDialogTitle>
          <AlertDialogDescription>
            Removes the storage definition from Proxmox only; the data on it is not deleted. Guests, backup jobs and
            ISO selections that use it will no longer find it.
          </AlertDialogDescription>
        </AlertDialogHeader>

        <div className="flex flex-col gap-1.5">
          <label htmlFor="remove-storage-confirm" className="text-sm text-muted-foreground">
            Type the storage ID to confirm
          </label>
          <Input
            id="remove-storage-confirm"
            autoFocus
            value={confirmText}
            onChange={(e) => setConfirmText(e.target.value)}
            disabled={mutation.isPending}
            placeholder={storage}
            autoComplete="off"
          />
        </div>

        {mutation.isError && (
          <p role="alert" className="text-xs text-status-error">
            {hardwareErrorMessage(mutation.error, 'The storage could not be removed.')}
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
              confirm();
            }}
          >
            {mutation.isPending && <Loader2 className="size-4 animate-spin" />}
            Remove {storage}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
