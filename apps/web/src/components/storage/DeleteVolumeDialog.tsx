import { Loader2 } from 'lucide-react';

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { KeyValueGrid } from '@/components/KeyValueGrid';
import { useStorageDelete } from '@/api/actionHooks';
import { formatBytes } from '@/lib/format';
import { stripStoragePrefix } from '@/lib/storageList';
import type { BackupContentItem, StorageContentItem } from '@/api/types';

export interface DeleteVolumeDialogProps {
  node: string;
  storage: string;
  /** The volume to confirm deleting, or `null` to render nothing (closed). */
  item: StorageContentItem | null;
  onOpenChange: (open: boolean) => void;
}

/**
 * Confirmation for a storage content delete (T32 addendum) -- shows the volume's own id, size,
 * and (for a backup) its owner vmid, then a plain "Delete volume" confirm; no typed-name gate
 * (unlike `NodeActionDialog`'s node-wide blast radius, this affects exactly one already-named
 * volume the caller just chose from a row menu). PVE's own refusal for a protected backup or an
 * in-use disk is surfaced by `useStorageDelete`'s own error toast, not pre-empted here.
 */
export function DeleteVolumeDialog({ node, storage, item, onOpenChange }: DeleteVolumeDialogProps) {
  const mutation = useStorageDelete();

  if (!item) return null;

  const name = stripStoragePrefix(item.volid);
  const ownerVmid = (item as BackupContentItem).vmid;

  function handleConfirm() {
    if (mutation.isPending || !item) return;
    mutation.mutate(
      { node, storage, volid: item.volid, name, ...(ownerVmid !== undefined ? { vmid: ownerVmid } : {}) },
      { onSettled: () => onOpenChange(false) },
    );
  }

  return (
    <AlertDialog
      open
      onOpenChange={(open) => {
        if (!open && !mutation.isPending) onOpenChange(false);
      }}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete {name}?</AlertDialogTitle>
          <AlertDialogDescription>
            This permanently deletes the volume. Proxmox refuses if it is in use or protected.
          </AlertDialogDescription>
        </AlertDialogHeader>

        <KeyValueGrid
          rows={[
            { label: 'Volume', value: item.volid },
            { label: 'Size', value: formatBytes(item.size) },
            ...(ownerVmid !== undefined ? [{ label: 'Owner VMID', value: String(ownerVmid) }] : []),
          ]}
        />

        <AlertDialogFooter>
          <AlertDialogCancel disabled={mutation.isPending}>Cancel</AlertDialogCancel>
          <AlertDialogAction
            variant="destructive"
            disabled={mutation.isPending}
            onClick={(event) => {
              event.preventDefault();
              handleConfirm();
            }}
          >
            {mutation.isPending && <Loader2 className="size-4 animate-spin" />}
            Delete volume
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
