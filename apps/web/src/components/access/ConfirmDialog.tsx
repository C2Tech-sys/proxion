import { useState, type ReactNode } from 'react';
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

export interface ConfirmDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  /** One sentence that spells out the consequence. */
  description: ReactNode;
  confirmLabel: string;
  /** When set, the confirm button stays disabled until this exact text is typed. */
  typedConfirm?: string | undefined;
  isPending: boolean;
  /** The server's message from a failed attempt, shown inline (the dialog stays open). */
  error?: string | undefined;
  onConfirm: () => void;
}

/**
 * A destructive-action confirmation for the Users & Permissions tab: an `AlertDialog` with a
 * destructive confirm, optionally gated on typing a name exactly (same pattern as
 * `DeleteGuestDialog`). The confirm waits for the request to be accepted and stays open on an
 * error. The typed text lives in a child that remounts on every open, so a fresh open is clean.
 */
export function ConfirmDialog(props: ConfirmDialogProps) {
  const { open, onOpenChange, title, description, isPending } = props;
  return (
    <AlertDialog
      open={open}
      onOpenChange={(next) => {
        if (!next && isPending) return;
        onOpenChange(next);
      }}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          <AlertDialogDescription>{description}</AlertDialogDescription>
        </AlertDialogHeader>
        <ConfirmBody {...props} />
      </AlertDialogContent>
    </AlertDialog>
  );
}

function ConfirmBody({ confirmLabel, typedConfirm, isPending, error, onConfirm }: ConfirmDialogProps) {
  const [typed, setTyped] = useState('');
  const confirmed = typedConfirm === undefined || typed === typedConfirm;
  const canConfirm = confirmed && !isPending;

  return (
    <>
      {typedConfirm !== undefined && (
        <div className="flex flex-col gap-1.5">
          <label htmlFor="access-confirm-typed" className="text-sm text-muted-foreground">
            Type <span className="font-mono text-foreground">{typedConfirm}</span> to confirm
          </label>
          <Input
            id="access-confirm-typed"
            autoFocus
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            disabled={isPending}
            placeholder={typedConfirm}
            autoComplete="off"
          />
        </div>
      )}
      {error && (
        <p role="alert" className="text-sm text-status-error">
          {error}
        </p>
      )}
      <AlertDialogFooter>
        <AlertDialogCancel disabled={isPending}>Cancel</AlertDialogCancel>
        <AlertDialogAction
          variant="destructive"
          disabled={!canConfirm}
          onClick={(event) => {
            // Radix closes an AlertDialog on action click by default; wait for the request instead.
            event.preventDefault();
            if (canConfirm) onConfirm();
          }}
        >
          {isPending && <Loader2 className="size-4 animate-spin" />}
          {confirmLabel}
        </AlertDialogAction>
      </AlertDialogFooter>
    </>
  );
}
