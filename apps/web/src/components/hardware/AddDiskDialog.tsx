import { useId, useMemo, useState, type KeyboardEvent } from 'react';
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
import { Input } from '@/components/ui/input';
import { NativeSelect } from '@/components/hardware/NativeSelect';
import { useClusterResources } from '@/api/hooks';
import { hardwareErrorMessage } from '@/api/hardwareHooks';
import { useAddDisk, useStorageFormats } from '@/api/diskHooks';
import {
  BUS_SLOT_COUNTS,
  diskCapableStorages,
  inferStorageFormats,
  type AddDiskBody,
  type AddMountPointBody,
  type AddQemuDiskBody,
  type DiskBus,
  type DiskCache,
  type DiskFormat,
} from '@/api/disks';
import { formatBytes } from '@/lib/format';
import type { GuestType } from '@/api/types';

export interface AddDiskDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  node: string;
  type: GuestType;
  vmid: number;
  /** The guest's current config keys, to grey out a bus that has no free slot left. */
  configKeys: string[];
}

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

const MAX_SIZE_GIB = 65536;
const MOUNT_POINT_RE = /^\/[A-Za-z0-9._/-]{0,200}$/;

/** A whole number of GiB in range, or `undefined`. */
function parseSizeGiB(text: string): number | undefined {
  const trimmed = text.trim();
  if (!/^\d+$/.test(trimmed)) return undefined;
  const n = Number(trimmed);
  return n >= 1 && n <= MAX_SIZE_GIB ? n : undefined;
}

function validMountPoint(path: string): boolean {
  return MOUNT_POINT_RE.test(path) && !path.includes('..');
}

function busIsFull(configKeys: string[], bus: DiskBus): boolean {
  const re = new RegExp(`^${bus}\\d+$`);
  return configKeys.filter((k) => re.test(k)).length >= BUS_SLOT_COUNTS[bus];
}

function CheckRow({
  label,
  checked,
  onChange,
  disabled,
}: {
  label: string;
  checked: boolean;
  onChange: (next: boolean) => void;
  disabled: boolean;
}) {
  const id = useId();
  return (
    <div className="flex items-center gap-2">
      <Checkbox id={id} checked={checked} onCheckedChange={(c) => onChange(c === true)} disabled={disabled} />
      <label htmlFor={id} className="text-sm">
        {label}
      </label>
    </div>
  );
}

/**
 * Adds a new disk (qemu) or mount point (lxc). The storage list is this node's image-capable
 * storages (`rootdir` for a container) with their free space; the format picker only offers what
 * the chosen storage supports (a raw-only storage shows a fixed "raw"). Options the user leaves at
 * their defaults are not sent, so PVE applies its own defaults; the server picks the slot.
 *
 * Mount it fresh per open (the Hardware tab renders it conditionally).
 */
export function AddDiskDialog({ open, onOpenChange, node, type, vmid, configKeys }: AddDiskDialogProps) {
  const mutation = useAddDisk();
  const resources = useClusterResources();
  const formats = useStorageFormats(node);
  const ids = { bus: useId(), storage: useId(), size: useId(), format: useId(), cache: useId(), mount: useId() };

  const isQemu = type === 'qemu';
  const storages = useMemo(() => diskCapableStorages(resources.data, node, type), [resources.data, node, type]);

  const [bus, setBus] = useState<DiskBus>('scsi');
  const [storageChoice, setStorageChoice] = useState('');
  const [sizeText, setSizeText] = useState(isQemu ? '32' : '8');
  const [formatChoice, setFormatChoice] = useState<DiskFormat | ''>('');
  const [discard, setDiscard] = useState(false);
  const [ssd, setSsd] = useState(false);
  const [iothread, setIothread] = useState(false);
  const [cache, setCache] = useState<DiskCache | ''>('');
  const [backup, setBackup] = useState(true);
  const [mountPoint, setMountPoint] = useState('/data');
  const [readOnly, setReadOnly] = useState(false);
  const [acl, setAcl] = useState(false);

  const storage = storages.find((s) => s.id === storageChoice) ?? storages[0];
  const formatInfo = storage ? (formats.data?.[storage.id] ?? inferStorageFormats(storage.plugintype)) : undefined;
  const offersFormatChoice = isQemu && formatInfo !== undefined && formatInfo.formats.length > 1;
  // A choice made for another storage that this one doesn't support is ignored.
  const format: DiskFormat | '' =
    offersFormatChoice && formatChoice !== '' && formatInfo.formats.includes(formatChoice) ? formatChoice : '';

  const sizeGiB = parseSizeGiB(sizeText);
  const showSizeInvalid = sizeText.trim() !== '' && sizeGiB === undefined;
  const mountValid = validMountPoint(mountPoint);
  const showMountInvalid = !isQemu && !mountValid;
  const busFull = isQemu && busIsFull(configKeys, bus);

  const supportsSsd = bus !== 'virtio';
  const supportsIothread = bus === 'scsi' || bus === 'virtio';

  const exceedsFree =
    storage?.freeBytes !== undefined && sizeGiB !== undefined && sizeGiB * 1024 ** 3 > storage.freeBytes;

  const serverError = mutation.isError ? hardwareErrorMessage(mutation.error, 'The disk could not be added.') : undefined;
  const canSubmit =
    storage !== undefined && sizeGiB !== undefined && (isQemu ? !busFull : mountValid) && !mutation.isPending;

  function buildBody(): AddDiskBody | undefined {
    if (!storage || sizeGiB === undefined) return undefined;
    if (isQemu) {
      const body: AddQemuDiskBody = { bus, storage: storage.id, sizeGiB, backup };
      if (format !== '') body.format = format;
      if (discard) body.discard = true;
      if (ssd && supportsSsd) body.ssd = true;
      if (iothread && supportsIothread) body.iothread = true;
      if (cache !== '') body.cache = cache;
      return body;
    }
    const body: AddMountPointBody = { storage: storage.id, sizeGiB, mountPoint, backup };
    if (readOnly) body.readOnly = true;
    if (acl) body.acl = true;
    return body;
  }

  function submit() {
    if (!canSubmit) return;
    const body = buildBody();
    if (!body) return;
    mutation.mutate({ node, type, vmid, body }, { onSuccess: () => onOpenChange(false) });
  }

  function onKeyDown(event: KeyboardEvent<HTMLElement>) {
    if (event.key === 'Enter' && event.target instanceof HTMLInputElement && event.target.type !== 'checkbox') {
      event.preventDefault();
      submit();
    }
  }

  const title = isQemu ? 'Add disk' : 'Add mount point';
  const pending = mutation.isPending;

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next && pending) return;
        onOpenChange(next);
      }}
    >
      <DialogContent onKeyDown={onKeyDown}>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>
            {isQemu
              ? 'Creates a new empty disk on the chosen storage. Format it from inside the guest.'
              : 'Creates a new volume and mounts it inside the container at the given path.'}
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-4">
          {isQemu && (
            <div className="flex flex-col gap-1.5">
              <label htmlFor={ids.bus} className="text-sm font-medium">
                Bus
              </label>
              <NativeSelect
                id={ids.bus}
                value={bus}
                onChange={(e) => setBus(e.target.value as DiskBus)}
                disabled={pending}
              >
                {BUSES.map((b) => (
                  <option key={b} value={b} disabled={busIsFull(configKeys, b)}>
                    {BUS_LABELS[b]}
                    {busIsFull(configKeys, b) ? ' (full)' : ''}
                  </option>
                ))}
              </NativeSelect>
            </div>
          )}

          <div className="flex flex-col gap-1.5">
            <label htmlFor={ids.storage} className="text-sm font-medium">
              Storage
            </label>
            <NativeSelect
              id={ids.storage}
              value={storage?.id ?? ''}
              onChange={(e) => setStorageChoice(e.target.value)}
              disabled={pending || storages.length === 0}
            >
              {storages.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.id}
                  {s.freeBytes !== undefined ? ` (${formatBytes(s.freeBytes)} free)` : ''}
                </option>
              ))}
            </NativeSelect>
            {storages.length === 0 && (
              <p className="text-xs text-muted-foreground">
                No storage on this node can hold {isQemu ? 'disk images' : 'container volumes'}.
              </p>
            )}
          </div>

          <div className="flex flex-col gap-1.5">
            <label htmlFor={ids.size} className="text-sm font-medium">
              Size (GiB)
            </label>
            <Input
              id={ids.size}
              type="number"
              inputMode="numeric"
              min={1}
              max={MAX_SIZE_GIB}
              step={1}
              value={sizeText}
              onChange={(e) => setSizeText(e.target.value)}
              disabled={pending}
              aria-invalid={showSizeInvalid || undefined}
            />
            {showSizeInvalid ? (
              <p className="text-xs text-status-error">Enter a whole number of GiB between 1 and {MAX_SIZE_GIB}.</p>
            ) : exceedsFree && storage?.freeBytes !== undefined ? (
              <p className="text-xs text-status-paused">
                Larger than the {formatBytes(storage.freeBytes)} free on {storage.id}; only thin-provisioned
                storage will accept this.
              </p>
            ) : null}
          </div>

          {isQemu && formatInfo !== undefined && (
            <div className="flex flex-col gap-1.5">
              {offersFormatChoice ? (
                <>
                  <label htmlFor={ids.format} className="text-sm font-medium">
                    Format
                  </label>
                  <NativeSelect
                    id={ids.format}
                    value={format}
                    onChange={(e) => setFormatChoice(e.target.value as DiskFormat | '')}
                    disabled={pending}
                  >
                    <option value="">Default ({formatInfo.default})</option>
                    {formatInfo.formats.map((f) => (
                      <option key={f} value={f}>
                        {f}
                      </option>
                    ))}
                  </NativeSelect>
                </>
              ) : (
                <p className="text-sm" data-testid="add-disk-fixed-format">
                  <span className="font-medium">Format: </span>
                  {formatInfo.formats[0]} <span className="text-xs text-muted-foreground">(the only format on this storage)</span>
                </p>
              )}
            </div>
          )}

          {isQemu ? (
            <>
              <div className="flex flex-col gap-1.5">
                <label htmlFor={ids.cache} className="text-sm font-medium">
                  Cache
                </label>
                <NativeSelect
                  id={ids.cache}
                  value={cache}
                  onChange={(e) => setCache(e.target.value as DiskCache | '')}
                  disabled={pending}
                >
                  <option value="">Default (no cache)</option>
                  {CACHE_MODES.map((m) => (
                    <option key={m.value} value={m.value}>
                      {m.label}
                    </option>
                  ))}
                </NativeSelect>
              </div>
              <div className="flex flex-col gap-2">
                <CheckRow label="Discard (TRIM)" checked={discard} onChange={setDiscard} disabled={pending} />
                {supportsSsd && (
                  <CheckRow label="SSD emulation" checked={ssd} onChange={setSsd} disabled={pending} />
                )}
                {supportsIothread && (
                  <CheckRow label="IO thread" checked={iothread} onChange={setIothread} disabled={pending} />
                )}
                <CheckRow label="Include in backup" checked={backup} onChange={setBackup} disabled={pending} />
              </div>
            </>
          ) : (
            <>
              <div className="flex flex-col gap-1.5">
                <label htmlFor={ids.mount} className="text-sm font-medium">
                  Mount point
                </label>
                <Input
                  id={ids.mount}
                  value={mountPoint}
                  onChange={(e) => setMountPoint(e.target.value)}
                  placeholder="/data"
                  autoComplete="off"
                  disabled={pending}
                  aria-invalid={showMountInvalid || undefined}
                />
                {showMountInvalid && (
                  <p className="text-xs text-status-error">
                    Enter an absolute path (letters, digits, . _ - and /), without &quot;..&quot;.
                  </p>
                )}
              </div>
              <div className="flex flex-col gap-2">
                <CheckRow label="Include in backup" checked={backup} onChange={setBackup} disabled={pending} />
                <CheckRow label="Read-only" checked={readOnly} onChange={setReadOnly} disabled={pending} />
                <CheckRow label="ACL" checked={acl} onChange={setAcl} disabled={pending} />
              </div>
            </>
          )}

          {busFull && (
            <p role="alert" className="text-xs text-status-error">
              The {BUS_LABELS[bus]} bus has no free slot; choose another bus.
            </p>
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
            Add
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
