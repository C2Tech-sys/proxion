import { useMemo, useState } from 'react';
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
import { useClusterResources } from '@/api/hooks';
import { useNodeAction } from '@/api/actionHooks';
import type { NodeActionCommand } from '@/api/actions';

export interface NodeActionDialogProps {
  node: string;
  /** The action to confirm, or `null` to render nothing (closed). */
  command: NodeActionCommand | null;
  onOpenChange: (open: boolean) => void;
}

const COMMAND_VERB: Record<NodeActionCommand, string> = {
  reboot: 'Reboot',
  shutdown: 'Shut down',
};

const COMMAND_BUTTON_LABEL: Record<NodeActionCommand, string> = {
  reboot: 'Reboot node',
  shutdown: 'Shut down node',
};

/** How many running-guest names to list before collapsing the rest into "+N more" -- keeps the
 * dialog from growing unbounded on a densely-packed node. */
const MAX_LISTED_GUESTS = 8;

/**
 * Confirmation for a node reboot/shutdown -- a heavier bar than `GuestActionDialog`'s own
 * destructive guest actions, since this affects every guest on the node at once rather than one:
 * it shows the running guests that will be affected (from the cluster-wide resources query, same
 * source `ObjectHeader`/`MigrateGuestDialog` already read) and requires typing the node's own name
 * exactly before the confirm button enables. Renders nothing when `command` is `null`; give it a
 * `key` derived from `command` where it's mounted (see `NodePowerMenu`) so the typed name and any
 * in-flight state reset between one action and the next instead of carrying over -- same
 * convention `GuestActionDialog` documents for its own per-action local state.
 */
export function NodeActionDialog({ node, command, onOpenChange }: NodeActionDialogProps) {
  const [confirmText, setConfirmText] = useState('');
  const clusterResources = useClusterResources();
  const mutation = useNodeAction();

  const runningGuests = useMemo(
    () =>
      (clusterResources.data ?? [])
        .filter((r) => (r.type === 'qemu' || r.type === 'lxc') && r.status === 'running' && r.node === node)
        .map((r) => r.name ?? `#${r.vmid}`),
    [clusterResources.data, node],
  );

  if (!command) return null;

  const verb = COMMAND_VERB[command];
  const confirmed = confirmText === node;
  const listed = runningGuests.slice(0, MAX_LISTED_GUESTS);
  const remaining = runningGuests.length - listed.length;

  function handleConfirm() {
    if (!confirmed || mutation.isPending) return;
    mutation.mutate(
      { node, command: command as NodeActionCommand },
      { onSettled: () => onOpenChange(false) },
    );
  }

  return (
    <AlertDialog
      open
      onOpenChange={(open) => {
        if (!open && !mutation.isPending) onOpenChange(false);
      }}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>
            {verb} {node}?
          </AlertDialogTitle>
          <AlertDialogDescription>
            {runningGuests.length > 0
              ? `${runningGuests.length} running guest${runningGuests.length === 1 ? '' : 's'} on this node will be affected`
              : 'No running guests on this node'}
          </AlertDialogDescription>
        </AlertDialogHeader>

        {listed.length > 0 && (
          <ul className="rounded-md border border-border bg-muted/40 px-3 py-2 text-sm">
            {listed.map((name) => (
              <li key={name} className="truncate">
                {name}
              </li>
            ))}
            {remaining > 0 && <li className="text-muted-foreground">+{remaining} more</li>}
          </ul>
        )}

        <div className="flex flex-col gap-1.5">
          <label htmlFor="node-action-confirm" className="text-sm text-muted-foreground">
            Type the node name to confirm
          </label>
          <Input
            id="node-action-confirm"
            autoFocus
            value={confirmText}
            onChange={(e) => setConfirmText(e.target.value)}
            disabled={mutation.isPending}
            placeholder={node}
          />
        </div>

        <AlertDialogFooter>
          <AlertDialogCancel disabled={mutation.isPending}>Cancel</AlertDialogCancel>
          <AlertDialogAction
            variant="destructive"
            disabled={!confirmed || mutation.isPending}
            onClick={(event) => {
              // Radix's AlertDialogAction closes the dialog on click by default; this waits for
              // the mutation to settle instead, same convention `GuestActionDialog` uses.
              event.preventDefault();
              handleConfirm();
            }}
          >
            {mutation.isPending && <Loader2 className="size-4 animate-spin" />}
            {COMMAND_BUTTON_LABEL[command]}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
