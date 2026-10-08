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
import {
  EFI_DISK_NOTE,
  PreEnrolledKeysField,
  StorageFields,
} from '@/components/hardware/AddEfiDiskDialog';
import { usePermissions } from '@/api/actionHooks';
import { hardwareErrorMessage } from '@/api/hardwareHooks';
import { useStorageChoice, useUpdateFirmware } from '@/api/firmwareHooks';
import type { FirmwareBios, FirmwareBody } from '@/api/firmware';

export interface EditBiosDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  node: string;
  vmid: number;
  /** The guest's current `bios` (`undefined` = SeaBIOS, PVE's default). */
  bios: string | undefined;
  /** Whether the config already carries an `efidisk0`. */
  hasEfidisk: boolean;
}

/**
 * Edits the guest's BIOS: SeaBIOS or OVMF (UEFI). Picking OVMF on a guest with no EFI disk also
 * offers to add one in the same save (one config write), because an OVMF guest without it loses
 * its UEFI settings on every stop. Mount it fresh per open.
 */
export function EditBiosDialog({ open, onOpenChange, node, vmid, bios, hasEfidisk }: EditBiosDialogProps) {
  const mutation = useUpdateFirmware();
  const permissions = usePermissions(vmid);
  const choice = useStorageChoice(node);
  const ids = { bios: useId(), addEfi: useId() };
  const current: FirmwareBios = bios === 'ovmf' ? 'ovmf' : 'seabios';

  const [selected, setSelected] = useState<FirmwareBios>(current);
  const [addEfi, setAddEfi] = useState(true);
  const [preEnrolledKeys, setPreEnrolledKeys] = useState(true);

  const pending = mutation.isPending;
  const offersEfi = selected === 'ovmf' && !hasEfidisk;
  const canAddDisk = permissions.data?.can('VM.Config.Disk') === true;
  const efiRequested = offersEfi && addEfi && canAddDisk;
  const efiReady = !efiRequested || (choice.selected !== undefined && choice.canAllocate);
  const changed = selected !== current || efiRequested;
  const canSubmit = changed && efiReady && !pending;
  const serverError = mutation.isError ? hardwareErrorMessage(mutation.error, 'The BIOS could not be updated.') : undefined;

  function submit() {
    if (!canSubmit) return;
    const body: FirmwareBody = {};
    if (selected !== current) body.bios = selected;
    if (efiRequested && choice.selected) {
      body.efidisk = { storage: choice.selected.id, efitype: '4m', preEnrolledKeys };
    }
    mutation.mutate({ node, vmid, body }, { onSuccess: () => onOpenChange(false) });
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
          <DialogTitle>Edit BIOS</DialogTitle>
          <DialogDescription>
            If the guest is running, PVE applies a BIOS change after its next restart.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-4">
          <div className="flex flex-col gap-1.5">
            <label htmlFor={ids.bios} className="text-sm font-medium">
              BIOS
            </label>
            <NativeSelect
              id={ids.bios}
              value={selected}
              onChange={(e) => setSelected(e.target.value as FirmwareBios)}
              disabled={pending}
            >
              <option value="seabios">SeaBIOS (default)</option>
              <option value="ovmf">OVMF (UEFI)</option>
            </NativeSelect>
          </div>

          {offersEfi && (
            <section
              aria-label="EFI disk"
              className="flex flex-col gap-3 rounded-md border border-border p-3"
              data-testid="bios-efi-section"
            >
              <div className="flex items-center gap-2">
                <Checkbox
                  id={ids.addEfi}
                  checked={addEfi && canAddDisk}
                  onCheckedChange={(c) => setAddEfi(c === true)}
                  disabled={pending || !canAddDisk}
                />
                <label htmlFor={ids.addEfi} className="text-sm font-medium">
                  Add EFI disk
                </label>
              </div>
              {!canAddDisk && (
                <p className="text-xs text-muted-foreground">You don&apos;t have VM.Config.Disk on this guest</p>
              )}
              {efiRequested && (
                <>
                  <StorageFields choice={choice} disabled={pending} />
                  <PreEnrolledKeysField checked={preEnrolledKeys} onChange={setPreEnrolledKeys} disabled={pending} />
                </>
              )}
              <p className="text-xs text-muted-foreground">{EFI_DISK_NOTE}</p>
            </section>
          )}

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
