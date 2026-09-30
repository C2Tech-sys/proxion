import { useId, useMemo, useState } from 'react';
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
import { NativeSelect } from '@/components/hardware/NativeSelect';
import { useClusterResources, useStorageContent } from '@/api/hooks';
import { useUpdateHardware, hardwareErrorMessage } from '@/api/hardwareHooks';
import { formatBytes } from '@/lib/format';
import { isMountableIsoVolid } from '@/lib/pve-config';
import type { GuestType } from '@/api/types';

export interface EditCdromDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  node: string;
  type: GuestType;
  vmid: number;
  /** The drive's config key, e.g. `ide2`. */
  slot: string;
  /** The volume currently in the drive (`local:iso/foo.iso`), `undefined` when empty. */
  currentVolid: string | undefined;
}

/** "No media" choice -- sent as `iso: null` (PVE `none,media=cdrom`). */
const NO_MEDIA = '';

/** The ISOs of one storage as an `<optgroup>`. A component of its own because each storage needs
 * its own `useStorageContent` query. Renders nothing for a storage with no mountable ISO. */
function IsoStorageGroup({ node, storage, exclude }: { node: string; storage: string; exclude?: string | undefined }) {
  const content = useStorageContent(node, storage);
  const isos = (content.data ?? []).filter(
    (item) => item.content === 'iso' && isMountableIsoVolid(item.volid) && item.volid !== exclude,
  );
  if (isos.length === 0) return null;
  return (
    <optgroup label={storage}>
      {isos.map((item) => (
        <option key={item.volid} value={item.volid}>
          {item.volid.slice(item.volid.indexOf(':iso/') + ':iso/'.length)} ({formatBytes(item.size)})
        </option>
      ))}
    </optgroup>
  );
}

/**
 * Changes the media in one CD/DVD drive: pick an ISO from any iso-capable storage on this node
 * (each storage's own content list), or "No media" to eject. Only ISOs the server route accepts
 * are offered (`isMountableIsoVolid`). Media changes apply to a running guest right away.
 *
 * Mount it fresh per open (the Hardware tab renders it conditionally).
 */
export function EditCdromDialog({ open, onOpenChange, node, type, vmid, slot, currentVolid }: EditCdromDialogProps) {
  const mutation = useUpdateHardware();
  const resources = useClusterResources();
  const selectId = useId();

  const initial = currentVolid ?? NO_MEDIA;
  const [selected, setSelected] = useState(initial);

  const isoStorages = useMemo(
    () =>
      (resources.data ?? [])
        .filter(
          (r) =>
            r.type === 'storage' &&
            r.node === node &&
            r.storage !== undefined &&
            (r.content ?? '').split(',').includes('iso'),
        )
        .map((r) => r.storage as string),
    [resources.data, node],
  );

  const serverError = mutation.isError
    ? hardwareErrorMessage(mutation.error, 'The CD/DVD drive could not be updated.')
    : undefined;
  const changed = selected !== initial;

  function submit() {
    if (!changed || mutation.isPending) return;
    mutation.mutate(
      { node, type, vmid, patch: { cdrom: { slot, iso: selected === NO_MEDIA ? null : selected } } },
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
          <DialogTitle>Edit CD/DVD drive ({slot})</DialogTitle>
          <DialogDescription>Choose an ISO image from this node&apos;s storage, or eject the media.</DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-1.5">
          <label htmlFor={selectId} className="text-sm font-medium">
            ISO image
          </label>
          <NativeSelect
            id={selectId}
            value={selected}
            onChange={(e) => setSelected(e.target.value)}
            disabled={mutation.isPending}
          >
            <option value={NO_MEDIA}>No media</option>
            {/* The drive's current volume is always an option of its own (and left out of its
                storage's group below): the storage lists load asynchronously in child components,
                and a controlled <select> whose value isn't among its options yet would show the
                wrong selection until something re-rendered it. */}
            {currentVolid !== undefined && <option value={currentVolid}>{currentVolid} (current)</option>}
            {isoStorages.map((storage) => (
              <IsoStorageGroup key={storage} node={node} storage={storage} exclude={currentVolid} />
            ))}
          </NativeSelect>
          {isoStorages.length === 0 && !resources.isLoading && (
            <p className="text-xs text-muted-foreground">No storage on this node holds ISO images.</p>
          )}
          {serverError && (
            <p role="alert" className="text-xs text-status-error">
              {serverError}
            </p>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" disabled={mutation.isPending} onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button disabled={!changed || mutation.isPending} onClick={submit}>
            {mutation.isPending && <Loader2 className="size-4 animate-spin" />}
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
