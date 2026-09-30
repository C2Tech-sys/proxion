import { useMemo, useState } from 'react';
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
import { Textarea } from '@/components/ui/textarea';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { useClusterResources, useSnapshots } from '@/api/hooks';
import { useCloneGuest, useCloneNextId } from '@/api/actionHooks';
import { GuestActionError, type CloneGuestBody } from '@/api/actions';
import { isValidDnsName } from '@/lib/guestName';
import type { GuestType } from '@/api/types';

export interface CloneGuestDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  node: string;
  type: GuestType;
  vmid: number;
  name: string;
  status: string;
}

/** PVE's own `name`/`hostname` cap for a clone's new name, same for both guest types (the server's
 * own `cloneRoutes.ts` validates the exact same bound). */
const MAX_NAME_LENGTH = 253;

/** "Same as source" sentinel for the (optional) target-storage select -- PVE itself clones onto
 * each disk's own originating storage when `storage` is omitted from the request, so this option
 * is simply "send no `storage` field at all", same convention as `RestoreBackupDialog`'s own
 * `SAME_AS_BACKUP`. */
const SAME_AS_SOURCE = '__same_as_source__';

/** "Current state" sentinel for the (optional) snapshot select -- omitting `snapname` clones the
 * guest's current disk state, PVE's own default. */
const CURRENT_STATE = '__current_state__';

/**
 * A guest clone, following `MigrateGuestDialog`/`RestoreBackupDialog`'s own shape (a plain
 * `Dialog` with real choices, not an `AlertDialog`). The new VMID defaults from
 * `useCloneNextId` (a "Use next free ID" button re-applies it); the name defaults to
 * `<source name>-clone`. Full clone is the default and always available; Linked clone is only
 * selectable when the source guest is itself a template (`useClusterResources`'s own row for
 * `node`/`type`/`vmid`) -- PVE itself only supports a linked clone from a template. Target node
 * defaults to the guest's own node; target storage and snapshot are both optional, defaulting to
 * "same as source" / "current state" (both mean: omit the field entirely, letting PVE apply its
 * own default).
 *
 * Give this a `key` that changes across opens (see `RenameGuestDialog`'s own doc comment) so a
 * fresh open starts from a clean field/option selection.
 */
export function CloneGuestDialog({ open, onOpenChange, node, type, vmid, name, status }: CloneGuestDialogProps) {
  const clusterResources = useClusterResources();
  const snapshots = useSnapshots(node, type, vmid);
  const mutation = useCloneGuest();
  const nextId = useCloneNextId(node, type, vmid, open);

  const sourceRow = useMemo(
    () => (clusterResources.data ?? []).find((r) => r.node === node && r.type === type && r.vmid === vmid),
    [clusterResources.data, node, type, vmid],
  );
  const sourceIsTemplate = sourceRow?.template === 1;

  const [newIdOverride, setNewIdOverride] = useState<number | undefined>(undefined);
  const [newIdTouched, setNewIdTouched] = useState(false);
  // Adopts the fetched next-free-id as soon as it resolves and nothing has been chosen yet --
  // adjusted directly during render (React's own sanctioned pattern for "state derived from a
  // query", same as `MigrateGuestDialog`'s own default-target derivation), rather than a
  // `useEffect` with a `setState` in its body, which would just cost an extra commit+re-render
  // for the exact same result. Never overrides a value the user touched (`newIdTouched`) or an
  // already-defaulted one (`newIdOverride !== undefined`).
  if (!newIdTouched && newIdOverride === undefined && nextId.data !== undefined) {
    setNewIdOverride(nextId.data);
  }
  const newId = newIdOverride ?? nextId.data;

  const [nameOverride, setNameOverride] = useState<string | undefined>(undefined);
  const cloneName = nameOverride ?? `${name}-clone`;

  const [full, setFull] = useState(true);

  const nodeRows = useMemo(() => (clusterResources.data ?? []).filter((r) => r.type === 'node'), [clusterResources.data]);
  const [targetOverride, setTargetOverride] = useState<string | undefined>(undefined);
  const target = targetOverride ?? node;

  const storageOptions = useMemo(
    () =>
      (clusterResources.data ?? [])
        .filter(
          (r) =>
            r.type === 'storage' &&
            r.node === target &&
            r.content?.includes(type === 'qemu' ? 'images' : 'rootdir'),
        )
        .map((r) => r.storage)
        .filter((s): s is string => Boolean(s)),
    [clusterResources.data, target, type],
  );
  const [storageOverride, setStorageOverride] = useState(SAME_AS_SOURCE);

  const realSnapshots = useMemo(() => (snapshots.data ?? []).filter((s) => s.name !== 'current'), [snapshots.data]);
  const [snapshotOverride, setSnapshotOverride] = useState(CURRENT_STATE);

  const [description, setDescription] = useState('');

  const running = status === 'running';

  const serverError =
    mutation.isError && mutation.error instanceof GuestActionError
      ? mutation.error.message
      : mutation.isError
        ? 'The clone could not be started.'
        : undefined;

  const validNewId = newId !== undefined && Number.isInteger(newId) && newId >= 100 && newId <= 999_999_999;
  const newIdIsSourceId = newId === vmid;
  const newIdError = !validNewId
    ? 'Enter a VMID between 100 and 999999999'
    : newIdIsSourceId
      ? 'Must differ from the source VMID'
      : undefined;
  const validName = cloneName.length === 0 || isValidDnsName(cloneName, MAX_NAME_LENGTH);

  const canSubmit = validNewId && !newIdIsSourceId && validName && !mutation.isPending;

  function submit() {
    if (!canSubmit || newId === undefined) return;
    const body: CloneGuestBody = {
      newid: newId,
      full,
      target,
      ...(cloneName.length > 0 ? { name: cloneName } : {}),
      ...(storageOverride !== SAME_AS_SOURCE ? { storage: storageOverride } : {}),
      ...(snapshotOverride !== CURRENT_STATE ? { snapname: snapshotOverride } : {}),
      ...(description.length > 0 ? { description } : {}),
    };
    mutation.mutate({ node, type, vmid, name, body }, { onSuccess: () => onOpenChange(false) });
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
          <DialogTitle>Clone {name}</DialogTitle>
          <DialogDescription>Creates a new VM/CT from a copy of this guest.</DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-1.5">
          <label className="text-sm text-muted-foreground" htmlFor="clone-newid">
            New VMID
          </label>
          <div className="flex items-center gap-2">
            <Input
              id="clone-newid"
              type="number"
              min={100}
              max={999_999_999}
              value={newId ?? ''}
              onChange={(e) => {
                setNewIdTouched(true);
                setNewIdOverride(e.target.value === '' ? undefined : Number(e.target.value));
              }}
              disabled={mutation.isPending}
              className="max-w-40"
            />
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={mutation.isPending || nextId.isLoading || nextId.data === undefined}
              onClick={() => {
                setNewIdTouched(true);
                if (nextId.data !== undefined) setNewIdOverride(nextId.data);
              }}
            >
              Use next free ID
            </Button>
          </div>
          {newIdError && <p className="text-xs text-status-error">{newIdError}</p>}
        </div>

        <div className="flex flex-col gap-1.5">
          <label className="text-sm text-muted-foreground" htmlFor="clone-name">
            {type === 'lxc' ? 'Hostname' : 'Name'}
          </label>
          <Input
            id="clone-name"
            value={cloneName}
            onChange={(e) => setNameOverride(e.target.value)}
            disabled={mutation.isPending}
          />
          {!validName && <p className="text-xs text-status-error">Not a valid name</p>}
        </div>

        <div className="flex flex-col gap-1.5">
          <span className="text-sm text-muted-foreground">Mode</span>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="radio"
              name="clone-mode"
              checked={full}
              onChange={() => setFull(true)}
              disabled={mutation.isPending}
            />
            Full clone
          </label>
          <label className={`flex items-center gap-2 text-sm ${sourceIsTemplate ? '' : 'text-muted-foreground'}`}>
            <input
              type="radio"
              name="clone-mode"
              checked={!full}
              onChange={() => setFull(false)}
              disabled={mutation.isPending || !sourceIsTemplate}
            />
            Linked clone
          </label>
          {!sourceIsTemplate && <p className="text-xs text-muted-foreground">Linked clones require a template</p>}
        </div>

        <div className="flex flex-col gap-1.5">
          <label className="text-sm text-muted-foreground" htmlFor="clone-target">
            Target node
          </label>
          <Select value={target} onValueChange={setTargetOverride} disabled={mutation.isPending}>
            <SelectTrigger id="clone-target" aria-label="Target node" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {nodeRows.map((r) => (
                <SelectItem key={r.node} value={r.node} disabled={r.status !== 'online'}>
                  {r.node}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        {storageOptions.length > 0 && (
          <div className="flex flex-col gap-1.5">
            <label className="text-sm text-muted-foreground" htmlFor="clone-storage">
              Target storage
            </label>
            <Select value={storageOverride} onValueChange={setStorageOverride} disabled={mutation.isPending}>
              <SelectTrigger id="clone-storage" aria-label="Target storage" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={SAME_AS_SOURCE}>Same as source</SelectItem>
                {storageOptions.map((s) => (
                  <SelectItem key={s} value={s}>
                    {s}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        )}

        {realSnapshots.length > 0 && (
          <div className="flex flex-col gap-1.5">
            <label className="text-sm text-muted-foreground" htmlFor="clone-snapshot">
              Snapshot
            </label>
            <Select value={snapshotOverride} onValueChange={setSnapshotOverride} disabled={mutation.isPending}>
              <SelectTrigger id="clone-snapshot" aria-label="Snapshot" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={CURRENT_STATE}>Current state</SelectItem>
                {realSnapshots.map((s) => (
                  <SelectItem key={s.name} value={s.name}>
                    {s.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        )}

        <div className="flex flex-col gap-1.5">
          <label className="text-sm text-muted-foreground" htmlFor="clone-description">
            Description
          </label>
          <Textarea
            id="clone-description"
            rows={2}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            disabled={mutation.isPending}
          />
        </div>

        {type === 'qemu' && running && (
          <p className="text-xs text-muted-foreground">
            A running VM is cloned from its current disk state; stop it first if you need a consistent copy.
          </p>
        )}

        {serverError && <p className="text-xs text-status-error">{serverError}</p>}

        <DialogFooter>
          <Button variant="outline" disabled={mutation.isPending} onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button disabled={!canSubmit} onClick={submit}>
            {mutation.isPending && <Loader2 className="size-4 animate-spin" />}
            Clone
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
