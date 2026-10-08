import { useId, useState, type KeyboardEvent } from 'react';
import { ListTree, Loader2, Pencil, Plus, Trash2 } from 'lucide-react';

import { EmptyState } from '@/components/EmptyState';
import { Panel } from '@/components/Panel';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { ClusterRulesPanel } from '@/components/clusterfirewall/ClusterRulesPanel';
import { Cell, ConfirmDialog, Field, RowButton } from '@/components/clusterfirewall/shared';
import { GROUP_NAME_RE, commentError } from '@/components/clusterfirewall/helpers';
import { errorMessage } from '@/api/errors';
import { hardwareErrorMessage } from '@/api/hardwareHooks';
import { useClusterGroups, useDeleteSecurityGroup, useSaveSecurityGroup } from '@/api/clusterFirewallHooks';
import type { ClusterSecurityGroup } from '@/api/clusterFirewall';

interface GroupDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The group being edited. Omit to create one. */
  group?: ClusterSecurityGroup | undefined;
}

/** Creates a security group, or renames / re-comments one. PVE's own field semantics: `group` is
 * the (new) name and `rename` the existing one (equal to `group` to change only the comment). Mount
 * it fresh per open. */
function GroupDialog({ open, onOpenChange, group }: GroupDialogProps) {
  const id = useId();
  const mutation = useSaveSecurityGroup();
  const isNew = group === undefined;
  const [name, setName] = useState(group?.group ?? '');
  const [comment, setComment] = useState(group?.comment ?? '');

  const trimmedName = name.trim();
  const trimmedComment = comment.trim();
  const nameError = trimmedName !== '' && !GROUP_NAME_RE.test(trimmedName)
    ? 'Start with a letter; 2 to 20 letters, digits, "-" or "_".'
    : undefined;
  const cError = commentError(trimmedComment);
  const changed = isNew || trimmedName !== group.group || trimmedComment !== (group.comment ?? '');
  const canSave = GROUP_NAME_RE.test(trimmedName) && cError === undefined && changed && !mutation.isPending;
  const busy = mutation.isPending;

  function submit() {
    if (!canSave) return;
    mutation.mutate(
      {
        group: trimmedName,
        ...(trimmedComment !== '' ? { comment: trimmedComment } : {}),
        ...(!isNew ? { rename: group.group, ...(group.digest !== undefined ? { digest: group.digest } : {}) } : {}),
      },
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
          <DialogTitle>{isNew ? 'Create security group' : `Edit security group ${group.group}`}</DialogTitle>
          <DialogDescription>
            {isNew
              ? 'A security group is a named set of rules that guests and the datacenter can apply.'
              : 'Renaming a group that rules still reference is refused by Proxmox VE.'}
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-4">
          <Field label="Name" htmlFor={`${id}-name`} error={nameError}>
            <Input
              id={`${id}-name`}
              value={name}
              onChange={(e) => setName(e.target.value)}
              disabled={busy}
              aria-invalid={nameError !== undefined || undefined}
              placeholder="webservers"
              autoComplete="off"
              autoFocus
            />
          </Field>
          <Field label="Comment" htmlFor={`${id}-comment`} error={cError}>
            <Input
              id={`${id}-comment`}
              value={comment}
              onChange={(e) => setComment(e.target.value)}
              disabled={busy}
              autoComplete="off"
            />
          </Field>
          {mutation.isError && (
            <p role="alert" className="text-xs text-status-error">
              {hardwareErrorMessage(mutation.error, 'The security group could not be saved.')}
            </p>
          )}
        </div>
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

type DialogTarget =
  | { kind: 'create' }
  | { kind: 'edit'; group: ClusterSecurityGroup }
  | { kind: 'delete'; group: ClusterSecurityGroup };

function DeleteGroupDialog({
  group,
  onOpenChange,
}: {
  group: ClusterSecurityGroup;
  onOpenChange: (open: boolean) => void;
}) {
  const mutation = useDeleteSecurityGroup();
  return (
    <ConfirmDialog
      open
      onOpenChange={onOpenChange}
      title={`Delete security group ${group.group}?`}
      description="The group and every rule in it are removed; Proxmox VE refuses if a rule still applies the group."
      confirmLabel="Delete group"
      pending={mutation.isPending}
      error={mutation.isError ? hardwareErrorMessage(mutation.error, 'The security group could not be deleted.') : undefined}
      onConfirm={() => mutation.mutate(group.group, { onSuccess: () => onOpenChange(false) })}
    />
  );
}

export interface SecurityGroupsPanelProps {
  /** When set, every control is disabled and this is its tooltip. */
  disabledReason: string | undefined;
}

/** PVE's Datacenter -> Firewall -> Security Group: the groups, create / rename / delete, and the
 * rules inside the selected group (the same rule table and dialogs as the datacenter's own rules). */
export function SecurityGroupsPanel({ disabledReason }: SecurityGroupsPanelProps) {
  const groups = useClusterGroups();
  const [dialog, setDialog] = useState<DialogTarget | null>(null);
  const [selected, setSelected] = useState<string | undefined>(undefined);
  const locked = disabledReason !== undefined;
  const list = groups.data ?? [];
  // A group that was deleted or renamed away is no longer selected.
  const selectedGroup = list.find((g) => g.group === selected)?.group;

  return (
    <div data-testid="dc-fw-groups" className="flex flex-col gap-4">
      <Panel
        title="Security groups"
        action={
          <Button
            variant="outline"
            size="sm"
            disabled={locked}
            aria-disabled={locked || undefined}
            title={disabledReason}
            onClick={() => setDialog({ kind: 'create' })}
          >
            <Plus className="size-3.5" />
            Create group
          </Button>
        }
      >
        {groups.isLoading ? (
          <Skeleton className="h-24 w-full" />
        ) : groups.isError ? (
          <EmptyState message={`Could not load the security groups: ${errorMessage(groups.error)}`} />
        ) : list.length === 0 ? (
          <EmptyState message="No security groups." />
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>Comment</TableHead>
                <TableHead>
                  <span className="sr-only">Actions</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {list.map((g) => (
                <TableRow key={g.group} data-testid={`dc-fw-group-${g.group}`} data-state={g.group === selectedGroup ? 'selected' : undefined}>
                  <TableCell className="font-medium">{g.group}</TableCell>
                  <TableCell>
                    <Cell value={g.comment} />
                  </TableCell>
                  <TableCell>
                    <div className="flex items-center justify-end">
                      <Button
                        variant="ghost"
                        size="icon"
                        className="size-7"
                        aria-label={`Show rules of ${g.group}`}
                        aria-pressed={g.group === selectedGroup}
                        title={`Show rules of ${g.group}`}
                        onClick={() => setSelected(g.group === selectedGroup ? undefined : g.group)}
                      >
                        <ListTree className="size-3.5" />
                      </Button>
                      <RowButton
                        label={`Edit group ${g.group}`}
                        icon={Pencil}
                        disabledReason={disabledReason}
                        onClick={() => setDialog({ kind: 'edit', group: g })}
                      />
                      <RowButton
                        label={`Delete group ${g.group}`}
                        icon={Trash2}
                        destructive
                        disabledReason={disabledReason}
                        onClick={() => setDialog({ kind: 'delete', group: g })}
                      />
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </Panel>

      {selectedGroup !== undefined && (
        <ClusterRulesPanel
          key={selectedGroup}
          scope={{ kind: 'group', group: selectedGroup }}
          title={`Rules: ${selectedGroup}`}
          disabledReason={disabledReason}
        />
      )}

      {dialog?.kind === 'create' && <GroupDialog open onOpenChange={(open) => !open && setDialog(null)} />}
      {dialog?.kind === 'edit' && (
        <GroupDialog open onOpenChange={(open) => !open && setDialog(null)} group={dialog.group} />
      )}
      {dialog?.kind === 'delete' && (
        <DeleteGroupDialog group={dialog.group} onOpenChange={(open) => !open && setDialog(null)} />
      )}
    </div>
  );
}
