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
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { useClusterResources } from '@/api/hooks';
import { useRestoreGuest, useRestoreNextId } from '@/api/actionHooks';
import { GuestActionError, type RestoreGuestBody } from '@/api/actions';
import { formatDateTime } from '@/lib/format';
import type { BackupContentItem, GuestType } from '@/api/types';

export interface RestoreBackupDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  node: string;
  type: GuestType;
  vmid: number;
  /** The backup being restored -- its own `volid`/`ctime` are shown at the top of the dialog. */
  item: BackupContentItem;
}

/** "Same storage as the backup" sentinel for the (optional) target-storage select -- PVE itself
 * restores onto the backup's own originating storage when `storage` is omitted from the request,
 * so this option is simply "send no `storage` field at all", not a real storage id. */
const SAME_AS_BACKUP = '__same_as_backup__';

/**
 * Restore-from-backup, following `MigrateGuestDialog`'s own shape (a plain `Dialog` with real
 * choices, not an `AlertDialog`) but turning destructive -- typed-name confirm, same convention as
 * `NodeActionDialog` -- the moment the chosen target vmid names an existing guest: PVE would
 * overwrite it, so this requires typing that vmid back before "Overwrite <id>" enables, and blocks
 * the confirm entirely while that guest is still running (PVE itself refuses that; see
 * `backupRoutes.ts`'s own `target-running` 400). Restoring to a fresh id needs no such gate --
 * the button reads "Restore as <id>" and is enabled as soon as a valid id is chosen.
 *
 * Give this a `key` that changes across opens (see `RenameGuestDialog`'s own doc comment) so a
 * fresh open starts from a clean target/storage/option selection.
 */
export function RestoreBackupDialog({ open, onOpenChange, node, type, vmid, item }: RestoreBackupDialogProps) {
  const clusterResources = useClusterResources();
  const mutation = useRestoreGuest();

  const [targetVmid, setTargetVmid] = useState(vmid);
  const [confirmText, setConfirmText] = useState('');
  const [storageOverride, setStorageOverride] = useState(SAME_AS_BACKUP);
  const [start, setStart] = useState(false);
  const [unique, setUnique] = useState(false);
  const [unprivileged, setUnprivileged] = useState(true);

  const nextId = useRestoreNextId(node, type, vmid, open);

  const existingTarget = useMemo(
    () =>
      (clusterResources.data ?? []).find(
        (r) => (r.type === 'qemu' || r.type === 'lxc') && r.vmid === targetVmid,
      ),
    [clusterResources.data, targetVmid],
  );
  const overwriting = existingTarget !== undefined;
  const targetRunning = existingTarget?.status === 'running';

  // Backup-capable (the backup itself could be restored back onto one) or image-capable (a fresh
  // guest disk lands on one) storages on this node -- the same "does this row's own `content`
  // list include X" test `BackupsTab` uses for its own storage discovery.
  const storageOptions = useMemo(
    () =>
      (clusterResources.data ?? [])
        .filter(
          (r) =>
            r.type === 'storage' &&
            r.node === node &&
            (r.content?.includes('backup') || r.content?.includes('images')),
        )
        .map((r) => r.storage)
        .filter((s): s is string => Boolean(s)),
    [clusterResources.data, node],
  );

  const serverError =
    mutation.isError && mutation.error instanceof GuestActionError
      ? mutation.error.message
      : mutation.isError
        ? 'The restore could not be started.'
        : undefined;

  const validTargetVmid = Number.isInteger(targetVmid) && targetVmid >= 100 && targetVmid <= 999_999_999;
  const confirmedName = !overwriting || confirmText === String(targetVmid);
  const blockedByRunning = overwriting && targetRunning;
  const canSubmit = validTargetVmid && confirmedName && !blockedByRunning && !mutation.isPending;

  function submit() {
    if (!canSubmit) return;
    const body: RestoreGuestBody = {
      archive: item.volid,
      targetVmid,
      ...(storageOverride !== SAME_AS_BACKUP ? { storage: storageOverride } : {}),
      start,
      ...(overwriting ? { force: true } : {}),
      ...(type === 'qemu' ? { unique } : { unprivileged }),
    };
    mutation.mutate(
      { node, type, vmid, targetVmid, body },
      { onSuccess: () => onOpenChange(false) },
    );
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
          <DialogTitle>Restore from backup</DialogTitle>
          <DialogDescription>
            {item.volid}
            {item.ctime !== undefined && ` — ${formatDateTime(item.ctime)}`}
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-1.5">
          <label className="text-sm text-muted-foreground" htmlFor="restore-target-vmid">
            Target VMID
          </label>
          <div className="flex items-center gap-2">
            <Input
              id="restore-target-vmid"
              type="number"
              min={100}
              max={999_999_999}
              value={targetVmid}
              onChange={(e) => setTargetVmid(Number(e.target.value))}
              disabled={mutation.isPending}
              className="max-w-40"
            />
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={mutation.isPending || nextId.isLoading || nextId.data === undefined}
              onClick={() => {
                if (nextId.data !== undefined) setTargetVmid(nextId.data);
              }}
            >
              Use next free ID
            </Button>
          </div>
        </div>

        {overwriting && (
          <div className="flex flex-col gap-2 rounded-md border border-status-error/40 bg-status-error/5 p-3">
            <p className="text-sm text-status-error">
              This overwrites VM {targetVmid} ({existingTarget?.name ?? `#${targetVmid}`}) with the backup. The guest
              must be stopped.
            </p>
            {blockedByRunning && <p className="text-xs text-status-error">Stop the guest first</p>}
            <div className="flex flex-col gap-1.5">
              <label className="text-sm text-muted-foreground" htmlFor="restore-confirm-vmid">
                Type the VMID to confirm
              </label>
              <Input
                id="restore-confirm-vmid"
                value={confirmText}
                onChange={(e) => setConfirmText(e.target.value)}
                disabled={mutation.isPending || blockedByRunning}
                placeholder={String(targetVmid)}
              />
            </div>
          </div>
        )}

        {storageOptions.length > 0 && (
          <div className="flex flex-col gap-1.5">
            <label className="text-sm text-muted-foreground" htmlFor="restore-storage">
              Storage
            </label>
            <Select value={storageOverride} onValueChange={setStorageOverride} disabled={mutation.isPending}>
              <SelectTrigger id="restore-storage" aria-label="Storage" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={SAME_AS_BACKUP}>Same as backup</SelectItem>
                {storageOptions.map((s) => (
                  <SelectItem key={s} value={s}>
                    {s}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        )}

        <div className="flex items-center gap-2">
          <Checkbox
            id="restore-start"
            checked={start}
            onCheckedChange={(checked) => setStart(checked === true)}
            disabled={mutation.isPending}
          />
          <label htmlFor="restore-start" className="text-sm">
            Start after restore
          </label>
        </div>

        {type === 'qemu' && (
          <div className="flex items-center gap-2">
            <Checkbox
              id="restore-unique"
              checked={unique}
              onCheckedChange={(checked) => setUnique(checked === true)}
              disabled={mutation.isPending}
            />
            <label htmlFor="restore-unique" className="text-sm">
              Regenerate unique MAC addresses
            </label>
          </div>
        )}

        {type === 'lxc' && (
          <div className="flex items-center gap-2">
            <Checkbox
              id="restore-unprivileged"
              checked={unprivileged}
              onCheckedChange={(checked) => setUnprivileged(checked === true)}
              disabled={mutation.isPending}
            />
            <label htmlFor="restore-unprivileged" className="text-sm">
              Unprivileged container
            </label>
          </div>
        )}

        {serverError && <p className="text-xs text-status-error">{serverError}</p>}

        <DialogFooter>
          <Button variant="outline" disabled={mutation.isPending} onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button disabled={!canSubmit} onClick={submit}>
            {mutation.isPending && <Loader2 className="size-4 animate-spin" />}
            {overwriting ? `Overwrite ${targetVmid}` : `Restore as ${targetVmid}`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
