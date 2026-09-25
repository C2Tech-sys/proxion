import { useEffect, useId, useState, type KeyboardEvent } from 'react';
import { Loader2 } from 'lucide-react';

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
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
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Checkbox } from '@/components/ui/checkbox';
import { useSnapshotAction } from '@/api/actionHooks';
import { GuestActionError } from '@/api/actions';
import { isValidSnapshotName, MAX_SNAPSHOT_NAME_LENGTH } from '@/lib/snapshotName';
import { formatDateTime } from '@/lib/format';
import type { GuestType } from '@/api/types';

/** Shared by every dialog below -- reads a snapshot mutation's error into the inline message the
 * server error slot shows, same convention `RenameGuestDialog` uses for `useUpdateGuestConfig`. */
function useSnapshotMutationError(mutation: ReturnType<typeof useSnapshotAction>): string | undefined {
  if (!mutation.isError) return undefined;
  return mutation.error instanceof GuestActionError ? mutation.error.message : 'The request could not be completed.';
}

export interface SnapshotCreateDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  node: string;
  type: GuestType;
  vmid: number;
  /** Whether the "Include RAM (running state)" checkbox is offered at all -- qemu guests only,
   * and only while running (PVE has no running-state RAM to capture for a stopped guest). */
  canIncludeRam: boolean;
}

/**
 * A snapshot create, in a plain `Dialog` (not `AlertDialog` -- this isn't a confirmation, it's a
 * form), following `RenameGuestDialog`'s own shape: a name field with inline validation
 * (`src/lib/snapshotName.ts`, the same rule the server enforces), an optional description
 * textarea, and -- for a running qemu guest -- an "Include RAM" checkbox. Enter in the name field
 * submits; Escape cancels; a server error shows inline instead of a toast, same as the rename
 * dialog. Give this a `key` that changes across opens so a fresh open starts with clean fields.
 */
export function SnapshotCreateDialog({ open, onOpenChange, node, type, vmid, canIncludeRam }: SnapshotCreateDialogProps) {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [includeRam, setIncludeRam] = useState(false);
  const mutation = useSnapshotAction();
  const errorId = useId();

  const trimmedName = name.trim();
  const valid = isValidSnapshotName(trimmedName);
  const showValidationError = trimmedName.length > 0 && !valid;
  const serverError = useSnapshotMutationError(mutation);

  function submit() {
    if (!valid || mutation.isPending) return;
    const trimmedDescription = description.trim();
    mutation.mutate(
      {
        op: 'create',
        node,
        type,
        vmid,
        body: {
          snapname: trimmedName,
          ...(trimmedDescription.length > 0 ? { description: trimmedDescription } : {}),
          ...(canIncludeRam && includeRam ? { vmstate: true } : {}),
        },
      },
      { onSuccess: () => onOpenChange(false) },
    );
  }

  function onNameKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === 'Enter') {
      event.preventDefault();
      submit();
    } else if (event.key === 'Escape') {
      event.preventDefault();
      if (!mutation.isPending) onOpenChange(false);
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next && mutation.isPending) return;
        onOpenChange(next);
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Take snapshot</DialogTitle>
          <DialogDescription>Captures the guest's current disk state (and, if selected, RAM).</DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-1.5">
          <Input
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={onNameKeyDown}
            disabled={mutation.isPending}
            placeholder="Snapshot name"
            aria-label="Snapshot name"
            aria-invalid={showValidationError || mutation.isError || undefined}
            aria-describedby={showValidationError || serverError ? errorId : undefined}
            maxLength={MAX_SNAPSHOT_NAME_LENGTH}
          />
          {showValidationError ? (
            <p id={errorId} className="text-xs text-status-error">
              Must start with a letter, then letters, digits, underscores or hyphens (2-40 characters), and cannot be
              "current".
            </p>
          ) : serverError ? (
            <p id={errorId} className="text-xs text-status-error">
              {serverError}
            </p>
          ) : null}
        </div>

        <Textarea
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          disabled={mutation.isPending}
          placeholder="Description (optional)"
          aria-label="Snapshot description"
          rows={3}
        />

        {canIncludeRam && (
          <div className="flex items-center gap-2">
            <Checkbox
              id="snapshot-include-ram"
              checked={includeRam}
              onCheckedChange={(checked) => setIncludeRam(checked === true)}
              disabled={mutation.isPending}
            />
            <label htmlFor="snapshot-include-ram" className="text-sm">
              Include RAM (running state)
            </label>
          </div>
        )}

        <DialogFooter>
          <Button variant="outline" disabled={mutation.isPending} onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button disabled={!valid || mutation.isPending} onClick={submit}>
            {mutation.isPending && <Loader2 className="size-4 animate-spin" />}
            Take snapshot
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export interface SnapshotRollbackDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  node: string;
  type: GuestType;
  vmid: number;
  guestName: string;
  snapname: string;
  snaptime?: number | undefined;
  /** Reports the mutation's own `isPending` as it changes, so the caller (`SnapshotsTab`) can
   * show a spinner on this snapshot's row while the request is in flight -- this dialog is the
   * only thing that knows about its own mutation. */
  onPendingChange?: ((pending: boolean) => void) | undefined;
}

/**
 * A destructive confirmation for rolling back to a snapshot. For qemu guests, a "Start the guest
 * afterwards" checkbox maps to the rollback's own `start` option. Closes itself once the mutation
 * succeeds; a server error shows inline rather than only as a toast (the toast still fires too,
 * via `useSnapshotAction`, matching every other guest-action dialog's convention).
 */
export function SnapshotRollbackDialog({
  open,
  onOpenChange,
  node,
  type,
  vmid,
  guestName,
  snapname,
  snaptime,
  onPendingChange,
}: SnapshotRollbackDialogProps) {
  const [start, setStart] = useState(false);
  const mutation = useSnapshotAction();
  const serverError = useSnapshotMutationError(mutation);

  useEffect(() => {
    onPendingChange?.(mutation.isPending);
  }, [mutation.isPending, onPendingChange]);

  const when = snaptime !== undefined ? formatDateTime(snaptime) : 'an unknown time';

  function confirm() {
    mutation.mutate(
      {
        op: 'rollback',
        node,
        type,
        vmid,
        snapname,
        ...(type === 'qemu' && start ? { options: { start: true } } : {}),
      },
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
            Roll back {guestName} to {snapname}?
          </AlertDialogTitle>
          <AlertDialogDescription>
            Every change since {snapname} ({when}) is discarded. The guest is stopped if it is running.
          </AlertDialogDescription>
        </AlertDialogHeader>

        {type === 'qemu' && (
          <div className="flex items-center gap-2">
            <Checkbox
              id="snapshot-rollback-start"
              checked={start}
              onCheckedChange={(checked) => setStart(checked === true)}
              disabled={mutation.isPending}
            />
            <label htmlFor="snapshot-rollback-start" className="text-sm">
              Start the guest afterwards
            </label>
          </div>
        )}

        {serverError && <p className="text-xs text-status-error">{serverError}</p>}

        <AlertDialogFooter>
          <AlertDialogCancel disabled={mutation.isPending}>Cancel</AlertDialogCancel>
          <AlertDialogAction
            variant="destructive"
            disabled={mutation.isPending}
            onClick={(event) => {
              // Radix closes the dialog on click by default; this stays open (with a spinner)
              // while the mutation is in flight, same convention as `GuestActionDialog`.
              event.preventDefault();
              confirm();
            }}
          >
            {mutation.isPending && <Loader2 className="size-4 animate-spin" />}
            Roll back
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

export interface SnapshotDeleteDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  node: string;
  type: GuestType;
  vmid: number;
  snapname: string;
  /** See `SnapshotRollbackDialogProps.onPendingChange`. */
  onPendingChange?: ((pending: boolean) => void) | undefined;
}

/** A destructive confirmation for deleting a snapshot. Same shape as `SnapshotRollbackDialog`,
 * minus the qemu-only "start" option (delete has no such thing). */
export function SnapshotDeleteDialog({
  open,
  onOpenChange,
  node,
  type,
  vmid,
  snapname,
  onPendingChange,
}: SnapshotDeleteDialogProps) {
  const mutation = useSnapshotAction();
  const serverError = useSnapshotMutationError(mutation);

  useEffect(() => {
    onPendingChange?.(mutation.isPending);
  }, [mutation.isPending, onPendingChange]);

  function confirm() {
    mutation.mutate({ op: 'delete', node, type, vmid, snapname }, { onSuccess: () => onOpenChange(false) });
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
          <AlertDialogTitle>Delete {snapname}?</AlertDialogTitle>
          <AlertDialogDescription>
            This permanently removes the snapshot. It cannot be undone, and any snapshot taken from it moves up to
            its own parent.
          </AlertDialogDescription>
        </AlertDialogHeader>

        {serverError && <p className="text-xs text-status-error">{serverError}</p>}

        <AlertDialogFooter>
          <AlertDialogCancel disabled={mutation.isPending}>Cancel</AlertDialogCancel>
          <AlertDialogAction
            variant="destructive"
            disabled={mutation.isPending}
            onClick={(event) => {
              event.preventDefault();
              confirm();
            }}
          >
            {mutation.isPending && <Loader2 className="size-4 animate-spin" />}
            Delete
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
