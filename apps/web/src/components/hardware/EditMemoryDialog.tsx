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
import { useUpdateHardware, hardwareErrorMessage } from '@/api/hardwareHooks';
import type { HardwarePatch } from '@/api/hardware';
import type { GuestType } from '@/api/types';

export interface EditMemoryDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  node: string;
  type: GuestType;
  vmid: number;
  /** Current `memory` in MiB. */
  memory: number | undefined;
  /** qemu: current `balloon` minimum in MiB (`0` = ballooning disabled, `undefined` = not set). */
  balloon: number | undefined;
  /** lxc: current `swap` in MiB. */
  swap: number | undefined;
}

const MIN_MEMORY_MIB = 16;
const MAX_MEMORY_MIB = 4194304;

function parseMiB(text: string, min: number, max: number): number | undefined {
  if (!/^\d+$/.test(text.trim())) return undefined;
  const n = Number(text);
  return n >= min && n <= max ? n : undefined;
}

/** MiB -> a GiB figure for the helper field, trimmed to at most two decimals. */
function toGiBText(mib: number): string {
  return String(Math.round((mib / 1024) * 100) / 100);
}

/**
 * Edits a guest's memory. The amount is entered in MiB -- PVE's own unit -- with a linked GiB
 * field as a helper (editing either updates the other; GiB is rounded to whole MiB). qemu also
 * has the balloon minimum (`0` = ballooning disabled; blank = leave PVE's default, which follows
 * the memory size) and must not exceed the new memory; lxc has swap. `memory` is always sent;
 * balloon / swap whenever the field has a value.
 *
 * Mount it fresh per open (the Hardware tab renders it conditionally).
 */
export function EditMemoryDialog({
  open,
  onOpenChange,
  node,
  type,
  vmid,
  memory,
  balloon,
  swap,
}: EditMemoryDialogProps) {
  const mutation = useUpdateHardware();
  const id = useId();
  const isQemu = type === 'qemu';

  const [mibText, setMibText] = useState(memory !== undefined ? String(memory) : '');
  const [gibText, setGibText] = useState(memory !== undefined ? toGiBText(memory) : '');
  const [balloonText, setBalloonText] = useState(balloon !== undefined ? String(balloon) : '');
  const [swapText, setSwapText] = useState(swap !== undefined ? String(swap) : '');

  const memoryValue = parseMiB(mibText, MIN_MEMORY_MIB, MAX_MEMORY_MIB);
  const balloonBlank = balloonText.trim() === '';
  const balloonValue = balloonBlank ? undefined : parseMiB(balloonText, 0, MAX_MEMORY_MIB);
  const balloonTooBig = balloonValue !== undefined && memoryValue !== undefined && balloonValue > memoryValue;
  const balloonInvalid = isQemu && !balloonBlank && (balloonValue === undefined || balloonTooBig);
  const swapBlank = swapText.trim() === '';
  const swapValue = swapBlank ? undefined : parseMiB(swapText, 0, MAX_MEMORY_MIB);
  const swapInvalid = !isQemu && !swapBlank && swapValue === undefined;
  const valid = memoryValue !== undefined && !balloonInvalid && !swapInvalid;

  const serverError = mutation.isError
    ? hardwareErrorMessage(mutation.error, 'The memory could not be updated.')
    : undefined;

  function onMibChange(text: string) {
    setMibText(text);
    const parsed = parseMiB(text, 0, Number.MAX_SAFE_INTEGER);
    if (parsed !== undefined) setGibText(toGiBText(parsed));
  }

  function onGibChange(text: string) {
    setGibText(text);
    const gib = Number(text);
    if (text.trim() !== '' && Number.isFinite(gib) && gib >= 0) setMibText(String(Math.round(gib * 1024)));
  }

  // Only what changed is sent, so an untouched memory never shows up as a pending change.
  const patch: HardwarePatch = {};
  if (memoryValue !== undefined && memoryValue !== memory) patch.memory = memoryValue;
  if (isQemu && balloonValue !== undefined && balloonValue !== balloon) patch.balloon = balloonValue;
  if (!isQemu && swapValue !== undefined && swapValue !== swap) patch.swap = swapValue;
  const changed = Object.keys(patch).length > 0;

  function submit() {
    if (!valid || !changed || mutation.isPending) return;
    mutation.mutate({ node, type, vmid, patch }, { onSuccess: () => onOpenChange(false) });
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
      onOpenChange={(next) => {
        if (!next && mutation.isPending) return;
        onOpenChange(next);
      }}
    >
      <DialogContent onKeyDown={onKeyDown}>
        <DialogHeader>
          <DialogTitle>Edit memory</DialogTitle>
          <DialogDescription>
            If the guest is running, PVE applies memory changes after its next restart.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-4">
          <div className="grid grid-cols-2 gap-3">
            <div className="flex flex-col gap-1.5">
              <label htmlFor={`${id}-mib`} className="text-sm font-medium">
                Memory (MiB)
              </label>
              <Input
                id={`${id}-mib`}
                type="number"
                inputMode="numeric"
                min={MIN_MEMORY_MIB}
                max={MAX_MEMORY_MIB}
                value={mibText}
                onChange={(e) => onMibChange(e.target.value)}
                disabled={mutation.isPending}
                aria-invalid={memoryValue === undefined || undefined}
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <label htmlFor={`${id}-gib`} className="text-sm font-medium">
                Memory (GiB)
              </label>
              <Input
                id={`${id}-gib`}
                type="number"
                inputMode="decimal"
                min={0}
                step="any"
                value={gibText}
                onChange={(e) => onGibChange(e.target.value)}
                disabled={mutation.isPending}
              />
            </div>
          </div>

          {isQemu ? (
            <div className="flex flex-col gap-1.5">
              <label htmlFor={`${id}-balloon`} className="text-sm font-medium">
                Minimum memory / balloon (MiB)
              </label>
              <Input
                id={`${id}-balloon`}
                type="number"
                inputMode="numeric"
                min={0}
                value={balloonText}
                onChange={(e) => setBalloonText(e.target.value)}
                disabled={mutation.isPending}
                aria-invalid={balloonInvalid || undefined}
              />
              <p className={balloonInvalid ? 'text-xs text-status-error' : 'text-xs text-muted-foreground'}>
                {balloonInvalid
                  ? 'Must be a whole number of MiB, no more than the memory above.'
                  : '0 = ballooning disabled. Leave blank to keep PVE’s default.'}
              </p>
            </div>
          ) : (
            <div className="flex flex-col gap-1.5">
              <label htmlFor={`${id}-swap`} className="text-sm font-medium">
                Swap (MiB)
              </label>
              <Input
                id={`${id}-swap`}
                type="number"
                inputMode="numeric"
                min={0}
                value={swapText}
                onChange={(e) => setSwapText(e.target.value)}
                disabled={mutation.isPending}
                aria-invalid={swapInvalid || undefined}
              />
            </div>
          )}

          {serverError && (
            <p role="alert" className="text-xs text-status-error">
              {serverError}
            </p>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" disabled={mutation.isPending} onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button disabled={!valid || !changed || mutation.isPending} onClick={submit}>
            {mutation.isPending && <Loader2 className="size-4 animate-spin" />}
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
