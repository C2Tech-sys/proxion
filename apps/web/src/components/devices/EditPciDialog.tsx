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
import {
  CheckField,
  Field,
  PickOrType,
  RadioOption,
  RawDeviceWarning,
  type PickItem,
} from '@/components/devices/fields';
import { hardwareErrorMessage } from '@/api/hardwareHooks';
import { useHostPci, useNextDeviceSlot, usePciMappings, useUpsertDevice } from '@/api/deviceHooks';
import type { DeviceBody } from '@/api/devices';
import { isValidDeviceMapping, isValidMdevType, isValidPciId, type PciFields } from '@/lib/pve-config';

type PciChoice = 'raw' | 'mapping';

export interface EditPciDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  node: string;
  vmid: number;
  /** The device being edited (its config key + parsed fields). Omit to add a new device: the
   * dialog then asks the server for the next free `hostpci<n>` slot. */
  device?: PciFields | undefined;
}

/**
 * Adds or edits one PCI passthrough device (`hostpci<n>`) on a qemu VM: a host device (picked from
 * the node's list, grouped by IOMMU group, or typed) or a cluster mapping, plus All functions,
 * PCI-Express, ROM-Bar, Primary GPU (`x-vga`) and an MDev type. The host and mapping lists need
 * PVE privileges the caller may not have (`Sys.Modify`, `Mapping.Audit`); a refused list falls
 * back to a text field. The request is the device's FULL desired state.
 *
 * Mount it fresh per open (the Hardware tab renders it conditionally).
 */
export function EditPciDialog({ open, onOpenChange, node, vmid, device }: EditPciDialogProps) {
  const id = useId();
  const isNew = device === undefined;
  const mutation = useUpsertDevice();
  const hostPci = useHostPci(node);
  const mappings = usePciMappings();
  const nextSlot = useNextDeviceSlot(node, vmid, 'pci', isNew);

  const slot = device?.key ?? nextSlot.data;

  const [choice, setChoice] = useState<PciChoice>(device?.source === 'mapping' ? 'mapping' : 'raw');
  const [deviceId, setDeviceId] = useState(device?.id ?? '');
  const [mapping, setMapping] = useState(device?.mapping ?? '');
  const [allFunctions, setAllFunctions] = useState(device?.allFunctions ?? false);
  const [pcie, setPcie] = useState(device?.pcie ?? false);
  const [rombar, setRombar] = useState(device?.rombar ?? true);
  const [xVga, setXVga] = useState(device?.xVga ?? false);
  const [mdev, setMdev] = useState(device?.mdev ?? '');

  const hostItems: PickItem[] = (hostPci.data?.items ?? []).map((d) => ({
    value: d.id,
    group: d.iommugroup >= 0 ? `IOMMU group ${d.iommugroup}` : 'No IOMMU group',
    label: `${d.id} — ${[d.vendor_name, d.device_name].filter(Boolean).join(' ') || 'PCI device'}`,
  }));
  const mappingItems: PickItem[] = (mappings.data?.items ?? []).map((m) => ({
    value: m.id,
    label: m.description ? `${m.id} (${m.description})` : m.id,
  }));

  const errors = {
    device:
      choice === 'raw' && !isValidPciId(deviceId.trim()) ? 'Enter a PCI address like 0000:01:00.0 or 01:00.' : undefined,
    mapping:
      choice === 'mapping' && !isValidDeviceMapping(mapping.trim())
        ? 'Pick or enter a mapping name (letters, digits, - and _).'
        : undefined,
    mdev: mdev.trim() !== '' && !isValidMdevType(mdev.trim()) ? 'Use letters, digits, - _ and . only.' : undefined,
  };
  const valid = Object.values(errors).every((e) => e === undefined);
  const canSave = valid && slot !== undefined && !mutation.isPending;

  const serverError = mutation.isError
    ? hardwareErrorMessage(mutation.error, 'The PCI device could not be saved.')
    : undefined;
  const slotError = isNew && nextSlot.isError ? hardwareErrorMessage(nextSlot.error, 'No free PCI slot was found.') : undefined;

  function buildBody(): DeviceBody {
    const options = {
      ...(pcie ? { pcie: true } : {}),
      ...(rombar ? {} : { rombar: false }),
      ...(xVga ? { xVga: true } : {}),
      ...(mdev.trim() !== '' ? { mdev: mdev.trim() } : {}),
    };
    if (choice === 'mapping') return { kind: 'pci', source: 'mapping', mapping: mapping.trim(), ...options };
    return {
      kind: 'pci',
      source: 'raw',
      id: deviceId.trim(),
      ...(allFunctions ? { allFunctions: true } : {}),
      ...options,
    };
  }

  function submit() {
    if (!canSave || slot === undefined) return;
    mutation.mutate({ node, vmid, slot, body: buildBody() }, { onSuccess: () => onOpenChange(false) });
  }

  function onKeyDown(event: KeyboardEvent<HTMLElement>) {
    if (event.key === 'Enter' && event.target instanceof HTMLInputElement && event.target.type !== 'radio') {
      event.preventDefault();
      submit();
    }
  }

  const busy = mutation.isPending;
  const radioName = `${id}-source`;

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next && busy) return;
        onOpenChange(next);
      }}
    >
      <DialogContent onKeyDown={onKeyDown} className="max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>
            {isNew ? 'Add PCI device' : 'Edit PCI device'}
            {slot !== undefined ? ` (${slot})` : ''}
          </DialogTitle>
          <DialogDescription>
            {isNew
              ? 'Pass a PCI device through to this VM.'
              : 'Options not shown here (a ROM file, vendor overrides, ...) are kept as they are.'}
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-4">
          {device?.source === 'unknown' && (
            <p className="text-xs text-muted-foreground">
              This device uses a form this dialog does not recognize; saving replaces it with the choice below.
            </p>
          )}

          <fieldset className="flex flex-col gap-2" disabled={busy}>
            <legend className="mb-1 text-sm font-medium">Source</legend>
            <RadioOption name={radioName} value="raw" checked={choice === 'raw'} label="Raw device" onSelect={() => setChoice('raw')} disabled={busy} />
            <RadioOption name={radioName} value="mapping" checked={choice === 'mapping'} label="Mapped device" onSelect={() => setChoice('mapping')} disabled={busy} />
          </fieldset>

          {choice === 'raw' ? (
            <>
              <PickOrType
                id={`${id}-device`}
                label="Device"
                items={hostItems}
                loading={hostPci.isLoading}
                forbidden={hostPci.data?.forbidden === true}
                forbiddenNote="The host's PCI devices could not be listed (Proxmox needs Sys.Modify); enter the address manually."
                value={deviceId}
                onChange={setDeviceId}
                placeholder="0000:01:00.0"
                error={deviceId.trim() === '' ? undefined : errors.device}
                disabled={busy}
                pickPlaceholder="Pick a host device..."
              />
              <CheckField
                id={`${id}-allfn`}
                label="All functions"
                hint="Pass every function of the device (the address is stored without .function)."
                checked={allFunctions}
                onChange={setAllFunctions}
                disabled={busy}
              />
              <RawDeviceWarning />
            </>
          ) : (
            <PickOrType
              id={`${id}-mapping`}
              label="Mapping"
              items={mappingItems}
              loading={mappings.isLoading}
              forbidden={mappings.data?.forbidden === true}
              forbiddenNote="Device mappings could not be listed (Proxmox needs Mapping.Audit); enter the mapping name manually."
              value={mapping}
              onChange={setMapping}
              placeholder="gpu0"
              error={mapping.trim() === '' ? undefined : errors.mapping}
              disabled={busy}
              pickPlaceholder="Pick a mapping..."
            />
          )}

          <div className="flex flex-col gap-2">
            <CheckField
              id={`${id}-pcie`}
              label="PCI-Express"
              hint="Needs the q35 machine type."
              checked={pcie}
              onChange={setPcie}
              disabled={busy}
            />
            <CheckField id={`${id}-rombar`} label="ROM-Bar" checked={rombar} onChange={setRombar} disabled={busy} />
            <CheckField
              id={`${id}-xvga`}
              label="Primary GPU"
              hint="Sets x-vga=1; usually needs the OVMF BIOS and PCI-Express."
              checked={xVga}
              onChange={setXVga}
              disabled={busy}
            />
          </div>

          <Field label="MDev type" htmlFor={`${id}-mdev`} error={errors.mdev} hint="Optional. A mediated device type such as nvidia-63.">
            <Input
              id={`${id}-mdev`}
              value={mdev}
              onChange={(e) => setMdev(e.target.value)}
              disabled={busy}
              aria-invalid={errors.mdev !== undefined || undefined}
              autoComplete="off"
            />
          </Field>

          {slotError && (
            <p role="alert" className="text-xs text-status-error">
              {slotError}
            </p>
          )}
          {serverError && (
            <p role="alert" className="text-xs text-status-error">
              {serverError}
            </p>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={!canSave}>
            {busy && <Loader2 className="size-4 animate-spin" />}
            {isNew ? 'Add PCI device' : 'Save'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
