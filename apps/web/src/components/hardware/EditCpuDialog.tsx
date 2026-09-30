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
import { Input } from '@/components/ui/input';
import { NativeSelect } from '@/components/hardware/NativeSelect';
import { useCpuModels, useUpdateHardware, hardwareErrorMessage } from '@/api/hardwareHooks';
import { FALLBACK_CPU_MODELS, type CpuModel, type HardwarePatch } from '@/api/hardware';
import { cpuHasExtraOptions, parseCpuModel } from '@/lib/pve-config';
import type { GuestType } from '@/api/types';

export interface EditCpuDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  node: string;
  type: GuestType;
  vmid: number;
  /** The guest's current `sockets`/`cores`/`cpu` config values. */
  sockets: number | undefined;
  cores: number | undefined;
  cpu: string | undefined;
}

const MAX_QEMU_CORES = 1024;
const MAX_LXC_CORES = 8192;
const MAX_SOCKETS = 64;

/** `''` is the "no `cpu` key" choice -- PVE's own default model. */
const DEFAULT_MODEL = '';

function parseCount(text: string, max: number): number | undefined {
  if (!/^\d+$/.test(text.trim())) return undefined;
  const n = Number(text);
  return n >= 1 && n <= max ? n : undefined;
}

const VENDOR_GROUPS: Array<{ vendor: string; label: string }> = [
  { vendor: 'default', label: 'Generic' },
  { vendor: 'GenuineIntel', label: 'Intel' },
  { vendor: 'AuthenticAMD', label: 'AMD' },
];

/** Groups CPU models by vendor for the picker's `<optgroup>`s; custom models (`custom-*`) get
 * their own group and any unknown vendor string is shown under "Other". */
function groupModels(models: CpuModel[]): Array<{ label: string; models: CpuModel[] }> {
  const groups: Array<{ label: string; models: CpuModel[] }> = [];
  const known = new Set(VENDOR_GROUPS.map((g) => g.vendor));
  for (const { vendor, label } of VENDOR_GROUPS) {
    const inGroup = models.filter((m) => !m.custom && m.vendor === vendor);
    if (inGroup.length > 0) groups.push({ label, models: inGroup });
  }
  const custom = models.filter((m) => m.custom);
  if (custom.length > 0) groups.push({ label: 'Custom', models: custom });
  const other = models.filter((m) => !m.custom && !known.has(m.vendor));
  if (other.length > 0) groups.push({ label: 'Other', models: other });
  return groups;
}

/**
 * Edits a guest's processors. qemu: sockets, cores and the CPU type (a select grouped by vendor,
 * from the node's own `capabilities/qemu/cpu` list with a built-in fallback if that lookup
 * fails). lxc: cores only. Sockets and cores are always sent; the CPU type only when it was
 * changed -- the server replaces the whole `cpu` property string, so an untouched type keeps any
 * extra flags the guest has.
 *
 * Mount it fresh per open (the Hardware tab renders it conditionally): its fields are seeded from
 * the current config once, at mount.
 */
export function EditCpuDialog({ open, onOpenChange, node, type, vmid, sockets, cores, cpu }: EditCpuDialogProps) {
  const mutation = useUpdateHardware();
  const models = useCpuModels(node);
  const errorId = useId();

  const isQemu = type === 'qemu';
  const maxCores = isQemu ? MAX_QEMU_CORES : MAX_LXC_CORES;
  const initialModel = parseCpuModel(cpu) ?? DEFAULT_MODEL;

  const [socketsText, setSocketsText] = useState(String(sockets ?? 1));
  const [coresText, setCoresText] = useState(String(cores ?? 1));
  const [model, setModel] = useState(initialModel);

  const available = models.data && models.data.length > 0 ? models.data : FALLBACK_CPU_MODELS;
  const groups = useMemo(() => groupModels(available), [available]);
  const listed = available.some((m) => m.name === initialModel);

  const socketsValue = parseCount(socketsText, MAX_SOCKETS);
  const coresValue = parseCount(coresText, maxCores);
  const valid = coresValue !== undefined && (!isQemu || socketsValue !== undefined);
  const modelChanged = model !== initialModel;

  const serverError = mutation.isError ? hardwareErrorMessage(mutation.error, 'The CPU could not be updated.') : undefined;

  function submit() {
    if (!valid || mutation.isPending || coresValue === undefined) return;
    const patch: HardwarePatch = { cores: coresValue };
    if (isQemu && socketsValue !== undefined) {
      patch.sockets = socketsValue;
      if (modelChanged && model !== DEFAULT_MODEL) patch.cpu = model;
    }
    mutation.mutate({ node, type, vmid, patch }, { onSuccess: () => onOpenChange(false) });
  }

  function onKeyDown(event: KeyboardEvent<HTMLElement>) {
    if (event.key === 'Enter' && event.target instanceof HTMLInputElement) {
      event.preventDefault();
      submit();
    }
  }

  // "Back to the default model" has no representation in the route (it only ever sets a model),
  // so that choice is only offered while the guest already is on the default.
  const offerDefault = initialModel === DEFAULT_MODEL;

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
          <DialogTitle>{isQemu ? 'Edit processors' : 'Edit cores'}</DialogTitle>
          <DialogDescription>
            If the guest is running, PVE applies processor changes after its next restart.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-4">
          {isQemu && (
            <div className="flex flex-col gap-1.5">
              <label htmlFor={`${errorId}-sockets`} className="text-sm font-medium">
                Sockets
              </label>
              <Input
                id={`${errorId}-sockets`}
                type="number"
                inputMode="numeric"
                min={1}
                max={MAX_SOCKETS}
                value={socketsText}
                onChange={(e) => setSocketsText(e.target.value)}
                disabled={mutation.isPending}
                aria-invalid={socketsValue === undefined || undefined}
              />
            </div>
          )}

          <div className="flex flex-col gap-1.5">
            <label htmlFor={`${errorId}-cores`} className="text-sm font-medium">
              Cores
            </label>
            <Input
              id={`${errorId}-cores`}
              type="number"
              inputMode="numeric"
              min={1}
              max={maxCores}
              value={coresText}
              onChange={(e) => setCoresText(e.target.value)}
              disabled={mutation.isPending}
              aria-invalid={coresValue === undefined || undefined}
            />
            {isQemu && socketsValue !== undefined && coresValue !== undefined && (
              <p className="text-xs text-muted-foreground">
                {socketsValue * coresValue} vCPU{socketsValue * coresValue === 1 ? '' : 's'} in total (sockets × cores).
              </p>
            )}
          </div>

          {isQemu && (
            <div className="flex flex-col gap-1.5">
              <label htmlFor={`${errorId}-cpu`} className="text-sm font-medium">
                CPU type
              </label>
              <NativeSelect
                id={`${errorId}-cpu`}
                value={model}
                onChange={(e) => setModel(e.target.value)}
                disabled={mutation.isPending}
              >
                {offerDefault && <option value={DEFAULT_MODEL}>Default (kvm64)</option>}
                {!listed && initialModel !== DEFAULT_MODEL && <option value={initialModel}>{initialModel} (current)</option>}
                {groups.map((group) => (
                  <optgroup key={group.label} label={group.label}>
                    {group.models.map((m) => (
                      <option key={m.name} value={m.name}>
                        {m.name}
                      </option>
                    ))}
                  </optgroup>
                ))}
              </NativeSelect>
              <p className="text-xs text-muted-foreground">
                <span className="font-medium">host</span> passes the node&apos;s physical CPU through: fastest, but
                it limits live migration to identical hardware.
              </p>
              {cpuHasExtraOptions(cpu) && (
                <p className="text-xs text-muted-foreground">
                  This CPU has extra options ({cpu?.split(',').slice(1).join(', ')}). Choosing a different type
                  replaces them.
                </p>
              )}
            </div>
          )}

          {serverError && (
            <p id={errorId} role="alert" className="text-xs text-status-error">
              {serverError}
            </p>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" disabled={mutation.isPending} onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button disabled={!valid || mutation.isPending} onClick={submit}>
            {mutation.isPending && <Loader2 className="size-4 animate-spin" />}
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
