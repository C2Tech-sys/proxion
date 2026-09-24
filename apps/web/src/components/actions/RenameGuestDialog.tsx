import { useId, useState, type KeyboardEvent } from 'react';
import { Loader2 } from 'lucide-react';

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useUpdateGuestConfig } from '@/api/actionHooks';
import { GuestActionError } from '@/api/actions';
import { isValidGuestName, maxNameLength } from '@/lib/guestName';
import type { GuestType } from '@/api/types';

export interface RenameGuestDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  node: string;
  type: GuestType;
  vmid: number;
  currentName: string;
}

/**
 * A guest rename, in a plain `Dialog` (not `AlertDialog` -- this isn't a confirmation, it's a
 * form) with a single text input prefilled with the guest's current name. Inline validation uses
 * the exact same dns-name rule the server enforces (`src/lib/guestName.ts`, a deliberate copy of
 * `apps/server/src/actions/routes.ts`'s own rule -- see the comment on each). Enter submits,
 * Escape cancels; the tree label and header title update on their own once `useUpdateGuestConfig`
 * invalidates the relevant queries -- this dialog never patches anything itself.
 *
 * The input value and any previous error are only ever seeded from `currentName` at mount --
 * there's no effect re-seeding them on every open. Give this a `key` that changes across opens
 * (e.g. `key={open ? 'open' : 'closed'}` where it's rendered) so a fresh open remounts it with a
 * clean `currentName` and no leftover error, the same convention `GuestActionDialog` documents
 * for its own per-action local state.
 */
export function RenameGuestDialog({
  open,
  onOpenChange,
  node,
  type,
  vmid,
  currentName,
}: RenameGuestDialogProps) {
  const [value, setValue] = useState(currentName);
  const mutation = useUpdateGuestConfig();
  const errorId = useId();

  const trimmed = value.trim();
  const valid = isValidGuestName(trimmed, type);
  const showValidationError = trimmed.length > 0 && !valid;

  const serverError =
    mutation.isError && mutation.error instanceof GuestActionError
      ? mutation.error.message
      : mutation.isError
        ? 'The rename could not be saved.'
        : undefined;

  function submit() {
    if (!valid || mutation.isPending) return;
    mutation.mutate(
      { node, type, vmid, patch: { name: trimmed } },
      { onSuccess: () => onOpenChange(false) },
    );
  }

  function onKeyDown(event: KeyboardEvent<HTMLInputElement>) {
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
          <DialogTitle>Rename {currentName}</DialogTitle>
          <DialogDescription>
            {type === 'lxc' ? "This changes the container's hostname." : 'This changes the VM name.'}
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-1.5">
          <Input
            autoFocus
            value={value}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={onKeyDown}
            disabled={mutation.isPending}
            aria-label="Guest name"
            aria-invalid={showValidationError || mutation.isError || undefined}
            aria-describedby={showValidationError || serverError ? errorId : undefined}
            maxLength={maxNameLength(type)}
          />
          {showValidationError ? (
            <p id={errorId} className="text-xs text-status-error">
              Must be a valid hostname: letters, digits and hyphens, in dot-separated segments.
            </p>
          ) : serverError ? (
            <p id={errorId} className="text-xs text-status-error">
              {serverError}
            </p>
          ) : null}
        </div>

        <DialogFooter>
          <Button variant="outline" disabled={mutation.isPending} onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button disabled={!valid || mutation.isPending} onClick={submit}>
            {mutation.isPending && <Loader2 className="size-4 animate-spin" />}
            Rename
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
