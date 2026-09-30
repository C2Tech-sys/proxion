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
import { useRemoveUnusedDisk } from '@/api/diskHooks';
import type { GuestType } from '@/api/types';

export interface RemoveUnusedDiskDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  node: string;
  type: GuestType;
  vmid: number;
  /** The unused volume's config key: `unused0`, ... */
  slot: string;
  /** The volume behind it (`tank:vm-100-disk-4`), shown so it is clear what is being destroyed. */
  volume: string | undefined;
}

/**
 * Confirmation for permanently removing an unused disk -- PVE destroys the volume, which cannot be
 * undone. The destructive confirm only enables once the slot name is typed exactly (same pattern
 * as the guest delete dialog's typed VMID). Mount it fresh per open.
 */
export function RemoveUnusedDiskDialog({ open, onOpenChange, node, type, vmid, slot, volume }: RemoveUnusedDiskDialogProps) {
  const mutation = useRemoveUnusedDisk();
  const [confirmText, setConfirmText] = useState('');
  const canConfirm = confirmText === slot && !mutation.isPending;
  const serverError = mutation.isError ? hardwareErrorMessage(mutation.error, 'The disk could not be removed.') : undefined;

  function confirm() {
    if (!canConfirm) return;
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
          <AlertDialogTitle>Remove {slot}?</AlertDialogTitle>
          <AlertDialogDescription>
            This destroys the volume permanently{volume ? ` (${volume})` : ''}. This cannot be undone.
          </AlertDialogDescription>
        </AlertDialogHeader>

        <div className="flex flex-col gap-1.5">
          <label htmlFor="remove-unused-confirm" className="text-sm text-muted-foreground">
            Type {slot} to confirm
          </label>
          <Input
            id="remove-unused-confirm"
            autoFocus
            value={confirmText}
            onChange={(e) => setConfirmText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                confirm();
              }
            }}
            disabled={mutation.isPending}
            placeholder={slot}
            autoComplete="off"
          />
        </div>

        {serverError && (
          <p role="alert" className="text-xs text-status-error">
            {serverError}
          </p>
        )}

        <AlertDialogFooter>
          <AlertDialogCancel disabled={mutation.isPending}>Cancel</AlertDialogCancel>
          <AlertDialogAction
            variant="destructive"
            disabled={!canConfirm}
            onClick={(event) => {
              // Wait for the request rather than closing at once, same as `DeleteGuestDialog`.
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
