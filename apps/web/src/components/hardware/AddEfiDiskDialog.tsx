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
import { Checkbox } from '@/components/ui/checkbox';
import { NativeSelect } from '@/components/hardware/NativeSelect';
import { hardwareErrorMessage } from '@/api/hardwareHooks';
import { useStorageChoice, useUpdateFirmware, type StorageChoice } from '@/api/firmwareHooks';
import { formatBytes } from '@/lib/format';

/** The "Storage" picker shared by the EFI disk and TPM state forms, with the standard hints when
 * nothing can hold the volume or the caller may not allocate on the chosen storage. */
export function StorageFields({
  choice,
  disabled,
}: {
  choice: StorageChoice;
  disabled: boolean;
}) {
  const id = useId();
  const { storages, selected, setChoice, canAllocate } = choice;
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={id} className="text-sm font-medium">
        Storage
      </label>
      <NativeSelect
        id={id}
        value={selected?.id ?? ''}
        onChange={(e) => setChoice(e.target.value)}
        disabled={disabled || storages.length === 0}
      >
        {storages.map((s) => (
          <option key={s.id} value={s.id}>
            {s.id}
            {s.freeBytes !== undefined ? ` (${formatBytes(s.freeBytes)} free)` : ''}
          </option>
        ))}
      </NativeSelect>
      {storages.length === 0 && (
        <p className="text-xs text-muted-foreground">No storage on this node can hold disk images.</p>
      )}
      {selected !== undefined && !canAllocate && (
        <p className="text-xs text-status-error" data-testid="storage-permission-hint">
          You don&apos;t have Datastore.AllocateSpace on {selected.id}
        </p>
      )}
    </div>
  );
}

/** The "Pre-enrolled keys" checkbox of an EFI disk. */
export function PreEnrolledKeysField({
  checked,
  onChange,
  disabled,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  disabled: boolean;
}) {
  const id = useId();
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center gap-2">
        <Checkbox id={id} checked={checked} onCheckedChange={(c) => onChange(c === true)} disabled={disabled} />
        <label htmlFor={id} className="text-sm">
          Pre-enrolled keys
        </label>
      </div>
      <p className="text-xs text-muted-foreground">
        Loads the Microsoft and distribution Secure Boot keys. Turn it off to enrol your own.
      </p>
    </div>
  );
}

/** The sentence the EFI disk forms show: why the disk matters. */
export const EFI_DISK_NOTE =
  'Without an EFI disk Proxmox uses a temporary one and UEFI settings are lost on every stop.';

export interface AddEfiDiskDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  node: string;
  vmid: number;
}

/**
 * Adds the EFI disk (`efidisk0`) an OVMF guest keeps its UEFI variables on. Always the 4m type;
 * pre-enrolled keys are on unless unticked. Mount it fresh per open.
 */
export function AddEfiDiskDialog({ open, onOpenChange, node, vmid }: AddEfiDiskDialogProps) {
  const mutation = useUpdateFirmware();
  const choice = useStorageChoice(node);
  const [preEnrolledKeys, setPreEnrolledKeys] = useState(true);
  const pending = mutation.isPending;
  const canSubmit = choice.selected !== undefined && choice.canAllocate && !pending;
  const serverError = mutation.isError
    ? hardwareErrorMessage(mutation.error, 'The EFI disk could not be added.')
    : undefined;

  function submit() {
    if (!canSubmit || !choice.selected) return;
    mutation.mutate(
      { node, vmid, body: { efidisk: { storage: choice.selected.id, efitype: '4m', preEnrolledKeys } } },
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
          <DialogTitle>Add EFI disk</DialogTitle>
          <DialogDescription>{EFI_DISK_NOTE}</DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-4">
          <StorageFields choice={choice} disabled={pending} />
          <PreEnrolledKeysField checked={preEnrolledKeys} onChange={setPreEnrolledKeys} disabled={pending} />
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
