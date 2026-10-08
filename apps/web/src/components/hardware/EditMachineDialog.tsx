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
import { useQemuMachines, useUpdateFirmware } from '@/api/firmwareHooks';
import {
  composeMachine,
  machineVersions,
  parseMachine,
  type MachineFamily,
  type MachineSpec,
  type ViommuKind,
} from '@/api/firmware';

export interface EditMachineDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  node: string;
  vmid: number;
  /** The guest's current `machine` value (`undefined` = PVE's default, latest i440fx). */
  machine: string | number | undefined;
}

const FAMILIES: Array<{ value: MachineFamily; label: string }> = [
  { value: 'i440fx', label: 'i440fx' },
  { value: 'q35', label: 'q35' },
];

/**
 * Edits the guest's machine type: the family (i440fx or q35), an optional pinned version out of
 * the node's list ("Latest (default)" keeps it moving with PVE), and, on q35, a virtual IOMMU.
 * "Reset to default" removes the `machine` key. Mount it fresh per open.
 */
export function EditMachineDialog({ open, onOpenChange, node, vmid, machine }: EditMachineDialogProps) {
  const mutation = useUpdateFirmware();
  const machines = useQemuMachines(node);
  const ids = { version: useId(), viommu: useId() };
  const currentRaw = machine === undefined || machine === '' ? undefined : String(machine);
  const currentSpec = parseMachine(currentRaw);

  const [family, setFamily] = useState<MachineFamily>(currentSpec?.type ?? 'i440fx');
  const [version, setVersion] = useState(currentSpec?.version ?? '');
  const [viommu, setViommu] = useState<ViommuKind | ''>(currentSpec?.viommu ?? '');

  const pending = mutation.isPending;
  const offered = machineVersions(machines.data ?? [], family);
  // A version the guest is pinned to stays selectable even if the node no longer lists it.
  const versions = version !== '' && !offered.includes(version) ? [version, ...offered] : offered;

  const next: MachineSpec = {
    type: family,
    ...(version !== '' ? { version } : {}),
    ...(family === 'q35' && viommu !== '' ? { viommu } : {}),
  };
  const nextRaw = composeMachine(next);
  // No `machine` key already means i440fx / latest, so choosing exactly that changes nothing.
  const changed = currentRaw === undefined ? nextRaw !== 'pc' : nextRaw !== currentRaw;
  const canSubmit = changed && !pending;
  const serverError = mutation.isError ? hardwareErrorMessage(mutation.error, 'The machine type could not be updated.') : undefined;

  function chooseFamily(value: MachineFamily) {
    setFamily(value);
    setVersion('');
    if (value !== 'q35') setViommu('');
  }

  function submit() {
    if (!canSubmit) return;
    mutation.mutate({ node, vmid, body: { machine: next } }, { onSuccess: () => onOpenChange(false) });
  }

  function reset() {
    if (pending) return;
    mutation.mutate({ node, vmid, body: { machine: null } }, { onSuccess: () => onOpenChange(false) });
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen && pending) return;
        onOpenChange(nextOpen);
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Edit machine</DialogTitle>
          <DialogDescription>
            If the guest is running, PVE applies a machine change after its next restart.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-4">
          <fieldset className="flex flex-col gap-1.5" disabled={pending}>
            <legend className="mb-1.5 text-sm font-medium">Machine type</legend>
            <div className="flex items-center gap-4">
              {FAMILIES.map((f) => (
                <label key={f.value} className="flex items-center gap-2 text-sm">
                  <input
                    type="radio"
                    name="machine-family"
                    value={f.value}
                    checked={family === f.value}
                    onChange={() => chooseFamily(f.value)}
                  />
                  {f.label}
                </label>
              ))}
            </div>
          </fieldset>

          <div className="flex flex-col gap-1.5">
            <label htmlFor={ids.version} className="text-sm font-medium">
              Version
            </label>
            <NativeSelect
              id={ids.version}
              value={version}
              onChange={(e) => setVersion(e.target.value)}
              disabled={pending}
            >
              <option value="">Latest (default)</option>
              {versions.map((v) => (
                <option key={v} value={v}>
                  {v}
                </option>
              ))}
            </NativeSelect>
          </div>

          {family === 'q35' && (
            <div className="flex flex-col gap-1.5">
              <label htmlFor={ids.viommu} className="text-sm font-medium">
                vIOMMU
              </label>
              <NativeSelect
                id={ids.viommu}
                value={viommu}
                onChange={(e) => setViommu(e.target.value as ViommuKind | '')}
                disabled={pending}
              >
                <option value="">None</option>
                <option value="intel">Intel</option>
                <option value="virtio">VirtIO</option>
              </NativeSelect>
            </div>
          )}

          <p className="text-xs text-status-paused">
            Changing the machine type under an installed OS can make it unbootable.
          </p>

          {serverError && (
            <p role="alert" className="text-xs text-status-error">
              {serverError}
            </p>
          )}
        </div>

        <DialogFooter>
          {currentRaw !== undefined && (
            <Button variant="ghost" className="sm:mr-auto" disabled={pending} onClick={reset}>
              Reset to default
            </Button>
          )}
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
