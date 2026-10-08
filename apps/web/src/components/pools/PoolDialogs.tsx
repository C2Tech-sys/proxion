import { useId, useState, type KeyboardEvent, type ReactNode } from 'react';
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
import { hardwareErrorMessage } from '@/api/hardwareHooks';
import { useCreatePool, useDeletePool, useUpdatePool } from '@/api/poolsHooks';

const POOL_ID_RE = /^[A-Za-z0-9._-]{1,64}$/;
const MAX_COMMENT = 255;
// eslint-disable-next-line no-control-regex
const SINGLE_LINE_RE = /^[^\x00-\x1f\x7f]*$/;

function Field({ label, htmlFor, error, hint, children }: {
  label: string;
  htmlFor: string;
  error?: string | undefined;
  hint?: string | undefined;
  children: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={htmlFor} className="text-sm font-medium">
        {label}
      </label>
      {children}
      {error ? (
        <p className="text-xs text-status-error">{error}</p>
      ) : hint ? (
        <p className="text-xs text-muted-foreground">{hint}</p>
      ) : null}
    </div>
  );
}

function commentError(comment: string): string | undefined {
  if (comment.length > MAX_COMMENT) return `Use at most ${MAX_COMMENT} characters.`;
  if (!SINGLE_LINE_RE.test(comment)) return 'Use a single line.';
  return undefined;
}

export interface AddPoolDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/** Creates a pool: its name and an optional comment. Mount it fresh per open. */
export function AddPoolDialog({ open, onOpenChange }: AddPoolDialogProps) {
  const id = useId();
  const mutation = useCreatePool();
  const [poolid, setPoolid] = useState('');
  const [comment, setComment] = useState('');

  const idError = poolid !== '' && !POOL_ID_RE.test(poolid) ? 'Use 1-64 letters, digits, dots, dashes or underscores.' : undefined;
  const cError = commentError(comment);
  const busy = mutation.isPending;
  const canSave = POOL_ID_RE.test(poolid) && cError === undefined && !busy;

  function submit() {
    if (!canSave) return;
    mutation.mutate(
      { poolid, ...(comment.trim() !== '' ? { comment: comment.trim() } : {}) },
      { onSuccess: () => onOpenChange(false) },
    );
  }

  function onKeyDown(event: KeyboardEvent<HTMLElement>) {
    if (event.key === 'Enter' && event.target instanceof HTMLInputElement) {
      event.preventDefault();
      submit();
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next && busy) return;
        onOpenChange(next);
      }}
    >
      <DialogContent onKeyDown={onKeyDown}>
        <DialogHeader>
          <DialogTitle>Add pool</DialogTitle>
          <DialogDescription>A pool groups guests and storages so permissions can be granted on the group.</DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-4">
          <Field label="Name" htmlFor={`${id}-poolid`} error={idError}>
            <Input
              id={`${id}-poolid`}
              autoFocus
              value={poolid}
              disabled={busy}
              autoComplete="off"
              onChange={(e) => setPoolid(e.target.value)}
            />
          </Field>
          <Field label="Comment" htmlFor={`${id}-comment`} error={cError}>
            <Input
              id={`${id}-comment`}
              value={comment}
              disabled={busy}
              autoComplete="off"
              onChange={(e) => setComment(e.target.value)}
            />
          </Field>
        </div>
        {mutation.isError && (
          <p role="alert" className="text-xs text-status-error">
            {hardwareErrorMessage(mutation.error, 'The pool could not be created.')}
          </p>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={!canSave}>
            {busy && <Loader2 className="size-4 animate-spin" />}
            Create
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export interface EditPoolCommentDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  poolid: string;
  comment: string;
}

/** Changes a pool's comment (blank clears it). Mount it fresh per open. */
export function EditPoolCommentDialog({ open, onOpenChange, poolid, comment: initial }: EditPoolCommentDialogProps) {
  const id = useId();
  const mutation = useUpdatePool();
  const [comment, setComment] = useState(initial);

  const cError = commentError(comment);
  const busy = mutation.isPending;
  const canSave = cError === undefined && !busy;

  function submit() {
    if (!canSave) return;
    mutation.mutate({ poolid, body: { comment: comment.trim() } }, { onSuccess: () => onOpenChange(false) });
  }

  function onKeyDown(event: KeyboardEvent<HTMLElement>) {
    if (event.key === 'Enter' && event.target instanceof HTMLInputElement) {
      event.preventDefault();
      submit();
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next && busy) return;
        onOpenChange(next);
      }}
    >
      <DialogContent onKeyDown={onKeyDown}>
        <DialogHeader>
          <DialogTitle>Edit pool: {poolid}</DialogTitle>
          <DialogDescription>Members are managed from the Members action.</DialogDescription>
        </DialogHeader>
        <Field label="Comment" htmlFor={`${id}-comment`} error={cError}>
          <Input
            id={`${id}-comment`}
            autoFocus
            value={comment}
            disabled={busy}
            autoComplete="off"
            onChange={(e) => setComment(e.target.value)}
          />
        </Field>
        {mutation.isError && (
          <p role="alert" className="text-xs text-status-error">
            {hardwareErrorMessage(mutation.error, 'The pool could not be saved.')}
          </p>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={!canSave}>
            {busy && <Loader2 className="size-4 animate-spin" />}
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export interface DeletePoolDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  poolid: string;
}

/**
 * Confirmation for deleting an (empty) pool: the destructive confirm only enables once the pool
 * name is typed exactly. The Pools tab does not offer this for a pool that still has members, and
 * PVE refuses it as well. Mount it fresh per open.
 */
export function DeletePoolDialog({ open, onOpenChange, poolid }: DeletePoolDialogProps) {
  const mutation = useDeletePool();
  const [confirmText, setConfirmText] = useState('');
  const canConfirm = confirmText === poolid && !mutation.isPending;

  function confirm() {
    if (!canConfirm) return;
    mutation.mutate(poolid, { onSuccess: () => onOpenChange(false) });
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
          <AlertDialogTitle>Delete pool {poolid}?</AlertDialogTitle>
          <AlertDialogDescription>
            Deletes the empty pool. Permissions granted on the pool are lost with it.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <div className="flex flex-col gap-1.5">
          <label htmlFor="delete-pool-confirm" className="text-sm text-muted-foreground">
            Type the pool name to confirm
          </label>
          <Input
            id="delete-pool-confirm"
            autoFocus
            value={confirmText}
            onChange={(e) => setConfirmText(e.target.value)}
            disabled={mutation.isPending}
            placeholder={poolid}
            autoComplete="off"
          />
        </div>
        {mutation.isError && (
          <p role="alert" className="text-xs text-status-error">
            {hardwareErrorMessage(mutation.error, 'The pool could not be deleted.')}
          </p>
        )}
        <AlertDialogFooter>
          <AlertDialogCancel disabled={mutation.isPending}>Cancel</AlertDialogCancel>
          <AlertDialogAction
            variant="destructive"
            disabled={!canConfirm}
            onClick={(event) => {
              event.preventDefault();
              confirm();
            }}
          >
            {mutation.isPending && <Loader2 className="size-4 animate-spin" />}
            Delete {poolid}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
