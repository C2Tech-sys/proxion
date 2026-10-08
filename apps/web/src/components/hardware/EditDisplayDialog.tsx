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
import { NativeSelect } from '@/components/hardware/NativeSelect';
import { hardwareErrorMessage } from '@/api/hardwareHooks';
import { useUpdateFirmware } from '@/api/firmwareHooks';
import { composeVga, parseVga, type VgaSpec } from '@/api/firmware';

export interface EditDisplayDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  node: string;
  vmid: number;
  /** The guest's current `vga` value (`undefined` = PVE's default, Standard VGA). */
  vga: string | number | undefined;
}

/** `''` is the "no `vga` key" choice -- PVE's own default. */
const DEFAULT_TYPE = '';

const DISPLAY_TYPES: Array<{ value: string; label: string }> = [
  { value: 'std', label: 'Standard VGA (std)' },
  { value: 'cirrus', label: 'Cirrus Logic GD5446 (cirrus)' },
  { value: 'vmware', label: 'VMware compatible (vmware)' },
  { value: 'qxl', label: 'SPICE (qxl)' },
  { value: 'qxl2', label: 'SPICE, 2 monitors (qxl2)' },
  { value: 'qxl3', label: 'SPICE, 3 monitors (qxl3)' },
  { value: 'qxl4', label: 'SPICE, 4 monitors (qxl4)' },
  { value: 'virtio', label: 'VirtIO-GPU (virtio)' },
  { value: 'virtio-gl', label: 'VirGL GPU (virtio-gl)' },
  { value: 'serial0', label: 'Serial terminal 0 (serial0)' },
  { value: 'serial1', label: 'Serial terminal 1 (serial1)' },
  { value: 'serial2', label: 'Serial terminal 2 (serial2)' },
  { value: 'serial3', label: 'Serial terminal 3 (serial3)' },
  { value: 'none', label: 'None' },
];

const MIN_MEMORY_MIB = 4;
const MAX_MEMORY_MIB = 512;

/** Whether a display type has video memory to size (a serial terminal or no display has none). */
function hasVideoMemory(type: string): boolean {
  return !/^serial\d$/.test(type) && type !== 'none';
}

/**
 * Edits the guest's display adapter and, for the graphical ones, its video memory in MiB. Picking
 * "Default" removes the `vga` key so PVE falls back to Standard VGA. Mount it fresh per open.
 */
export function EditDisplayDialog({ open, onOpenChange, node, vmid, vga }: EditDisplayDialogProps) {
  const mutation = useUpdateFirmware();
  const ids = { type: useId(), memory: useId() };
  const currentRaw = vga === undefined || vga === '' ? undefined : String(vga);
  const parsed = parseVga(currentRaw);

  const [type, setType] = useState(currentRaw === undefined ? DEFAULT_TYPE : parsed.type);
  const [memoryText, setMemoryText] = useState(parsed.memory !== undefined ? String(parsed.memory) : '');

  const pending = mutation.isPending;
  const showMemory = type !== DEFAULT_TYPE && hasVideoMemory(type);
  const memoryBlank = memoryText.trim() === '';
  const memoryValue = /^\d+$/.test(memoryText.trim()) ? Number(memoryText) : undefined;
  const memoryValid = !showMemory || memoryBlank || (memoryValue !== undefined && memoryValue >= MIN_MEMORY_MIB && memoryValue <= MAX_MEMORY_MIB);

  // `null` resets to PVE's default; otherwise the spec to send.
  const next: VgaSpec | null =
    type === DEFAULT_TYPE
      ? null
      : { type, ...(showMemory && !memoryBlank && memoryValue !== undefined ? { memory: memoryValue } : {}) };
  const nextRaw = next === null ? undefined : composeVga(next);
  const changed = nextRaw !== currentRaw;
  const canSubmit = changed && memoryValid && !pending;
  const serverError = mutation.isError ? hardwareErrorMessage(mutation.error, 'The display could not be updated.') : undefined;

  function submit() {
    if (!canSubmit) return;
    mutation.mutate({ node, vmid, body: { vga: next } }, { onSuccess: () => onOpenChange(false) });
  }

  function onKeyDown(event: KeyboardEvent<HTMLElement>) {
    if (event.key === 'Enter' && event.target instanceof HTMLInputElement) {
      event.preventDefault();
      submit();
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen && pending) return;
        onOpenChange(nextOpen);
      }}
    >
      <DialogContent onKeyDown={onKeyDown}>
        <DialogHeader>
          <DialogTitle>Edit display</DialogTitle>
          <DialogDescription>
            If the guest is running, PVE applies a display change after its next restart.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-4">
          <div className="flex flex-col gap-1.5">
            <label htmlFor={ids.type} className="text-sm font-medium">
              Display
            </label>
            <NativeSelect id={ids.type} value={type} onChange={(e) => setType(e.target.value)} disabled={pending}>
              <option value={DEFAULT_TYPE}>Default (Standard VGA)</option>
              {DISPLAY_TYPES.map((t) => (
                <option key={t.value} value={t.value}>
                  {t.label}
                </option>
              ))}
            </NativeSelect>
          </div>

          {showMemory && (
            <div className="flex flex-col gap-1.5">
              <label htmlFor={ids.memory} className="text-sm font-medium">
                Video memory (MiB)
              </label>
              <Input
                id={ids.memory}
                type="number"
                inputMode="numeric"
                min={MIN_MEMORY_MIB}
                max={MAX_MEMORY_MIB}
                value={memoryText}
                onChange={(e) => setMemoryText(e.target.value)}
                disabled={pending}
                aria-invalid={!memoryValid || undefined}
              />
              <p className={memoryValid ? 'text-xs text-muted-foreground' : 'text-xs text-status-error'}>
                {memoryValid
                  ? 'Leave blank to keep PVE’s default.'
                  : `Enter a whole number of MiB between ${MIN_MEMORY_MIB} and ${MAX_MEMORY_MIB}.`}
              </p>
            </div>
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
