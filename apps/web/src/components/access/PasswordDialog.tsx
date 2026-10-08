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
import { Field } from '@/components/access/accessShared';
import { mutationErrorText, passwordError } from '@/components/access/accessHelpers';
import { useChangePassword } from '@/api/accessHooks';
import type { ChangePasswordBody } from '@/api/access';

export interface PasswordDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  userid: string;
  /** True when the signed-in user is changing their own password: asks for the current one too. */
  isSelf: boolean;
}

/**
 * Sets a new password for a `pve`-realm user. The signed-in user changing their own password is
 * also asked for the current one (Proxmox VE 8.1+ requires it for a self-service change; the field
 * is optional here so an older host or a root caller is not blocked). The passwords live only in
 * this dialog's state and the one request -- they are never logged or kept. A server error stays
 * inline. Mount it fresh per open.
 */
export function PasswordDialog({ open, onOpenChange, userid, isSelf }: PasswordDialogProps) {
  const id = useId();
  const mutation = useChangePassword();
  const [current, setCurrent] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');

  const error = passwordError(password, confirm);
  const canSave = password.length >= 8 && confirm === password && error === undefined && !mutation.isPending;

  function submit() {
    if (!canSave) return;
    const body: ChangePasswordBody = { userid, password };
    if (isSelf && current !== '') body.confirmationPassword = current;
    mutation.mutate(body, { onSuccess: () => onOpenChange(false) });
  }

  function onKeyDown(event: KeyboardEvent<HTMLElement>) {
    if (event.key === 'Enter' && event.target instanceof HTMLInputElement) {
      event.preventDefault();
      submit();
    }
  }

  const busy = mutation.isPending;
  const serverError = mutationErrorText(mutation.error);

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
          <DialogTitle>{isSelf ? 'Change my password' : `Change password for ${userid}`}</DialogTitle>
          <DialogDescription>
            {isSelf
              ? `Set a new password for ${userid}.`
              : 'The user signs in with the new password from now on.'}
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-4">
          {isSelf && (
            <Field label="Current password" htmlFor={`${id}-current`}>
              <Input
                id={`${id}-current`}
                type="password"
                autoFocus
                value={current}
                onChange={(e) => setCurrent(e.target.value)}
                disabled={busy}
                autoComplete="current-password"
              />
            </Field>
          )}
          <Field label="New password" htmlFor={`${id}-new`} error={error} hint="8 to 64 characters.">
            <Input
              id={`${id}-new`}
              type="password"
              autoFocus={!isSelf}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              disabled={busy}
              autoComplete="new-password"
            />
          </Field>
          <Field label="Confirm new password" htmlFor={`${id}-confirm`}>
            <Input
              id={`${id}-confirm`}
              type="password"
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              disabled={busy}
              autoComplete="new-password"
            />
          </Field>
          {serverError && (
            <p role="alert" className="text-sm text-status-error">
              {serverError}
            </p>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={!canSave}>
            {busy && <Loader2 className="size-4 animate-spin" />}
            Change password
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
