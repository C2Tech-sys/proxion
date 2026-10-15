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
import { IsoStorageGroup, NO_MEDIA } from '@/components/hardware/EditCdromDialog';
import { useClusterResources } from '@/api/hooks';
import { cdromSlotLabel, freeCdromSlots, storagesWithContent } from '@/api/disks';
import { useUpdateHardware, hardwareErrorMessage } from '@/api/hardwareHooks';
import type { GuestType } from '@/api/types';

export interface AddCdromDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  node: string;
  type: GuestType;
  vmid: number;
  /** The guest's config keys, so slots already in use are not offered. */
  configKeys: readonly string[];
}

/**
 * Adds a CD/DVD drive to a VM: pick the bus/slot (first free one preselected) and either no media
 * or an ISO from this node's storage. It goes through the same hardware patch `EditCdromDialog`
 * uses (`{ cdrom: { slot, iso } }`; the server accepts an absent slot as a new drive), and the
 * Hardware tab's pending banner reports a drive PVE is holding back for a restart.
 *
 * The session-mode / `VM.Config.CDROM` gate lives on the button that opens this dialog. No extra
 * storage privilege is checked here: whether the caller may read the chosen ISO's storage is for
 * the server and PVE to decide (their message is shown inline).
 *
 * Mount it fresh per open (the Hardware tab renders it conditionally).
 */
export function AddCdromDialog({ open, onOpenChange, node, type, vmid, configKeys }: AddCdromDialogProps) {
  const mutation = useUpdateHardware();
  const resources = useClusterResources();
  const slotId = useId();
  const isoId = useId();

  const freeSlots = useMemo(() => freeCdromSlots(configKeys), [configKeys]);
  const [slot, setSlot] = useState(freeSlots[0] ?? '');
  const [iso, setIso] = useState(NO_MEDIA);

  const isoStorages = useMemo(
    () => storagesWithContent(resources.data, node, 'iso').map((s) => s.id),
    [resources.data, node],
  );

  const pending = mutation.isPending;
  const noFreeSlot = freeSlots.length === 0;
  const canSubmit = !noFreeSlot && slot !== '' && !pending;
  const serverError = mutation.isError
    ? hardwareErrorMessage(mutation.error, 'The CD/DVD drive could not be added.')
    : undefined;

  function submit() {
    if (!canSubmit) return;
    mutation.mutate(
      { node, type, vmid, patch: { cdrom: { slot, iso: iso === NO_MEDIA ? null : iso } } },
      { onSuccess: () => onOpenChange(false) },
    );
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next && pending) return;
        onOpenChange(next);
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add CD/DVD drive</DialogTitle>
          <DialogDescription>
            The drive is added to the config now; a running VM sees it after a restart (PVE shows it as pending).
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-4">
          <div className="flex flex-col gap-1.5">
            <label htmlFor={slotId} className="text-sm font-medium">
              Bus/Slot
            </label>
            <NativeSelect
              id={slotId}
              value={slot}
              onChange={(e) => setSlot(e.target.value)}
              disabled={pending || noFreeSlot}
            >
              {freeSlots.map((s) => (
                <option key={s} value={s}>
                  {cdromSlotLabel(s)}
                </option>
              ))}
            </NativeSelect>
            {noFreeSlot && (
              <p className="text-xs text-status-error" data-testid="cdrom-no-free-slot">
                Every IDE, SATA and SCSI slot of this VM is in use; remove a drive first.
              </p>
            )}
          </div>

          <div className="flex flex-col gap-1.5">
            <label htmlFor={isoId} className="text-sm font-medium">
              Media
            </label>
            <NativeSelect id={isoId} value={iso} onChange={(e) => setIso(e.target.value)} disabled={pending}>
              <option value={NO_MEDIA}>No media</option>
              {isoStorages.map((storage) => (
                <IsoStorageGroup key={storage} node={node} storage={storage} />
              ))}
            </NativeSelect>
            {isoStorages.length === 0 && !resources.isLoading && (
              <p className="text-xs text-muted-foreground">No storage on this node holds ISO images.</p>
            )}
          </div>

          {serverError && (
            <p role="alert" className="text-xs text-status-error">
              {serverError}
            </p>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" disabled={pending} onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button disabled={!canSubmit} onClick={submit}>
            {pending && <Loader2 className="size-4 animate-spin" />}
            Add
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
