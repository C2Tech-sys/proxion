import { useState, type ComponentType, type ReactNode } from 'react';
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
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';

export function Field({
  label,
  htmlFor,
  error,
  hint,
  children,
}: {
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

/** A small icon button for a table row; disabled with the standard reason as its tooltip. */
export function RowButton({
  label,
  icon,
  disabledReason,
  disabled,
  onClick,
  destructive,
}: {
  label: string;
  icon: ComponentType<{ className?: string }>;
  disabledReason: string | undefined;
  /** An extra reason to disable (first/last row, a save in flight) without a tooltip. */
  disabled?: boolean;
  onClick: () => void;
  destructive?: boolean;
}) {
  const Icon = icon;
  const locked = disabledReason !== undefined;
  return (
    <Button
      variant="ghost"
      size="icon"
      className={cn('size-7 shrink-0', destructive && !locked && 'text-destructive hover:text-destructive')}
      aria-label={label}
      title={locked ? disabledReason : label}
      disabled={locked || disabled}
      onClick={onClick}
    >
      <Icon className="size-3.5" />
    </Button>
  );
}

export function Cell({ value }: { value: string | undefined }) {
  return value ? <>{value}</> : <span className="text-muted-foreground">-</span>;
}

export interface ConfirmDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  /** One sentence spelling out the consequence. */
  description: ReactNode;
  confirmLabel: string;
  pending: boolean;
  error?: string | undefined;
  /** When set, the confirm button only enables once this exact word is typed (lock-out-capable changes). */
  typedWord?: string | undefined;
  onConfirm: () => void;
}

/**
 * A destructive confirmation (an `AlertDialog`, same convention as `DeleteRuleDialog`): the dialog
 * stays open until the request is accepted and shows a server error inline. With `typedWord` it
 * asks for that word to be typed exactly first, like `DeleteGuestDialog` does with the VMID. Mount
 * it fresh per open so the typed text starts empty.
 */
export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel,
  pending,
  error,
  typedWord,
  onConfirm,
}: ConfirmDialogProps) {
  const [typed, setTyped] = useState('');
  const confirmed = typedWord === undefined || typed === typedWord;
  const canConfirm = confirmed && !pending;

  return (
    <AlertDialog
      open={open}
      onOpenChange={(next) => {
        if (!next && pending) return;
        onOpenChange(next);
      }}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          <AlertDialogDescription>{description}</AlertDialogDescription>
        </AlertDialogHeader>

        {typedWord !== undefined && (
          <div className="flex flex-col gap-1.5">
            <label htmlFor="cluster-firewall-confirm" className="text-sm text-muted-foreground">
              Type {typedWord} to confirm
            </label>
            <Input
              id="cluster-firewall-confirm"
              autoFocus
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              disabled={pending}
              placeholder={typedWord}
              autoComplete="off"
            />
          </div>
        )}

        {error && (
          <p role="alert" className="text-xs text-status-error">
            {error}
          </p>
        )}

        <AlertDialogFooter>
          <AlertDialogCancel disabled={pending}>Cancel</AlertDialogCancel>
          <AlertDialogAction
            variant="destructive"
            disabled={!canConfirm}
            onClick={(event) => {
              // Radix closes an AlertDialogAction on click by default; wait for the request to be
              // accepted instead (and stay open on an error).
              event.preventDefault();
              if (canConfirm) onConfirm();
            }}
          >
            {pending && <Loader2 className="size-4 animate-spin" />}
            {confirmLabel}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
