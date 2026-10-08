import { useId, useState, type KeyboardEvent } from 'react';
import { ListTree, Loader2, Pencil, Plus, Trash2 } from 'lucide-react';

import { EmptyState } from '@/components/EmptyState';
import { Panel } from '@/components/Panel';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
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
import {
  useAddIpsetEntry,
  useClusterIpsets,
  useDeleteIpset,
  useDeleteIpsetEntry,
  useIpsetEntries,
  useSaveIpset,
  useUpdateIpsetEntry,
} from '@/api/clusterFirewallHooks';
import { CLUSTER_FIREWALL_TARGET, type ClusterIpset, type ClusterIpsetEntry, type FirewallTarget } from '@/api/clusterFirewall';

interface IpsetDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The set being edited. Omit to create one. */
  ipset?: ClusterIpset | undefined;
  target: FirewallTarget;
}

/** Creates an IP set, or renames / re-comments one. PVE's own field semantics: `name` is the (new)
 * name and `rename` the existing one (equal to `name` to change only the comment). Mount it fresh
 * per open. */
function IpsetDialog({ open, onOpenChange, ipset, target }: IpsetDialogProps) {
  const id = useId();
  const mutation = useSaveIpset(target);
  const isNew = ipset === undefined;
  const [name, setName] = useState(ipset?.name ?? '');
  const [comment, setComment] = useState(ipset?.comment ?? '');

  const n = name.trim();
  const note = comment.trim();
  const nameError = n !== '' && !ALIAS_NAME_RE.test(n) ? 'Start with a letter; 2 to 64 letters, digits, "-" or "_".' : undefined;
  const noteError = commentError(note);
  const changed = isNew || n !== ipset.name || note !== (ipset.comment ?? '');
  const canSave = ALIAS_NAME_RE.test(n) && noteError === undefined && changed && !mutation.isPending;
  const busy = mutation.isPending;

  function submit() {
    if (!canSave) return;
    mutation.mutate(
      {
        name: n,
        ...(note !== '' ? { comment: note } : {}),
        ...(!isNew ? { rename: ipset.name, ...(ipset.digest !== undefined ? { digest: ipset.digest } : {}) } : {}),
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
          <DialogTitle>{isNew ? 'Create IP set' : `Edit IP set ${ipset.name}`}</DialogTitle>
          <DialogDescription>
            An IP set groups addresses and networks so a rule can name them all with +name.
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
              placeholder="trusted"
              autoComplete="off"
              autoFocus
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
              {hardwareErrorMessage(mutation.error, 'The IP set could not be saved.')}
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

interface EntryDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  ipset: string;
  /** The entry being edited. Omit to add one. */
  entry?: ClusterIpsetEntry | undefined;
  target: FirewallTarget;
}

/** Adds an entry to an IP set, or edits one's `nomatch` flag and comment (the address is the entry's
 * identity, so it cannot change). `nomatch` excludes the address from the set, e.g. a host inside a
 * network that is otherwise listed. Mount it fresh per open. */
function EntryDialog({ open, onOpenChange, ipset, entry, target }: EntryDialogProps) {
  const id = useId();
  const add = useAddIpsetEntry(target);
  const update = useUpdateIpsetEntry(target);
  const mutation = entry === undefined ? add : update;
  const [cidr, setCidr] = useState(entry?.cidr ?? '');
  const [nomatch, setNomatch] = useState(entry?.nomatch ?? false);
  const [comment, setComment] = useState(entry?.comment ?? '');

  const c = cidr.trim();
  const note = comment.trim();
  const cidrError = c !== '' && !isAddressOrCidr(c) ? 'Use an IPv4 or IPv6 address, or a CIDR such as 10.0.0.0/24.' : undefined;
  const noteError = commentError(note);
  const changed = entry === undefined || nomatch !== entry.nomatch || note !== (entry.comment ?? '');
  const canSave = isAddressOrCidr(c) && noteError === undefined && changed && !mutation.isPending;
  const busy = mutation.isPending;

  function submit() {
    if (!canSave) return;
    const done = { onSuccess: () => onOpenChange(false) };
    if (entry === undefined) {
      add.mutate({ name: ipset, cidr: c, nomatch, ...(note !== '' ? { comment: note } : {}) }, done);
    } else {
      // PVE clears the comment when none is sent.
      update.mutate(
        {
          name: ipset,
          cidr: entry.cidr,
          nomatch,
          ...(note !== '' ? { comment: note } : {}),
          ...(entry.digest !== undefined ? { digest: entry.digest } : {}),
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
          <DialogTitle>{entry === undefined ? `Add entry to ${ipset}` : `Edit entry ${entry.cidr}`}</DialogTitle>
          <DialogDescription>
            {entry === undefined
              ? 'An address or network that belongs to the set.'
              : 'Only the exclusion flag and the comment can change; delete and re-add the entry to change its address.'}
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-4">
          <Field label="IP/CIDR" htmlFor={`${id}-cidr`} error={cidrError}>
            <Input
              id={`${id}-cidr`}
              value={cidr}
              onChange={(e) => setCidr(e.target.value)}
              disabled={busy || entry !== undefined}
              aria-invalid={cidrError !== undefined || undefined}
              placeholder="10.0.0.0/24"
              autoComplete="off"
              autoFocus={entry === undefined}
            />
          </Field>
          <div className="flex items-center gap-2">
            <Checkbox
              id={`${id}-nomatch`}
              checked={nomatch}
              onCheckedChange={(checked) => setNomatch(checked === true)}
              disabled={busy}
            />
            <label htmlFor={`${id}-nomatch`} className="text-sm">
              Exclude (nomatch): traffic from this address is not part of the set
            </label>
          </div>
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
              {hardwareErrorMessage(mutation.error, 'The entry could not be saved.')}
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

function DeleteIpsetDialog({
  ipset,
  target,
  onOpenChange,
}: {
  ipset: ClusterIpset;
  target: FirewallTarget;
  onOpenChange: (open: boolean) => void;
}) {
  const mutation = useDeleteIpset(target);
  return (
    <ConfirmDialog
      open
      onOpenChange={onOpenChange}
      title={`Delete IP set ${ipset.name}?`}
      description="The set and every entry in it are removed; Proxmox VE refuses if a rule still uses the set."
      confirmLabel="Delete IP set"
      pending={mutation.isPending}
      error={mutation.isError ? hardwareErrorMessage(mutation.error, 'The IP set could not be deleted.') : undefined}
      onConfirm={() => mutation.mutate({ name: ipset.name, force: true }, { onSuccess: () => onOpenChange(false) })}
    />
  );
}

function DeleteEntryDialog({
  ipset,
  entry,
  target,
  onOpenChange,
}: {
  ipset: string;
  entry: ClusterIpsetEntry;
  target: FirewallTarget;
  onOpenChange: (open: boolean) => void;
}) {
  const mutation = useDeleteIpsetEntry(target);
  return (
    <ConfirmDialog
      open
      onOpenChange={onOpenChange}
      title={`Remove ${entry.cidr} from ${ipset}?`}
      description="Rules that use the set no longer match this address."
      confirmLabel="Remove entry"
      pending={mutation.isPending}
      error={mutation.isError ? hardwareErrorMessage(mutation.error, 'The entry could not be removed.') : undefined}
      onConfirm={() =>
        mutation.mutate({ name: ipset, cidr: entry.cidr, digest: entry.digest }, { onSuccess: () => onOpenChange(false) })
      }
    />
  );
}

type SetDialog = { kind: 'create' } | { kind: 'edit'; ipset: ClusterIpset } | { kind: 'delete'; ipset: ClusterIpset };
type EntryDialogTarget =
  | { kind: 'add' }
  | { kind: 'edit'; entry: ClusterIpsetEntry }
  | { kind: 'delete'; entry: ClusterIpsetEntry };

function EntriesPanel({
  ipset,
  disabledReason,
  target,
}: {
  ipset: string;
  disabledReason: string | undefined;
  target: FirewallTarget;
}) {
  const entries = useIpsetEntries(ipset, target);
  const tid = target.kind === 'guest' ? 'guest-fw' : 'dc-fw';
  const [dialog, setDialog] = useState<EntryDialogTarget | null>(null);
  const locked = disabledReason !== undefined;
  const list = entries.data ?? [];

  return (
    <div data-testid={`${tid}-ipset-entries`}>
      <Panel
        title={`Entries: ${ipset}`}
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
            Add entry
          </Button>
        }
      >
        {entries.isLoading ? (
          <Skeleton className="h-24 w-full" />
        ) : entries.isError ? (
          <EmptyState message={`Could not load the IP set: ${errorMessage(entries.error)}`} />
        ) : list.length === 0 ? (
          <EmptyState message="This IP set has no entries." />
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>IP/CIDR</TableHead>
                <TableHead>Exclude</TableHead>
                <TableHead>Comment</TableHead>
                <TableHead>
                  <span className="sr-only">Actions</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {list.map((e) => (
                <TableRow key={e.cidr} data-testid={`${tid}-ipset-entry-${e.cidr}`}>
                  <TableCell className="font-medium">{e.cidr}</TableCell>
                  <TableCell>{e.nomatch ? 'nomatch' : <span className="text-muted-foreground">-</span>}</TableCell>
                  <TableCell>
                    <Cell value={e.comment} />
                  </TableCell>
                  <TableCell>
                    <div className="flex items-center justify-end">
                      <RowButton
                        label={`Edit entry ${e.cidr}`}
                        icon={Pencil}
                        disabledReason={disabledReason}
                        onClick={() => setDialog({ kind: 'edit', entry: e })}
                      />
                      <RowButton
                        label={`Remove entry ${e.cidr}`}
                        icon={Trash2}
                        destructive
                        disabledReason={disabledReason}
                        onClick={() => setDialog({ kind: 'delete', entry: e })}
                      />
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </Panel>

      {dialog?.kind === 'add' && (
        <EntryDialog open onOpenChange={(open) => !open && setDialog(null)} ipset={ipset} target={target} />
      )}
      {dialog?.kind === 'edit' && (
        <EntryDialog
          open
          onOpenChange={(open) => !open && setDialog(null)}
          ipset={ipset}
          entry={dialog.entry}
          target={target}
        />
      )}
      {dialog?.kind === 'delete' && (
        <DeleteEntryDialog
          ipset={ipset}
          entry={dialog.entry}
          target={target}
          onOpenChange={(open) => !open && setDialog(null)}
        />
      )}
    </div>
  );
}

export interface IpSetsPanelProps {
  /** When set, every control is disabled and this is its tooltip. */
  disabledReason: string | undefined;
  /** Whose IP sets: the datacenter firewall's (the default) or one guest's. */
  target?: FirewallTarget;
}

/** PVE's Firewall -> IPSet (datacenter or guest): the sets (create / rename / delete) and the entries
 * of the selected set (add / edit / remove, with the `nomatch` exclusion flag). */
export function IpSetsPanel({ disabledReason, target = CLUSTER_FIREWALL_TARGET }: IpSetsPanelProps) {
  const ipsets = useClusterIpsets(target);
  const tid = target.kind === 'guest' ? 'guest-fw' : 'dc-fw';
  const [dialog, setDialog] = useState<SetDialog | null>(null);
  const [selected, setSelected] = useState<string | undefined>(undefined);
  const locked = disabledReason !== undefined;
  const list = ipsets.data ?? [];
  const selectedSet = list.find((s) => s.name === selected)?.name;

  return (
    <div data-testid={`${tid}-ipsets`} className="flex flex-col gap-4">
      <Panel
        title="IP sets"
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
            Create IP set
          </Button>
        }
      >
        {ipsets.isLoading ? (
          <Skeleton className="h-24 w-full" />
        ) : ipsets.isError ? (
          <EmptyState message={`Could not load the IP sets: ${errorMessage(ipsets.error)}`} />
        ) : list.length === 0 ? (
          <EmptyState message="No IP sets." />
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
              {list.map((s) => (
                <TableRow key={s.name} data-testid={`${tid}-ipset-${s.name}`} data-state={s.name === selectedSet ? 'selected' : undefined}>
                  <TableCell className="font-medium">{s.name}</TableCell>
                  <TableCell>
                    <Cell value={s.comment} />
                  </TableCell>
                  <TableCell>
                    <div className="flex items-center justify-end">
                      <Button
                        variant="ghost"
                        size="icon"
                        className="size-7"
                        aria-label={`Show entries of ${s.name}`}
                        aria-pressed={s.name === selectedSet}
                        title={`Show entries of ${s.name}`}
                        onClick={() => setSelected(s.name === selectedSet ? undefined : s.name)}
                      >
                        <ListTree className="size-3.5" />
                      </Button>
                      <RowButton
                        label={`Edit IP set ${s.name}`}
                        icon={Pencil}
                        disabledReason={disabledReason}
                        onClick={() => setDialog({ kind: 'edit', ipset: s })}
                      />
                      <RowButton
                        label={`Delete IP set ${s.name}`}
                        icon={Trash2}
                        destructive
                        disabledReason={disabledReason}
                        onClick={() => setDialog({ kind: 'delete', ipset: s })}
                      />
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </Panel>

      {selectedSet !== undefined && (
        <EntriesPanel key={selectedSet} ipset={selectedSet} disabledReason={disabledReason} target={target} />
      )}

      {dialog?.kind === 'create' && (
        <IpsetDialog open onOpenChange={(open) => !open && setDialog(null)} target={target} />
      )}
      {dialog?.kind === 'edit' && (
        <IpsetDialog open onOpenChange={(open) => !open && setDialog(null)} ipset={dialog.ipset} target={target} />
      )}
      {dialog?.kind === 'delete' && (
        <DeleteIpsetDialog ipset={dialog.ipset} target={target} onOpenChange={(open) => !open && setDialog(null)} />
      )}
    </div>
  );
}
