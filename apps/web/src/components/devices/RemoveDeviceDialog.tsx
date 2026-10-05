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
import { useDeleteDevice } from '@/api/deviceHooks';

export interface RemoveDeviceDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  node: string;
  vmid: number;
  /** The device's config key, e.g. `usb0`. */
  slot: string;
  /** The device's current config value, shown so the user knows what is going away. */
  value: string;
}

/**
 * Small confirmation for removing one USB, PCI or serial device: an `AlertDialog` with a
 * destructive confirm that names the slot and its current value. No typed confirmation -- the
 * device can be added back. A server error stays inline and the dialog stays open.
 *
 * Mount it fresh per open (the Hardware tab renders it conditionally).
 */
export function RemoveDeviceDialog({ open, onOpenChange, node, vmid, slot, value }: RemoveDeviceDialogProps) {
  const mutation = useDeleteDevice();

  function confirm() {
    if (mutation.isPending) return;
    mutation.mutate({ node, vmid, slot }, { onSuccess: () => onOpenChange(false) });
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
          <AlertDialogTitle>Remove {slot}?</AlertDialogTitle>
          <AlertDialogDescription>
            {slot} ({value}) is removed from this VM. A running guest loses it at its next restart.
          </AlertDialogDescription>
        </AlertDialogHeader>

        {mutation.isError && (
          <p role="alert" className="text-xs text-status-error">
            {hardwareErrorMessage(mutation.error, 'The device could not be removed.')}
          </p>
        )}

        <AlertDialogFooter>
          <AlertDialogCancel disabled={mutation.isPending}>Cancel</AlertDialogCancel>
          <AlertDialogAction
            variant="destructive"
            disabled={mutation.isPending}
            onClick={(event) => {
              // Radix closes an AlertDialogAction on click by default; wait for the request to be
              // accepted instead (and stay open on an error), same convention as the other
              // destructive dialogs.
              event.preventDefault();
              confirm();
            }}
          >
            {mutation.isPending && <Loader2 className="size-4 animate-spin" />}
            Remove {slot}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
