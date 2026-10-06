import { useId, type ReactNode } from 'react';

import { Checkbox } from '@/components/ui/checkbox';
import { NativeSelect } from '@/components/hardware/NativeSelect';
import { formatBytes } from '@/lib/format';
import type { CreateNode, StorageMedia } from '@/api/create';
import type { BridgeInfo } from '@/api/network';
import type { CpuModel } from '@/api/hardware';
import type { DiskStorage, StorageFormatInfo } from '@/api/disks';
import type { FieldErrors, VmForm } from '@/components/create/vm/wizardState';

/** The lookups the steps render (all already resolved for the form's current node). */
export interface WizardData {
  nodes: CreateNode[];
  isoStorages: DiskStorage[];
  /** `undefined` while loading. */
  isos: StorageMedia[] | undefined;
  imageStorages: DiskStorage[];
  formats: Record<string, StorageFormatInfo> | undefined;
  bridges: BridgeInfo[] | undefined;
  cpuModels: CpuModel[];
}

export interface StepProps {
  form: VmForm;
  patch: (changes: Partial<VmForm>) => void;
  errors: FieldErrors;
  data: WizardData;
  /** True while the create request is in flight. */
  disabled: boolean;
}

/** A labelled form row: the control is passed a generated id through the render prop so the label
 * is bound to it, with an optional hint and error line below. */
export function Field({
  label,
  hint,
  error,
  children,
}: {
  label: string;
  hint?: ReactNode;
  error?: string | undefined;
  children: (id: string) => ReactNode;
}) {
  const id = useId();
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={id} className="text-sm font-medium">
        {label}
      </label>
      {children(id)}
      {error ? (
        <p role="alert" className="text-xs text-status-error">
          {error}
        </p>
      ) : hint ? (
        <p className="text-xs text-muted-foreground">{hint}</p>
      ) : null}
    </div>
  );
}

export function CheckRow({
  label,
  checked,
  onChange,
  disabled,
  hint,
}: {
  label: string;
  checked: boolean;
  onChange: (next: boolean) => void;
  disabled?: boolean;
  hint?: ReactNode;
}) {
  const id = useId();
  return (
    <div className="flex flex-col gap-0.5">
      <div className="flex items-center gap-2">
        <Checkbox id={id} checked={checked} onCheckedChange={(c) => onChange(c === true)} disabled={disabled} />
        <label htmlFor={id} className="text-sm">
          {label}
        </label>
      </div>
      {hint && <p className="pl-6 text-xs text-muted-foreground">{hint}</p>}
    </div>
  );
}

/** A storage picker: each option shows the free space when the cluster resources carry it. */
export function StorageSelect({
  id,
  value,
  onChange,
  storages,
  disabled,
  ariaInvalid,
}: {
  id: string;
  value: string;
  onChange: (next: string) => void;
  storages: DiskStorage[];
  disabled?: boolean;
  ariaInvalid?: boolean;
}) {
  return (
    <NativeSelect
      id={id}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      disabled={disabled || storages.length === 0}
      aria-invalid={ariaInvalid || undefined}
    >
      {value === '' && <option value="">Select a storage</option>}
      {storages.map((s) => (
        <option key={s.id} value={s.id}>
          {s.id}
          {s.freeBytes !== undefined ? ` (${formatBytes(s.freeBytes)} free)` : ''}
        </option>
      ))}
    </NativeSelect>
  );
}
