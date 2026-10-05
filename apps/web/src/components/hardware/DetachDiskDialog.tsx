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
import { useDetachDisk } from '@/api/diskHooks';
import type { GuestType } from '@/api/types';

export interface DetachDiskDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  node: string;
  type: GuestType;
  vmid: number;
  /** The disk's config key: `scsi1`, `mp0`, ... */
  slot: string;
  /** The drive's volume reference: `<storage>:<volume>`-style, or a host path (starts with `/`) for a
   * container bind mount, which has no volume and so leaves no `unused[n]` behind. */
  volume: string;
  /** The `unused[n]` key PVE will most likely park the volume under (the lowest free one). */
  nextUnusedSlot: string;
}

/**
 * Confirmation for detaching a disk. Nothing is destroyed: PVE keeps the volume as `unused[n]`,
 * from where it can be removed for good (or re-attached in PVE's own UI). Mount it fresh per open
 * (the Hardware tab renders it conditionally).
 */
export function DetachDiskDialog({ open, onOpenChange, node, type, vmid, slot, volume, nextUnusedSlot }: DetachDiskDialogProps) {
  const isBindMount = volume.startsWith('/');
  const mutation = useDetachDisk();
  const serverError = mutation.isError ? hardwareErrorMessage(mutation.error, 'The disk could not be detached.') : undefined;

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
          <AlertDialogTitle>Detach {slot}?</AlertDialogTitle>
          <AlertDialogDescription>
            Detach {slot}?{' '}
            {isBindMount
              ? 'A bind mount has no volume; the mount point is simply removed from the container.'
              : `The disk is kept as ${nextUnusedSlot} until you remove it.`}
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
            Detach
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
