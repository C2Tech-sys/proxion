import { useId, useState, type KeyboardEvent } from 'react';
import { Check, Copy, Loader2 } from 'lucide-react';

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
import { NativeSelect } from '@/components/hardware/NativeSelect';
import { CheckField, Field } from '@/components/access/accessShared';
import { TOKEN_ID_RE, dateInputToExpire, mutationErrorText } from '@/components/access/accessHelpers';
import { useCreateToken } from '@/api/accessHooks';
import type { CreateTokenBody, CreatedToken } from '@/api/access';

export interface TokenDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The users a token may be created for (the caller's own, plus others when allowed). */
  userids: string[];
  /** Preselected user. */
  initialUserid?: string | undefined;
}

/**
 * Creates an API token. Proxmox VE returns the token's secret exactly once: after the request
 * succeeds this dialog switches to a read-only copy box with "store it now, it will not be shown
 * again". The secret lives only in this component's state -- it is not put in the query cache, a
 * toast, a log or storage, and is gone once the dialog closes. Mount it fresh per open.
 */
export function TokenDialog({ open, onOpenChange, userids, initialUserid }: TokenDialogProps) {
  const id = useId();
  const mutation = useCreateToken();
  const [userChoice, setUserChoice] = useState<string | undefined>(initialUserid);
  const [tokenid, setTokenid] = useState('');
  const [comment, setComment] = useState('');
  const [expireText, setExpireText] = useState('');
  const [privsep, setPrivsep] = useState(true);
  const [created, setCreated] = useState<CreatedToken | undefined>(undefined);
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'failed'>('idle');

  const userid = userChoice !== undefined && userids.includes(userChoice) ? userChoice : (userids[0] ?? '');
  const idError = tokenid !== '' && !TOKEN_ID_RE.test(tokenid) ? 'Use 2 to 64 letters, digits, ".", "_" or "-".' : undefined;
  const canCreate = userid !== '' && TOKEN_ID_RE.test(tokenid) && !mutation.isPending;

  function submit() {
    if (!canCreate) return;
    const body: CreateTokenBody = { tokenid, privsep };
    if (comment.trim() !== '') body.comment = comment.trim();
    if (expireText !== '') body.expire = dateInputToExpire(expireText);
    mutation.mutate({ userid, body }, { onSuccess: (result) => setCreated(result) });
  }

  function onKeyDown(event: KeyboardEvent<HTMLElement>) {
    if (event.key === 'Enter' && event.target instanceof HTMLInputElement && created === undefined) {
      event.preventDefault();
      submit();
    }
  }

  async function copySecret() {
    if (!created) return;
    try {
      await navigator.clipboard.writeText(created.value);
      setCopyState('copied');
    } catch {
      setCopyState('failed');
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
        {created ? (
          <>
            <DialogHeader>
              <DialogTitle>Token created</DialogTitle>
              <DialogDescription>
                Store it now, it will not be shown again. Proxmox VE keeps only a hash of this secret.
              </DialogDescription>
            </DialogHeader>
            <div className="flex flex-col gap-4">
              <Field label="Token ID" htmlFor={`${id}-full`}>
                <Input id={`${id}-full`} readOnly value={created.fullTokenid} className="font-mono" />
              </Field>
              <Field label="Secret" htmlFor={`${id}-secret`}>
                <div className="flex gap-2">
                  <Input
                    id={`${id}-secret`}
                    readOnly
                    autoFocus
                    value={created.value}
                    className="font-mono"
                    onFocus={(e) => e.currentTarget.select()}
                  />
                  <Button variant="outline" onClick={() => void copySecret()}>
                    {copyState === 'copied' ? <Check className="size-4" /> : <Copy className="size-4" />}
                    {copyState === 'copied' ? 'Copied' : 'Copy'}
                  </Button>
                </div>
                {copyState === 'failed' && (
                  <p className="text-xs text-status-error">Copy failed; select the secret and copy it by hand.</p>
                )}
              </Field>
            </div>
            <DialogFooter>
              <Button onClick={() => onOpenChange(false)}>I have stored it</Button>
            </DialogFooter>
          </>
        ) : (
          <>
            <DialogHeader>
              <DialogTitle>Add API token</DialogTitle>
              <DialogDescription>
                A token lets a script or service call the API as this user. Its secret is shown once, right after you create it.
              </DialogDescription>
            </DialogHeader>
            <div className="flex flex-col gap-4">
              <Field label="User" htmlFor={`${id}-user`}>
                <NativeSelect id={`${id}-user`} value={userid} onChange={(e) => setUserChoice(e.target.value)} disabled={busy}>
                  {userids.map((u) => (
                    <option key={u} value={u}>
                      {u}
                    </option>
                  ))}
                </NativeSelect>
              </Field>
              <Field label="Token ID" htmlFor={`${id}-tokenid`} error={idError}>
                <Input
                  id={`${id}-tokenid`}
                  autoFocus
                  value={tokenid}
                  onChange={(e) => setTokenid(e.target.value)}
                  disabled={busy}
                  aria-invalid={idError !== undefined || undefined}
                  autoComplete="off"
                />
              </Field>
              <Field label="Comment" htmlFor={`${id}-comment`}>
                <Input id={`${id}-comment`} value={comment} onChange={(e) => setComment(e.target.value)} disabled={busy} />
              </Field>
              <Field label="Expire" htmlFor={`${id}-expire`} hint="Leave empty for never.">
                <Input id={`${id}-expire`} type="date" value={expireText} onChange={(e) => setExpireText(e.target.value)} disabled={busy} />
              </Field>
              <CheckField
                id={`${id}-privsep`}
                label="Privilege separation (the token needs its own permissions)"
                checked={privsep}
                onChange={setPrivsep}
                disabled={busy}
              />
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
              <Button onClick={submit} disabled={!canCreate}>
                {busy && <Loader2 className="size-4 animate-spin" />}
                Create token
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
