import { useState } from 'react';
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
import { useBackupGuest } from '@/api/actionHooks';
import { GuestActionError, type BackupGuestBody } from '@/api/actions';
import type { GuestType } from '@/api/types';

export interface BackupNowDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  node: string;
  type: GuestType;
  vmid: number;
  name: string;
  /** Backup-capable storages on this node (cluster resources whose `content` includes `backup`),
   * in display order -- the first is the select's default. Always non-empty: `BackupsTab` never
   * opens this dialog otherwise (see its own "No backup-capable storage on this node" gating). */
  storages: string[];
}

const MODE_HELP: Record<BackupGuestBody['mode'], string> = {
  snapshot: 'No downtime -- Proxmox snapshots the disks while the guest keeps running.',
  suspend: 'The guest is paused for the backup, then resumed.',
  stop: 'The guest is stopped for the backup, then started again.',
};

const COMPRESS_LABEL: Record<NonNullable<BackupGuestBody['compress']>, string> = {
  zstd: 'zstd (fast, good ratio)',
  gzip: 'gzip',
  lzo: 'lzo (fastest, larger)',
  '0': 'None',
};

/** Default notes-template -- PVE expands `{{guestname}}`/`{{node}}`/`{{vmid}}` itself, matching
 * the default the Proxmox web UI's own backup dialog offers. */
const DEFAULT_NOTES = '{{guestname}}';

/** PVE's own cap on a `notes-template` this app enforces client-side too (`backupRoutes.ts`'s own
 * `MAX_NOTES_LENGTH`). */
const MAX_NOTES_LENGTH = 512;

/**
 * "Backup now" (vzdump), in a plain `Dialog` (not `AlertDialog` -- this isn't a confirmation, it's
 * a form), following `SnapshotCreateDialog`/`MigrateGuestDialog`'s own shape: a storage select
 * (backup-capable storages on this node, defaulting to the first), a backup mode select (snapshot
 * default, with a one-line explainer for each), a compression select (zstd default), a "Protected"
 * checkbox, a notes field (defaulting to `{{guestname}}`), and an "Apply storage retention" checkbox
 * (off by default -- PVE otherwise never prunes older backups on its own). Give this a `key` that
 * changes across opens (see `RenameGuestDialog`'s own doc comment) so a fresh open starts from
 * clean fields.
 */
export function BackupNowDialog({ open, onOpenChange, node, type, vmid, name, storages }: BackupNowDialogProps) {
  const [storage, setStorage] = useState(storages[0] ?? '');
  const [mode, setMode] = useState<BackupGuestBody['mode']>('snapshot');
  const [compress, setCompress] = useState<NonNullable<BackupGuestBody['compress']>>('zstd');
  const [isProtected, setIsProtected] = useState(false);
  const [notes, setNotes] = useState(DEFAULT_NOTES);
  const [prune, setPrune] = useState(false);
  const mutation = useBackupGuest();

  const serverError =
    mutation.isError && mutation.error instanceof GuestActionError
      ? mutation.error.message
      : mutation.isError
        ? 'The backup could not be started.'
        : undefined;

  function submit() {
    if (!storage || mutation.isPending) return;
    const body: BackupGuestBody = {
      storage,
      mode,
      compress,
      protected: isProtected,
      notes: notes.trim(),
      prune,
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
          <DialogTitle>Back up {name}</DialogTitle>
          <DialogDescription>Starts a Proxmox backup (vzdump) job for this guest.</DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-1.5">
          <label className="text-sm text-muted-foreground" htmlFor="backup-storage">
            Storage
          </label>
          <Select value={storage} onValueChange={setStorage} disabled={mutation.isPending}>
            <SelectTrigger id="backup-storage" aria-label="Storage" className="w-full">
              <SelectValue placeholder="Choose a storage" />
            </SelectTrigger>
            <SelectContent>
              {storages.map((s) => (
                <SelectItem key={s} value={s}>
                  {s}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="flex flex-col gap-1.5">
          <label className="text-sm text-muted-foreground" htmlFor="backup-mode">
            Mode
          </label>
          <Select value={mode} onValueChange={(v) => setMode(v as BackupGuestBody['mode'])} disabled={mutation.isPending}>
            <SelectTrigger id="backup-mode" aria-label="Mode" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="snapshot">Snapshot</SelectItem>
              <SelectItem value="suspend">Suspend</SelectItem>
              <SelectItem value="stop">Stop</SelectItem>
            </SelectContent>
          </Select>
          <p className="text-xs text-muted-foreground">{MODE_HELP[mode]}</p>
        </div>

        <div className="flex flex-col gap-1.5">
          <label className="text-sm text-muted-foreground" htmlFor="backup-compress">
            Compression
          </label>
          <Select
            value={compress}
            onValueChange={(v) => setCompress(v as NonNullable<BackupGuestBody['compress']>)}
            disabled={mutation.isPending}
          >
            <SelectTrigger id="backup-compress" aria-label="Compression" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {(Object.keys(COMPRESS_LABEL) as Array<NonNullable<BackupGuestBody['compress']>>).map((c) => (
                <SelectItem key={c} value={c}>
                  {COMPRESS_LABEL[c]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="flex flex-col gap-1.5">
          <label className="text-sm text-muted-foreground" htmlFor="backup-notes">
            Notes
          </label>
          <Input
            id="backup-notes"
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            disabled={mutation.isPending}
            maxLength={MAX_NOTES_LENGTH}
          />
        </div>

        <div className="flex items-center gap-2">
          <Checkbox
            id="backup-protected"
            checked={isProtected}
            onCheckedChange={(checked) => setIsProtected(checked === true)}
            disabled={mutation.isPending}
          />
          <label htmlFor="backup-protected" className="text-sm">
            Protected
          </label>
        </div>

        <div className="flex items-center gap-2">
          <Checkbox
            id="backup-prune"
            checked={prune}
            onCheckedChange={(checked) => setPrune(checked === true)}
            disabled={mutation.isPending}
          />
          <label htmlFor="backup-prune" className="text-sm">
            Apply storage retention (prune old backups)
          </label>
        </div>

        {serverError && <p className="text-xs text-status-error">{serverError}</p>}

        <DialogFooter>
          <Button variant="outline" disabled={mutation.isPending} onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button disabled={!storage || mutation.isPending} onClick={submit}>
            {mutation.isPending && <Loader2 className="size-4 animate-spin" />}
            Start backup
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
