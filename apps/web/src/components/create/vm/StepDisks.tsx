import { Input } from '@/components/ui/input';
import { NativeSelect } from '@/components/hardware/NativeSelect';
import { CheckRow, Field, StorageSelect, type StepProps } from '@/components/create/vm/fields';
import { MAX_DISK_GIB, parseIntIn, typedError } from '@/components/create/vm/wizardState';
import { inferStorageFormats, type DiskBus, type DiskCache, type DiskFormat } from '@/api/disks';
import { formatBytes } from '@/lib/format';

const BUS_LABELS: Record<DiskBus, string> = {
  scsi: 'SCSI',
  virtio: 'VirtIO Block',
  sata: 'SATA',
  ide: 'IDE',
};
const BUSES: DiskBus[] = ['scsi', 'virtio', 'sata', 'ide'];

const CACHE_MODES: Array<{ value: DiskCache; label: string }> = [
  { value: 'none', label: 'No cache' },
  { value: 'writethrough', label: 'Write through' },
  { value: 'writeback', label: 'Write back' },
  { value: 'unsafe', label: 'Write back (unsafe)' },
  { value: 'directsync', label: 'Direct sync' },
];

/** Step 4: one disk (bus, storage, size, format, cache and options), or none at all. */
export function StepDisks({ form, patch, errors, data, disabled }: StepProps) {
  const storage = data.imageStorages.find((s) => s.id === form.diskStorage);
  const formatInfo = storage ? (data.formats?.[storage.id] ?? inferStorageFormats(storage.plugintype)) : undefined;
  const offersFormatChoice = formatInfo !== undefined && formatInfo.formats.length > 1;
  const sizeGiB = parseIntIn(form.sizeText, 1, MAX_DISK_GIB);
  const exceedsFree =
    storage?.freeBytes !== undefined && sizeGiB !== undefined && sizeGiB * 1024 ** 3 > storage.freeBytes;
  const supportsSsd = form.bus !== 'virtio';
  const supportsIothread = form.bus === 'scsi' || form.bus === 'virtio';
  const sizeError = typedError(form.sizeText, errors.size);

  return (
    <div className="flex flex-col gap-4">
      <CheckRow
        label="No disk"
        checked={form.noDisk}
        onChange={(noDisk) => patch({ noDisk })}
        disabled={disabled}
        hint="Create the VM without a disk; add one later from the Hardware tab."
      />

      {!form.noDisk && (
        <>
          <Field label="Bus">
            {(id) => (
              <NativeSelect
                id={id}
                value={form.bus}
                onChange={(e) => patch({ bus: e.target.value as DiskBus })}
                disabled={disabled}
              >
                {BUSES.map((b) => (
                  <option key={b} value={b}>
                    {BUS_LABELS[b]}
                  </option>
                ))}
              </NativeSelect>
            )}
          </Field>

          <Field
            label="Storage"
            hint={data.imageStorages.length === 0 ? 'No storage on this node can hold disk images.' : undefined}
          >
            {(id) => (
              <StorageSelect
                id={id}
                value={form.diskStorage}
                onChange={(diskStorage) => patch({ diskStorage, format: '' })}
                storages={data.imageStorages}
                disabled={disabled}
              />
            )}
          </Field>

          <Field
            label="Disk size (GiB)"
            error={sizeError}
            hint={
              exceedsFree && storage?.freeBytes !== undefined
                ? `Larger than the ${formatBytes(storage.freeBytes)} free on ${storage.id}; only thin-provisioned storage will accept this.`
                : undefined
            }
          >
            {(id) => (
              <Input
                id={id}
                type="number"
                inputMode="numeric"
                min={1}
                max={MAX_DISK_GIB}
                step={1}
                value={form.sizeText}
                onChange={(e) => patch({ sizeText: e.target.value })}
                disabled={disabled}
                aria-invalid={Boolean(sizeError) || undefined}
              />
            )}
          </Field>

          {formatInfo !== undefined &&
            (offersFormatChoice ? (
              <Field label="Format">
                {(id) => (
                  <NativeSelect
                    id={id}
                    value={form.format}
                    onChange={(e) => patch({ format: e.target.value as DiskFormat | '' })}
                    disabled={disabled}
                  >
                    <option value="">Default ({formatInfo.default})</option>
                    {formatInfo.formats.map((f) => (
                      <option key={f} value={f}>
                        {f}
                      </option>
                    ))}
                  </NativeSelect>
                )}
              </Field>
            ) : (
              <p className="text-sm" data-testid="create-vm-fixed-format">
                <span className="font-medium">Format: </span>
                {formatInfo.formats[0]}{' '}
                <span className="text-xs text-muted-foreground">(the only format on this storage)</span>
              </p>
            ))}

          <Field label="Cache">
            {(id) => (
              <NativeSelect
                id={id}
                value={form.cache}
                onChange={(e) => patch({ cache: e.target.value as DiskCache | '' })}
                disabled={disabled}
              >
                <option value="">Default (no cache)</option>
                {CACHE_MODES.map((m) => (
                  <option key={m.value} value={m.value}>
                    {m.label}
                  </option>
                ))}
              </NativeSelect>
            )}
          </Field>

          <div className="flex flex-col gap-2">
            <CheckRow label="Discard (TRIM)" checked={form.discard} onChange={(discard) => patch({ discard })} disabled={disabled} />
            {supportsSsd && (
              <CheckRow label="SSD emulation" checked={form.ssd} onChange={(ssd) => patch({ ssd })} disabled={disabled} />
            )}
            {supportsIothread && (
              <CheckRow
                label="IO thread"
                checked={form.iothread}
                onChange={(iothread) => patch({ iothread })}
                disabled={disabled}
              />
            )}
          </div>
        </>
      )}
    </div>
  );
}
