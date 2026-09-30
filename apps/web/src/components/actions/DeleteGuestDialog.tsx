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
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { useDestroyGuest } from '@/api/actionHooks';
import type { GuestType } from '@/api/types';

export interface DeleteGuestDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  node: string;
  type: GuestType;
  vmid: number;
  name: string;
  status: string;
}

/**
 * Confirmation for deleting (destroying) a VM or container (T47) -- the heaviest bar in the app
 * short of a node power action, since it is irreversible: an `AlertDialog` with a destructive
 * confirm that only enables once the guest's own VMID is typed exactly (same pattern as
 * `NodeActionDialog`'s typed node name and `RestoreBackupDialog`'s typed VMID). Two options
 * mirror PVE's own delete dialog: "purge" (also remove the guest from backup jobs, replication and
 * HA; off by default) and "destroy unreferenced disks" (on by default, like PVE's own UI). PVE
 * itself refuses to destroy a guest that isn't stopped, so a running/paused guest shows a "Stop
 * the guest first" warning and the confirm stays disabled -- the server enforces this too.
 *
 * Give this a `key` that changes across opens (see `RenameGuestDialog`'s own doc comment) so a
 * fresh open starts from a clean typed VMID and default options.
 */
export function DeleteGuestDialog({ open, onOpenChange, node, type, vmid, name, status }: DeleteGuestDialogProps) {
  const mutation = useDestroyGuest();
  const [confirmText, setConfirmText] = useState('');
  const [purge, setPurge] = useState(false);
  const [destroyUnreferencedDisks, setDestroyUnreferencedDisks] = useState(true);

  const running = status === 'running' || status === 'paused';
  const confirmed = confirmText === String(vmid);
  const canConfirm = confirmed && !running && !mutation.isPending;

  function handleConfirm() {
    if (!canConfirm) return;
    mutation.mutate(
      { node, type, vmid, name, body: { purge, destroyUnreferencedDisks } },
      { onSuccess: () => onOpenChange(false) },
    );
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
            Delete {name} ({vmid})?
          </AlertDialogTitle>
          <AlertDialogDescription>
            This permanently destroys the {type === 'lxc' ? 'container' : 'VM'} and its disks. This cannot be
            undone.
          </AlertDialogDescription>
        </AlertDialogHeader>

        {running && (
          <p role="alert" className="text-sm text-status-paused">
            Stop the guest first
          </p>
        )}

        <div className="flex flex-col gap-2">
          <div className="flex items-center gap-2">
            <Checkbox
              id="delete-guest-purge"
              checked={purge}
              onCheckedChange={(checked) => setPurge(checked === true)}
              disabled={mutation.isPending}
            />
            <label htmlFor="delete-guest-purge" className="text-sm">
              Also remove it from backup jobs, replication and HA (purge)
            </label>
          </div>
          <div className="flex items-center gap-2">
            <Checkbox
              id="delete-guest-unreferenced"
              checked={destroyUnreferencedDisks}
              onCheckedChange={(checked) => setDestroyUnreferencedDisks(checked === true)}
              disabled={mutation.isPending}
            />
            <label htmlFor="delete-guest-unreferenced" className="text-sm">
              Destroy unreferenced disks owned by this guest
            </label>
          </div>
        </div>

        <div className="flex flex-col gap-1.5">
          <label htmlFor="delete-guest-confirm" className="text-sm text-muted-foreground">
            Type the VMID to confirm
          </label>
          <Input
            id="delete-guest-confirm"
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
              // `NodeActionDialog`/`GuestActionDialog` use.
              event.preventDefault();
              handleConfirm();
            }}
          >
            {mutation.isPending && <Loader2 className="size-4 animate-spin" />}
            Delete {vmid}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
