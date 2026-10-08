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
import { GROUP_ID_RE, mutationErrorText } from '@/components/access/accessHelpers';
import { useCreateGroup, useUpdateGroup } from '@/api/accessHooks';
import type { AccessGroup } from '@/api/access';

export interface GroupDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The group being edited. Omit to add a new one. */
  group?: AccessGroup | undefined;
}

/** Adds a group (id + comment) or edits an existing group's comment. Mount it fresh per open. */
export function GroupDialog({ open, onOpenChange, group }: GroupDialogProps) {
  const id = useId();
  const isNew = group === undefined;
  const create = useCreateGroup();
  const update = useUpdateGroup();
  const mutation = isNew ? create : update;
  const [groupid, setGroupid] = useState('');
  const [comment, setComment] = useState(group?.comment ?? '');

  const idError = isNew && groupid !== '' && !GROUP_ID_RE.test(groupid) ? 'Use letters, digits, ".", "_" or "-" (up to 64).' : undefined;
  const canSave =
    !mutation.isPending && (isNew ? GROUP_ID_RE.test(groupid) : comment.trim() !== (group.comment ?? ''));

  function submit() {
    if (!canSave) return;
    const done = { onSuccess: () => onOpenChange(false) };
    if (group) update.mutate({ groupid: group.groupid, comment: comment.trim() }, done);
    else create.mutate({ groupid, ...(comment.trim() !== '' ? { comment: comment.trim() } : {}) }, done);
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
          <DialogTitle>{isNew ? 'Add group' : `Edit group ${group.groupid}`}</DialogTitle>
          <DialogDescription>
            {isNew ? 'Groups collect users so permissions can be granted to all of them at once.' : 'Change the comment of this group.'}
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-4">
          {isNew && (
            <Field label="Group name" htmlFor={`${id}-groupid`} error={idError}>
              <Input
                id={`${id}-groupid`}
                autoFocus
                value={groupid}
                onChange={(e) => setGroupid(e.target.value)}
                disabled={busy}
                aria-invalid={idError !== undefined || undefined}
                autoComplete="off"
              />
            </Field>
          )}
          <Field label="Comment" htmlFor={`${id}-comment`}>
            <Input
              id={`${id}-comment`}
              autoFocus={!isNew}
              value={comment}
              onChange={(e) => setComment(e.target.value)}
              disabled={busy}
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
            {isNew ? 'Add group' : 'Save'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
