import { NativeSelect } from '@/components/hardware/NativeSelect';
import { CheckRow, Field, StorageSelect, type StepProps } from '@/components/create/vm/fields';
import type { CreateVmBios, CreateVmMachine, CreateVmScsiHw, CreateVmVga } from '@/api/createVm';

const VGA_OPTIONS: Array<{ value: CreateVmVga | ''; label: string }> = [
  { value: '', label: 'Default' },
  { value: 'std', label: 'Standard VGA (std)' },
  { value: 'virtio', label: 'VirtIO-GPU (virtio)' },
  { value: 'qxl', label: 'SPICE (qxl)' },
  { value: 'serial0', label: 'Serial terminal 0 (serial0)' },
  { value: 'none', label: 'none' },
];

/** Step 3: machine type, BIOS (+ EFI disk storage), TPM (+ state storage), SCSI controller, display. */
export function StepSystem({ form, patch, data, disabled }: StepProps) {
  const isWin11 = form.ostype === 'win11';
  return (
    <div className="flex flex-col gap-4">
      <Field label="Machine">
        {(id) => (
          <NativeSelect
            id={id}
            value={form.machine}
            onChange={(e) => patch({ machine: e.target.value as CreateVmMachine })}
            disabled={disabled}
          >
            <option value="q35">q35</option>
            <option value="pc">i440fx (default)</option>
          </NativeSelect>
        )}
      </Field>

      <Field
        label="BIOS"
        hint={isWin11 ? 'Windows 11 needs OVMF (UEFI) and a TPM.' : undefined}
      >
        {(id) => (
          <NativeSelect
            id={id}
            value={form.bios}
            onChange={(e) => patch({ bios: e.target.value as CreateVmBios })}
            disabled={disabled}
          >
            <option value="seabios">SeaBIOS (default)</option>
            <option value="ovmf">OVMF (UEFI)</option>
          </NativeSelect>
        )}
      </Field>

      {form.bios === 'ovmf' && (
        <Field
          label="EFI storage"
          hint={
            data.imageStorages.length === 0
              ? 'No storage on this node can hold disk images.'
              : 'Holds the small EFI variables disk (pre-enrolled keys, 4m).'
          }
        >
          {(id) => (
            <StorageSelect
              id={id}
              value={form.efiStorage}
              onChange={(efiStorage) => patch({ efiStorage })}
              storages={data.imageStorages}
              disabled={disabled}
            />
          )}
        </Field>
      )}

      <CheckRow
        label="Add TPM"
        checked={form.tpm}
        onChange={(tpm) => patch({ tpm, tpmTouched: true })}
        disabled={disabled}
        hint="A virtual TPM 2.0 (v2.0 state disk). Defaults on for Windows 11."
      />

      {form.tpm && (
        <Field label="TPM storage">
          {(id) => (
            <StorageSelect
              id={id}
              value={form.tpmStorage}
              onChange={(tpmStorage) => patch({ tpmStorage })}
              storages={data.imageStorages}
              disabled={disabled}
            />
          )}
        </Field>
      )}

      <Field label="SCSI controller">
        {(id) => (
          <NativeSelect
            id={id}
            value={form.scsihw}
            onChange={(e) => patch({ scsihw: e.target.value as CreateVmScsiHw })}
            disabled={disabled}
          >
            <option value="virtio-scsi-single">VirtIO SCSI single (default)</option>
            <option value="virtio-scsi-pci">VirtIO SCSI</option>
            <option value="lsi">LSI 53C895A</option>
          </NativeSelect>
        )}
      </Field>

      <Field label="Display">
        {(id) => (
          <NativeSelect
            id={id}
            value={form.vga}
            onChange={(e) => patch({ vga: e.target.value as CreateVmVga | '' })}
            disabled={disabled}
          >
            {VGA_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </NativeSelect>
        )}
      </Field>
    </div>
  );
}
