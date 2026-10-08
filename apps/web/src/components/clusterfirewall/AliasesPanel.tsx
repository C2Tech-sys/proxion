import { useId, useState, type KeyboardEvent } from 'react';
import { Loader2, Pencil, Plus, Trash2 } from 'lucide-react';

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
import { Cell, ConfirmDialog, Field, RowButton } from '@/components/clusterfirewall/shared';
import { ALIAS_NAME_RE, commentError, isAddressOrCidr } from '@/components/clusterfirewall/helpers';
import { errorMessage } from '@/api/errors';
import { hardwareErrorMessage } from '@/api/hardwareHooks';
import { useClusterAliases, useCreateAlias, useDeleteAlias, useUpdateAlias } from '@/api/clusterFirewallHooks';
import { CLUSTER_FIREWALL_TARGET, type ClusterAlias, type FirewallTarget } from '@/api/clusterFirewall';

interface AliasDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The alias being edited. Omit to add one. */
  alias?: ClusterAlias | undefined;
  /** The firewall the alias lives in: the datacenter's or one guest's. */
  target: FirewallTarget;
}

/** Adds or edits (and renames) one alias. An edit sends the path name, the new name only when it
 * changed, and the digest of the last read. Mount it fresh per open. */
function AliasDialog({ open, onOpenChange, alias, target }: AliasDialogProps) {
  const id = useId();
  const create = useCreateAlias(target);
  const update = useUpdateAlias(target);
  const mutation = alias === undefined ? create : update;
  const [name, setName] = useState(alias?.name ?? '');
  const [cidr, setCidr] = useState(alias?.cidr ?? '');
  const [comment, setComment] = useState(alias?.comment ?? '');

  const n = name.trim();
  const c = cidr.trim();
  const note = comment.trim();
  const nameError = n !== '' && !ALIAS_NAME_RE.test(n) ? 'Start with a letter; 2 to 64 letters, digits, "-" or "_".' : undefined;
  const cidrError = c !== '' && !isAddressOrCidr(c) ? 'Use an IPv4 or IPv6 address, or a CIDR such as 10.0.0.0/24.' : undefined;
  const noteError = commentError(note);
  const changed = alias === undefined || n !== alias.name || c !== alias.cidr || note !== (alias.comment ?? '');
  const canSave =
    ALIAS_NAME_RE.test(n) && isAddressOrCidr(c) && noteError === undefined && changed && !mutation.isPending;
  const busy = mutation.isPending;

  function submit() {
    if (!canSave) return;
    const done = { onSuccess: () => onOpenChange(false) };
    if (alias === undefined) {
      create.mutate({ name: n, cidr: c, ...(note !== '' ? { comment: note } : {}) }, done);
    } else {
      update.mutate(
        {
          name: alias.name,
          cidr: c,
          // PVE clears the comment when none is sent.
          ...(note !== '' ? { comment: note } : {}),
          ...(n !== alias.name ? { rename: n } : {}),
          ...(alias.digest !== undefined ? { digest: alias.digest } : {}),
        },
        done,
      );
    }
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
          <DialogTitle>{alias === undefined ? 'Add alias' : `Edit alias ${alias.name}`}</DialogTitle>
          <DialogDescription>
            An alias gives an address or network a name that rules can use as a source or destination.
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
              placeholder="office"
              autoComplete="off"
              autoFocus
            />
          </Field>
          <Field label="IP/CIDR" htmlFor={`${id}-cidr`} error={cidrError}>
            <Input
              id={`${id}-cidr`}
              value={cidr}
              onChange={(e) => setCidr(e.target.value)}
              disabled={busy}
              aria-invalid={cidrError !== undefined || undefined}
              placeholder="10.0.0.0/24"
              autoComplete="off"
            />
          </Field>
          <Field label="Comment" htmlFor={`${id}-comment`} error={noteError}>
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
              {hardwareErrorMessage(mutation.error, 'The alias could not be saved.')}
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

function DeleteAliasDialog({
  alias,
  target,
  onOpenChange,
}: {
  alias: ClusterAlias;
  target: FirewallTarget;
  onOpenChange: (open: boolean) => void;
}) {
  const mutation = useDeleteAlias(target);
  return (
    <ConfirmDialog
      open
      onOpenChange={onOpenChange}
      title={`Delete alias ${alias.name}?`}
      description="Rules that still use the alias as a source or destination stop matching until it is replaced; Proxmox VE refuses if one does."
      confirmLabel="Delete alias"
      pending={mutation.isPending}
      error={mutation.isError ? hardwareErrorMessage(mutation.error, 'The alias could not be deleted.') : undefined}
      onConfirm={() => mutation.mutate({ name: alias.name, digest: alias.digest }, { onSuccess: () => onOpenChange(false) })}
    />
  );
}

type DialogTarget =
  | { kind: 'add' }
  | { kind: 'edit'; alias: ClusterAlias }
  | { kind: 'delete'; alias: ClusterAlias };

export interface AliasesPanelProps {
  /** When set, every control is disabled and this is its tooltip. */
  disabledReason: string | undefined;
  /** Whose aliases: the datacenter firewall's (the default) or one guest's. */
  target?: FirewallTarget;
}

/** PVE's Firewall -> Alias (datacenter or guest): named addresses and networks. */
export function AliasesPanel({ disabledReason, target = CLUSTER_FIREWALL_TARGET }: AliasesPanelProps) {
  const aliases = useClusterAliases(target);
  const tid = target.kind === 'guest' ? 'guest-fw' : 'dc-fw';
  const [dialog, setDialog] = useState<DialogTarget | null>(null);
  const locked = disabledReason !== undefined;
  const list = aliases.data ?? [];

  return (
    <div data-testid={`${tid}-aliases`}>
      <Panel
        title="Aliases"
        action={
          <Button
            variant="outline"
            size="sm"
            disabled={locked}
            aria-disabled={locked || undefined}
            title={disabledReason}
            onClick={() => setDialog({ kind: 'add' })}
          >
            <Plus className="size-3.5" />
            Add alias
          </Button>
        }
      >
        {aliases.isLoading ? (
          <Skeleton className="h-24 w-full" />
        ) : aliases.isError ? (
          <EmptyState message={`Could not load the aliases: ${errorMessage(aliases.error)}`} />
        ) : list.length === 0 ? (
          <EmptyState message="No aliases." />
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>IP/CIDR</TableHead>
                <TableHead>Comment</TableHead>
                <TableHead>
                  <span className="sr-only">Actions</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {list.map((a) => (
                <TableRow key={a.name} data-testid={`${tid}-alias-${a.name}`}>
                  <TableCell className="font-medium">{a.name}</TableCell>
                  <TableCell>{a.cidr}</TableCell>
                  <TableCell>
                    <Cell value={a.comment} />
                  </TableCell>
                  <TableCell>
                    <div className="flex items-center justify-end">
                      <RowButton
                        label={`Edit alias ${a.name}`}
                        icon={Pencil}
                        disabledReason={disabledReason}
                        onClick={() => setDialog({ kind: 'edit', alias: a })}
                      />
                      <RowButton
                        label={`Delete alias ${a.name}`}
                        icon={Trash2}
                        destructive
                        disabledReason={disabledReason}
                        onClick={() => setDialog({ kind: 'delete', alias: a })}
                      />
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </Panel>

      {dialog?.kind === 'add' && <AliasDialog open onOpenChange={(open) => !open && setDialog(null)} target={target} />}
      {dialog?.kind === 'edit' && (
        <AliasDialog open onOpenChange={(open) => !open && setDialog(null)} alias={dialog.alias} target={target} />
      )}
      {dialog?.kind === 'delete' && (
        <DeleteAliasDialog alias={dialog.alias} target={target} onOpenChange={(open) => !open && setDialog(null)} />
      )}
    </div>
  );
}
