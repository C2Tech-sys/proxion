import { Loader2, Trash2 } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
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
import { useDeleteNic } from '@/api/networkHooks';
import type { GuestType } from '@/api/types';

export interface RemoveNicButtonProps {
  /** The device's config key, e.g. `net0` -- becomes the accessible name "Remove net0". */
  slot: string;
  /** When set, the button is disabled and this is its tooltip (same wording as the edit pencils). */
  disabledReason?: string | undefined;
  onClick: () => void;
}

/** The per-row trash action on a NIC row, gated by the caller like `EditHardwareButton`. */
export function RemoveNicButton({ slot, disabledReason, onClick }: RemoveNicButtonProps) {
  const name = `Remove ${slot}`;

  if (disabledReason !== undefined) {
    return (
      <Button
        variant="ghost"
        size="icon"
        className="size-7 shrink-0"
        disabled
        aria-disabled="true"
        aria-label={name}
        title={disabledReason}
      >
        <Trash2 className="size-3.5" />
      </Button>
    );
  }

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className="size-7 shrink-0 text-destructive hover:text-destructive"
          aria-label={name}
          onClick={onClick}
        >
          <Trash2 className="size-3.5" />
        </Button>
      </TooltipTrigger>
      <TooltipContent>{name}</TooltipContent>
    </Tooltip>
  );
}

export interface RemoveNicDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  node: string;
  type: GuestType;
  vmid: number;
  /** The device's config key, e.g. `net0`. */
  slot: string;
}

/**
 * Small confirmation for removing one network device: an `AlertDialog` with a destructive confirm.
 * No typed confirmation -- the device can be added back -- but the guest loses the interface (and,
 * for a qemu VM, its MAC address) immediately or at the next restart. A server error stays inline
 * and the dialog stays open.
 *
 * Mount it fresh per open (the Hardware tab renders it conditionally).
 */
export function RemoveNicDialog({ open, onOpenChange, node, type, vmid, slot }: RemoveNicDialogProps) {
  const mutation = useDeleteNic();

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
          <AlertDialogTitle>Remove {slot}?</AlertDialogTitle>
          <AlertDialogDescription>The guest loses this interface.</AlertDialogDescription>
        </AlertDialogHeader>

        {mutation.isError && (
          <p role="alert" className="text-xs text-status-error">
            {hardwareErrorMessage(mutation.error, 'The network device could not be removed.')}
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
