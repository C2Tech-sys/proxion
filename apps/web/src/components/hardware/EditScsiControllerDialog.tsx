import { useId, useState } from 'react';
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
import { hardwareErrorMessage } from '@/api/hardwareHooks';
import { useUpdateFirmware } from '@/api/firmwareHooks';

export interface EditScsiControllerDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  node: string;
  vmid: number;
  /** The guest's current `scsihw` (`undefined` = PVE's default, LSI 53C895A). */
  scsihw: string | undefined;
}

/** PVE's own labels for the `scsihw` choices. */
const CONTROLLERS: Array<{ value: string; label: string }> = [
  { value: 'lsi', label: 'LSI 53C895A (default)' },
  { value: 'lsi53c810', label: 'LSI 53C810' },
  { value: 'virtio-scsi-pci', label: 'VirtIO SCSI' },
  { value: 'virtio-scsi-single', label: 'VirtIO SCSI single' },
  { value: 'megasas', label: 'MegaRAID SAS 8708EM2' },
  { value: 'pvscsi', label: 'VMware PVSCSI' },
];

/** Edits the SCSI controller model. Mount it fresh per open. */
export function EditScsiControllerDialog({ open, onOpenChange, node, vmid, scsihw }: EditScsiControllerDialogProps) {
  const mutation = useUpdateFirmware();
  const id = useId();
  const current = scsihw ?? 'lsi';
  const [selected, setSelected] = useState(current);
  const pending = mutation.isPending;
  const canSubmit = selected !== current && !pending;
  const serverError = mutation.isError
    ? hardwareErrorMessage(mutation.error, 'The SCSI controller could not be updated.')
    : undefined;

  function submit() {
    if (!canSubmit) return;
    mutation.mutate({ node, vmid, body: { scsihw: selected } }, { onSuccess: () => onOpenChange(false) });
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
          <DialogTitle>Edit SCSI controller</DialogTitle>
          <DialogDescription>
            VirtIO SCSI single gives each disk its own IO thread. If the guest is running, PVE applies the change
            after its next restart.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-4">
          <div className="flex flex-col gap-1.5">
            <label htmlFor={id} className="text-sm font-medium">
              SCSI controller
            </label>
            <NativeSelect id={id} value={selected} onChange={(e) => setSelected(e.target.value)} disabled={pending}>
              {CONTROLLERS.map((c) => (
                <option key={c.value} value={c.value}>
                  {c.label}
                </option>
              ))}
            </NativeSelect>
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
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
