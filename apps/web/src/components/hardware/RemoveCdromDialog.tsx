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
import { hardwareErrorMessage } from '@/api/hardwareHooks';
import { useRemoveCdrom } from '@/api/diskHooks';
import type { GuestType } from '@/api/types';

export interface RemoveCdromDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  node: string;
  type: GuestType;
  vmid: number;
  /** The drive's config key, e.g. `ide2`. */
  slot: string;
}

/**
 * Confirmation (not typed) for removing a CD/DVD drive. Nothing is destroyed: the ISO file stays
 * on its storage and only the drive leaves this VM's config. Mount it fresh per open (the Hardware
 * tab renders it conditionally).
 */
export function RemoveCdromDialog({ open, onOpenChange, node, type, vmid, slot }: RemoveCdromDialogProps) {
  const mutation = useRemoveCdrom();
  const serverError = mutation.isError
    ? hardwareErrorMessage(mutation.error, 'The CD/DVD drive could not be removed.')
    : undefined;

  function confirm() {
    if (mutation.isPending) return;
    mutation.mutate({ node, type, vmid, slot }, { onSuccess: () => onOpenChange(false) });
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
          <AlertDialogTitle>Remove CD/DVD drive {slot}?</AlertDialogTitle>
          <AlertDialogDescription>
            The ISO file stays on its storage; only the drive is removed from this VM.
          </AlertDialogDescription>
        </AlertDialogHeader>

        {serverError && (
          <p role="alert" className="text-xs text-status-error">
            {serverError}
          </p>
        )}

        <AlertDialogFooter>
          <AlertDialogCancel disabled={mutation.isPending}>Cancel</AlertDialogCancel>
          <AlertDialogAction
            disabled={mutation.isPending}
            onClick={(event) => {
              // Radix closes the dialog on click by default; wait for the request instead (and
              // stay open on an error), same convention as the other confirm dialogs.
              event.preventDefault();
              confirm();
            }}
          >
            {mutation.isPending && <Loader2 className="size-4 animate-spin" />}
            Remove
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
