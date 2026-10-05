import { Loader2 } from 'lucide-react';

import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import { hardwareErrorMessage } from '@/api/hardwareHooks';
import { useNextDeviceSlot, useUpsertDevice } from '@/api/deviceHooks';

export interface AddSerialDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  node: string;
  vmid: number;
}

/**
 * Confirmation for adding a serial port: the only kind offered is a socket (a host device path
 * such as /dev/ttyS0 is root-only in Proxmox). Asks the server for the next free `serial<n>` slot.
 *
 * Mount it fresh per open (the Hardware tab renders it conditionally).
 */
export function AddSerialDialog({ open, onOpenChange, node, vmid }: AddSerialDialogProps) {
  const mutation = useUpsertDevice();
  const nextSlot = useNextDeviceSlot(node, vmid, 'serial');
  const slot = nextSlot.data;

  function confirm() {
    if (slot === undefined || mutation.isPending) return;
    mutation.mutate(
      { node, vmid, slot, body: { kind: 'serial', target: 'socket' } },
      { onSuccess: () => onOpenChange(false) },
    );
  }

  const slotError = nextSlot.isError ? hardwareErrorMessage(nextSlot.error, 'No free serial port was found.') : undefined;

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
          <AlertDialogTitle>Add serial port</AlertDialogTitle>
          <AlertDialogDescription>
            {slot !== undefined ? `Add ${slot} as a socket` : 'Add a serial port as a socket'}
            . The guest sees a serial port; Proxmox exposes it as a socket the console can attach to. A running
            guest needs a restart to see it.
          </AlertDialogDescription>
        </AlertDialogHeader>

        {slotError && (
          <p role="alert" className="text-xs text-status-error">
            {slotError}
          </p>
        )}
        {mutation.isError && (
          <p role="alert" className="text-xs text-status-error">
            {hardwareErrorMessage(mutation.error, 'The serial port could not be added.')}
          </p>
        )}

        <AlertDialogFooter>
          <AlertDialogCancel disabled={mutation.isPending}>Cancel</AlertDialogCancel>
          <Button onClick={confirm} disabled={slot === undefined || mutation.isPending}>
            {mutation.isPending && <Loader2 className="size-4 animate-spin" />}
            Add serial port
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
