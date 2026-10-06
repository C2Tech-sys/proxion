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
import { useConvertToTemplate } from '@/api/actionHooks';
import type { GuestType } from '@/api/types';

export interface ConvertToTemplateDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  node: string;
  type: GuestType;
  vmid: number;
  name: string;
  status: string;
}

/**
 * Confirmation for converting a VM or container to a template (T63). Irreversible, so it gets the
 * same bar as `DeleteGuestDialog`: an `AlertDialog` whose destructive confirm only enables once the
 * guest's own VMID is typed exactly. PVE refuses to convert a guest that isn't stopped, so a
 * running/paused guest shows a "Stop the guest first" warning and the confirm stays disabled --
 * the server enforces this too.
 *
 * Give this a `key` that changes across opens (see `RenameGuestDialog`'s own doc comment) so a
 * fresh open starts from a clean typed VMID.
 */
export function ConvertToTemplateDialog({
  open,
  onOpenChange,
  node,
  type,
  vmid,
  name,
  status,
}: ConvertToTemplateDialogProps) {
  const mutation = useConvertToTemplate();
  const [confirmText, setConfirmText] = useState('');

  const running = status === 'running' || status === 'paused';
  const confirmed = confirmText === String(vmid);
  const canConfirm = confirmed && !running && !mutation.isPending;

  function handleConfirm() {
    if (!canConfirm) return;
    mutation.mutate({ node, type, vmid, name }, { onSuccess: () => onOpenChange(false) });
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
          <AlertDialogTitle>
            Convert {name} ({vmid}) to a template?
          </AlertDialogTitle>
          <AlertDialogDescription>
            This is permanent: a template can no longer be started, and it cannot be converted back to a{' '}
            {type === 'lxc' ? 'container' : 'VM'}. It can only be cloned or deleted. The guest must be stopped.
          </AlertDialogDescription>
        </AlertDialogHeader>

        {running && (
          <p role="alert" className="text-sm text-status-paused">
            Stop the guest first
          </p>
        )}

        <div className="flex flex-col gap-1.5">
          <label htmlFor="convert-template-confirm" className="text-sm text-muted-foreground">
            Type the VMID to confirm
          </label>
          <Input
            id="convert-template-confirm"
            autoFocus
            value={confirmText}
            onChange={(e) => setConfirmText(e.target.value)}
            disabled={mutation.isPending}
            placeholder={String(vmid)}
            inputMode="numeric"
            autoComplete="off"
          />
        </div>

        <AlertDialogFooter>
          <AlertDialogCancel disabled={mutation.isPending}>Cancel</AlertDialogCancel>
          <AlertDialogAction
            variant="destructive"
            disabled={!canConfirm}
            onClick={(event) => {
              // Radix's AlertDialogAction closes the dialog on click by default; this waits for
              // the request to be accepted instead (and stays open on an error), same convention
              // `DeleteGuestDialog` uses.
              event.preventDefault();
              handleConfirm();
            }}
          >
            {mutation.isPending && <Loader2 className="size-4 animate-spin" />}
            Convert {vmid}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
