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
import { hardwareErrorMessage, type useResizeDisk } from '@/api/hardwareHooks';
import { formatDriveSize } from '@/lib/format';
import { gibToResizeSize, parseSizeToGiB } from '@/lib/pve-config';
import type { GuestType } from '@/api/types';

export interface ResizeDiskDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  node: string;
  type: GuestType;
  vmid: number;
  /** The disk's config key: `scsi0`, `virtio1`, `rootfs`, `mp0`, ... */
  disk: string;
  /** The drive's current `size=` value as PVE reports it (`32G`). */
  size: string | undefined;
  /** The resize mutation, owned by the caller (`HardwareTab`) rather than created here: this
   * dialog unmounts the moment a resize succeeds, and the hook's delayed re-reads must outlive
   * it. The caller resets it before each open so a previous error doesn't linger. */
  mutation: ReturnType<typeof useResizeDisk>;
}

/** Up to 64 TiB in one step -- far beyond any real request, it only stops a typo. */
const MAX_ADD_GIB = 65536;

/** A positive number of GiB (decimals allowed), or `undefined` for anything else. */
function parseAddGiB(text: string): number | undefined {
  const trimmed = text.trim();
  if (!/^\d+(\.\d+)?$/.test(trimmed)) return undefined;
  const n = Number(trimmed);
  return n > 0 && n <= MAX_ADD_GIB ? n : undefined;
}

/**
 * Grows one disk. The current size is shown and the user enters how much to ADD in GiB; the
 * request is always the relative `+<n>G` form, so a shrink can't be expressed at all (PVE refuses
 * one anyway). Growing doesn't touch the filesystem inside the guest -- the dialog says so.
 *
 * Mount it fresh per open (the Hardware tab renders it conditionally).
 */
export function ResizeDiskDialog({
  open,
  onOpenChange,
  node,
  type,
  vmid,
  disk,
  size,
  mutation,
}: ResizeDiskDialogProps) {
  const inputId = useId();
  const [addText, setAddText] = useState('');

  const addGiB = parseAddGiB(addText);
  const currentGiB = parseSizeToGiB(size);
  const showInvalid = addText.trim() !== '' && addGiB === undefined;
  const serverError = mutation.isError
    ? hardwareErrorMessage(mutation.error, 'The disk could not be resized.')
    : undefined;

  function submit() {
    if (addGiB === undefined || mutation.isPending) return;
    mutation.mutate(
      { node, type, vmid, body: { disk, size: gibToResizeSize(addGiB) } },
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
        if (!next && mutation.isPending) return;
        onOpenChange(next);
      }}
    >
      <DialogContent onKeyDown={onKeyDown}>
        <DialogHeader>
          <DialogTitle>Resize disk ({disk})</DialogTitle>
          <DialogDescription>
            Disks can only grow; extend the filesystem inside the guest afterwards.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-4">
          <p className="text-sm">
            Current size: <span className="font-medium">{formatDriveSize(size)}</span>
          </p>

          <div className="flex flex-col gap-1.5">
            <label htmlFor={inputId} className="text-sm font-medium">
              Add (GiB)
            </label>
            <Input
              id={inputId}
              autoFocus
              type="number"
              inputMode="decimal"
              min={0}
              step="any"
              placeholder="10"
              value={addText}
              onChange={(e) => setAddText(e.target.value)}
              disabled={mutation.isPending}
              aria-invalid={showInvalid || undefined}
            />
            {showInvalid ? (
              <p className="text-xs text-status-error">Enter a number of GiB greater than zero.</p>
            ) : addGiB !== undefined && currentGiB !== null ? (
              <p className="text-xs text-muted-foreground">
                New size: {Math.round((currentGiB + addGiB) * 100) / 100} GiB
              </p>
            ) : null}
          </div>

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
          <Button disabled={addGiB === undefined || mutation.isPending} onClick={submit}>
            {mutation.isPending && <Loader2 className="size-4 animate-spin" />}
            Resize
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
