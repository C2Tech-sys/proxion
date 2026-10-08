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
import { StorageFields } from '@/components/hardware/AddEfiDiskDialog';
import { hardwareErrorMessage } from '@/api/hardwareHooks';
import { useStorageChoice, useUpdateFirmware } from '@/api/firmwareHooks';
import type { TpmStateSpec } from '@/api/firmware';

export interface AddTpmStateDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  node: string;
  vmid: number;
}

const TPM_VERSIONS: Array<{ value: TpmStateSpec['version']; label: string }> = [
  { value: 'v2.0', label: 'v2.0 (recommended)' },
  { value: 'v1.2', label: 'v1.2' },
];

/**
 * Adds the TPM state disk (`tpmstate0`): the storage it lives on and the TPM version. Windows 11
 * needs v2.0. Mount it fresh per open.
 */
export function AddTpmStateDialog({ open, onOpenChange, node, vmid }: AddTpmStateDialogProps) {
  const mutation = useUpdateFirmware();
  const choice = useStorageChoice(node);
  const versionId = useId();
  const [version, setVersion] = useState<TpmStateSpec['version']>('v2.0');
  const pending = mutation.isPending;
  const canSubmit = choice.selected !== undefined && choice.canAllocate && !pending;
  const serverError = mutation.isError
    ? hardwareErrorMessage(mutation.error, 'The TPM state could not be added.')
    : undefined;

  function submit() {
    if (!canSubmit || !choice.selected) return;
    mutation.mutate(
      { node, vmid, body: { tpmstate: { storage: choice.selected.id, version } } },
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
          <DialogTitle>Add TPM state</DialogTitle>
          <DialogDescription>
            Adds a virtual TPM. Its state is a small disk on the chosen storage; Windows 11 needs v2.0.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-4">
          <StorageFields choice={choice} disabled={pending} />
          <div className="flex flex-col gap-1.5">
            <label htmlFor={versionId} className="text-sm font-medium">
              Version
            </label>
            <NativeSelect
              id={versionId}
              value={version}
              onChange={(e) => setVersion(e.target.value as TpmStateSpec['version'])}
              disabled={pending}
            >
              {TPM_VERSIONS.map((v) => (
                <option key={v.value} value={v.value}>
                  {v.label}
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
            Add
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
