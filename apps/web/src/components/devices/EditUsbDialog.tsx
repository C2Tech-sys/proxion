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
import { CheckField, PickOrType, RadioOption, RawDeviceWarning, type PickItem } from '@/components/devices/fields';
import { hardwareErrorMessage } from '@/api/hardwareHooks';
import { useHostUsb, useNextDeviceSlot, useUpsertDevice, useUsbMappings } from '@/api/deviceHooks';
import type { DeviceBody } from '@/api/devices';
import { isValidDeviceMapping, isValidUsbPort, isValidUsbVendorId, type UsbFields } from '@/lib/pve-config';

type UsbChoice = 'spice' | 'vendor' | 'port' | 'mapping';

export interface EditUsbDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  node: string;
  vmid: number;
  /** The device being edited (its config key + parsed fields). Omit to add a new device: the
   * dialog then asks the server for the next free `usb<n>` slot. */
  device?: UsbFields | undefined;
}

function initialChoice(device: UsbFields | undefined): UsbChoice {
  if (device === undefined || device.source === 'unknown') return 'vendor';
  return device.source;
}

/**
 * Adds or edits one USB device (`usb<n>`) on a qemu VM: a Spice port, a host device picked by its
 * vendor:device ID, a host device picked by its bus-port, or a cluster mapping. The host and
 * mapping lists need PVE privileges the caller may not have (`Sys.Modify`, `Mapping.Audit`); a
 * refused list falls back to a text field. The request is the device's FULL desired state.
 *
 * Mount it fresh per open (the Hardware tab renders it conditionally).
 */
export function EditUsbDialog({ open, onOpenChange, node, vmid, device }: EditUsbDialogProps) {
  const id = useId();
  const isNew = device === undefined;
  const mutation = useUpsertDevice();
  const hostUsb = useHostUsb(node);
  const mappings = useUsbMappings();
  const nextSlot = useNextDeviceSlot(node, vmid, 'usb', isNew);

  const slot = device?.key ?? nextSlot.data;

  const [choice, setChoice] = useState<UsbChoice>(initialChoice(device));
  const [vendorId, setVendorId] = useState(device?.id ?? '');
  const [port, setPort] = useState(device?.port ?? '');
  const [mapping, setMapping] = useState(device?.mapping ?? '');
  const [usb3, setUsb3] = useState(device?.usb3 ?? false);

  const hostItems = hostUsb.data?.items ?? [];
  const vendorItems: PickItem[] = hostItems.map((d) => ({
    value: d.id,
    label: `${d.id} — ${[d.manufacturer, d.product].filter(Boolean).join(' ') || 'USB device'}`,
  }));
  const portItems: PickItem[] = hostItems
    .filter((d) => d.usbpath !== undefined)
    .map((d) => ({
      value: d.usbpath!,
      label: `${d.usbpath} — ${[d.manufacturer, d.product].filter(Boolean).join(' ') || 'USB device'}`,
    }));
  const mappingItems: PickItem[] = (mappings.data?.items ?? []).map((m) => ({
    value: m.id,
    label: m.description ? `${m.id} (${m.description})` : m.id,
  }));

  const errors = {
    vendor:
      choice === 'vendor' && !isValidUsbVendorId(vendorId.trim())
        ? 'Enter a vendor:device ID like 1d6b:0003.'
        : undefined,
    port: choice === 'port' && !isValidUsbPort(port.trim()) ? 'Enter a bus-port like 1-2 or 1-2.3.' : undefined,
    mapping:
      choice === 'mapping' && !isValidDeviceMapping(mapping.trim())
        ? 'Pick or enter a mapping name (letters, digits, - and _).'
        : undefined,
  };
  const valid = Object.values(errors).every((e) => e === undefined);
  const canSave = valid && slot !== undefined && !mutation.isPending;

  const serverError = mutation.isError
    ? hardwareErrorMessage(mutation.error, 'The USB device could not be saved.')
    : undefined;
  const slotError = isNew && nextSlot.isError ? hardwareErrorMessage(nextSlot.error, 'No free USB slot was found.') : undefined;

  function buildBody(): DeviceBody {
    const extra = usb3 ? { usb3: true } : {};
    switch (choice) {
      case 'spice':
        return { kind: 'usb', source: 'spice', ...extra };
      case 'vendor':
        return { kind: 'usb', source: 'vendor', id: vendorId.trim(), ...extra };
      case 'port':
        return { kind: 'usb', source: 'port', port: port.trim(), ...extra };
      case 'mapping':
        return { kind: 'usb', source: 'mapping', mapping: mapping.trim(), ...extra };
    }
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
            {isNew ? 'Add USB device' : 'Edit USB device'}
            {slot !== undefined ? ` (${slot})` : ''}
          </DialogTitle>
          <DialogDescription>
            {isNew
              ? 'Pass a USB device through to this VM.'
              : 'Options not shown here are kept as they are.'}
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
            <RadioOption name={radioName} value="spice" checked={choice === 'spice'} label="Spice port" onSelect={() => setChoice('spice')} disabled={busy} />
            <RadioOption name={radioName} value="vendor" checked={choice === 'vendor'} label="USB vendor/device ID" onSelect={() => setChoice('vendor')} disabled={busy} />
            <RadioOption name={radioName} value="port" checked={choice === 'port'} label="USB port" onSelect={() => setChoice('port')} disabled={busy} />
            <RadioOption name={radioName} value="mapping" checked={choice === 'mapping'} label="Mapped device" onSelect={() => setChoice('mapping')} disabled={busy} />
          </fieldset>

          {choice === 'vendor' && (
            <PickOrType
              id={`${id}-vendor`}
              label="Vendor/device ID"
              items={vendorItems}
              loading={hostUsb.isLoading}
              forbidden={hostUsb.data?.forbidden === true}
              forbiddenNote="The host's USB devices could not be listed (Proxmox needs Sys.Modify); enter the ID manually."
              value={vendorId}
              onChange={setVendorId}
              placeholder="1d6b:0003"
              error={vendorId.trim() === '' ? undefined : errors.vendor}
              disabled={busy}
              pickPlaceholder="Pick a detected device..."
            />
          )}
          {choice === 'port' && (
            <PickOrType
              id={`${id}-port`}
              label="Bus-port"
              items={portItems}
              loading={hostUsb.isLoading}
              forbidden={hostUsb.data?.forbidden === true}
              forbiddenNote="The host's USB devices could not be listed (Proxmox needs Sys.Modify); enter the port manually."
              value={port}
              onChange={setPort}
              placeholder="1-2.3"
              error={port.trim() === '' ? undefined : errors.port}
              disabled={busy}
              pickPlaceholder="Pick a detected port..."
            />
          )}
          {choice === 'mapping' && (
            <PickOrType
              id={`${id}-mapping`}
              label="Mapping"
              items={mappingItems}
              loading={mappings.isLoading}
              forbidden={mappings.data?.forbidden === true}
              forbiddenNote="Device mappings could not be listed (Proxmox needs Mapping.Audit); enter the mapping name manually."
              value={mapping}
              onChange={setMapping}
              placeholder="mykeyboard"
              error={mapping.trim() === '' ? undefined : errors.mapping}
              disabled={busy}
              pickPlaceholder="Pick a mapping..."
            />
          )}

          <CheckField id={`${id}-usb3`} label="USB 3" checked={usb3} onChange={setUsb3} disabled={busy} />

          {(choice === 'vendor' || choice === 'port') && <RawDeviceWarning />}

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
            {isNew ? 'Add USB device' : 'Save'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
