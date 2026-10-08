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
import { nodeNetworkErrorMessage, useApplyNodeNetwork, useDeleteNodeIface } from '@/api/nodeNetworkHooks';

/** The word the Apply dialog asks for. */
export const APPLY_CONFIRM_WORD = 'APPLY';

/** The one-sentence consequence the Apply dialog spells out. */
export const APPLY_WARNING =
  'Applying can disconnect this node from the network if the configuration is wrong; have console access ready.';

export interface DeleteNetIfaceDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  node: string;
  iface: string;
}

/**
 * Typed confirmation for deleting a bridge/bond/VLAN: the interface name must be typed exactly.
 * The deletion is staged (shown as pending) like every other edit; guests attached to the
 * interface lose their network once it is applied. A server error stays inline.
 *
 * Mount it fresh per open (the tab renders it conditionally).
 */
export function DeleteNetIfaceDialog({ open, onOpenChange, node, iface }: DeleteNetIfaceDialogProps) {
  const [confirmText, setConfirmText] = useState('');
  const mutation = useDeleteNodeIface();
  const confirmed = confirmText === iface;

  function confirm() {
    if (!confirmed || mutation.isPending) return;
    mutation.mutate({ node, iface }, { onSuccess: () => onOpenChange(false) });
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
          <AlertDialogTitle>Delete {iface}?</AlertDialogTitle>
          <AlertDialogDescription>
            {iface} is removed from the pending configuration; once you apply it, guests and bridges that use
            this interface lose their network.
          </AlertDialogDescription>
        </AlertDialogHeader>

        <div className="flex flex-col gap-1.5">
          <label htmlFor="net-delete-confirm" className="text-sm text-muted-foreground">
            Type the interface name to confirm
          </label>
          <Input
            id="net-delete-confirm"
            autoFocus
            value={confirmText}
            onChange={(e) => setConfirmText(e.target.value)}
            disabled={mutation.isPending}
            placeholder={iface}
            autoComplete="off"
          />
        </div>

        {mutation.isError && (
          <p role="alert" className="text-xs text-status-error">
            {nodeNetworkErrorMessage(mutation.error, 'The interface could not be deleted.')}
          </p>
        )}

        <AlertDialogFooter>
          <AlertDialogCancel disabled={mutation.isPending}>Cancel</AlertDialogCancel>
          <AlertDialogAction
            variant="destructive"
            disabled={!confirmed || mutation.isPending}
            onClick={(event) => {
              // Radix closes an AlertDialogAction on click by default; wait for the request to be
              // accepted instead (and stay open on an error).
              event.preventDefault();
              confirm();
            }}
          >
            {mutation.isPending && <Loader2 className="size-4 animate-spin" />}
            Delete {iface}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

export interface ApplyNetworkDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  node: string;
}

/**
 * Typed confirmation for applying the staged network configuration: "APPLY" must be typed. A wrong
 * configuration can cut the node off the network, so the dialog says so. A server error stays
 * inline; on success the dialog closes and the hook toasts the task.
 *
 * Mount it fresh per open (the tab renders it conditionally).
 */
export function ApplyNetworkDialog({ open, onOpenChange, node }: ApplyNetworkDialogProps) {
  const [confirmText, setConfirmText] = useState('');
  const mutation = useApplyNodeNetwork();
  const confirmed = confirmText === APPLY_CONFIRM_WORD;

  function confirm() {
    if (!confirmed || mutation.isPending) return;
    mutation.mutate(node, { onSuccess: () => onOpenChange(false) });
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
          <AlertDialogTitle>Apply network configuration on {node}?</AlertDialogTitle>
          <AlertDialogDescription>{APPLY_WARNING}</AlertDialogDescription>
        </AlertDialogHeader>

        <div className="flex flex-col gap-1.5">
          <label htmlFor="net-apply-confirm" className="text-sm text-muted-foreground">
            Type {APPLY_CONFIRM_WORD} to confirm
          </label>
          <Input
            id="net-apply-confirm"
            autoFocus
            value={confirmText}
            onChange={(e) => setConfirmText(e.target.value)}
            disabled={mutation.isPending}
            placeholder={APPLY_CONFIRM_WORD}
            autoComplete="off"
          />
        </div>

        {mutation.isError && (
          <p role="alert" className="text-xs text-status-error">
            {nodeNetworkErrorMessage(mutation.error, 'The configuration could not be applied.')}
          </p>
        )}

        <AlertDialogFooter>
          <AlertDialogCancel disabled={mutation.isPending}>Cancel</AlertDialogCancel>
          <AlertDialogAction
            variant="destructive"
            disabled={!confirmed || mutation.isPending}
            onClick={(event) => {
              event.preventDefault();
              confirm();
            }}
          >
            {mutation.isPending && <Loader2 className="size-4 animate-spin" />}
            Apply network configuration
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
