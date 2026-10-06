import { useMemo } from 'react';

import { Input } from '@/components/ui/input';
import { NativeSelect } from '@/components/hardware/NativeSelect';
import { Field, type StepProps } from '@/components/create/vm/fields';
import { parseIntIn, typedError } from '@/components/create/vm/wizardState';
import type { CpuModel } from '@/api/hardware';

const VENDOR_GROUPS: Array<{ vendor: string; label: string }> = [
  { vendor: 'default', label: 'Generic' },
  { vendor: 'GenuineIntel', label: 'Intel' },
  { vendor: 'AuthenticAMD', label: 'AMD' },
];

/** Groups CPU models by vendor for the picker's `<optgroup>`s (custom models and unknown vendors
 * get their own groups). Same grouping `EditCpuDialog` uses; its own copy is module-private. */
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

/** Step 5: sockets, cores and the CPU type. */
export function StepCpu({ form, patch, errors, data, disabled }: StepProps) {
  const groups = useMemo(() => groupModels(data.cpuModels), [data.cpuModels]);
  const listed = data.cpuModels.some((m) => m.name === form.cpuType);
  const sockets = parseIntIn(form.socketsText, 1, 4);
  const cores = parseIntIn(form.coresText, 1, 128);
  const socketsError = typedError(form.socketsText, errors.sockets);
  const coresError = typedError(form.coresText, errors.cores);

  return (
    <div className="flex flex-col gap-4">
      <Field label="Sockets" error={socketsError}>
        {(id) => (
          <Input
            id={id}
            type="number"
            inputMode="numeric"
            min={1}
            max={4}
            value={form.socketsText}
            onChange={(e) => patch({ socketsText: e.target.value })}
            disabled={disabled}
            aria-invalid={Boolean(socketsError) || undefined}
          />
        )}
      </Field>

      <Field
        label="Cores"
        error={coresError}
        hint={
          sockets !== undefined && cores !== undefined
            ? `${sockets * cores} vCPU${sockets * cores === 1 ? '' : 's'} in total (sockets × cores).`
            : undefined
        }
      >
        {(id) => (
          <Input
            id={id}
            type="number"
            inputMode="numeric"
            min={1}
            max={128}
            value={form.coresText}
            onChange={(e) => patch({ coresText: e.target.value })}
            disabled={disabled}
            aria-invalid={Boolean(coresError) || undefined}
          />
        )}
      </Field>

      <Field
        label="CPU type"
        hint={
          <>
            <span className="font-medium">host</span> passes the node&apos;s physical CPU through: fastest, but it
            limits live migration to identical hardware.
          </>
        }
      >
        {(id) => (
          <NativeSelect
            id={id}
            value={form.cpuType}
            onChange={(e) => patch({ cpuType: e.target.value })}
            disabled={disabled}
          >
            {!listed && <option value={form.cpuType}>{form.cpuType}</option>}
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
        )}
      </Field>
    </div>
  );
}

/** Step 6: memory and the optional minimum memory (ballooning). */
export function StepMemory({ form, patch, errors, disabled }: StepProps) {
  const memoryError = typedError(form.memoryText, errors.memory);
  const balloonError = typedError(form.balloonText, errors.balloon);
  return (
    <div className="flex flex-col gap-4">
      <Field label="Memory (MiB)" error={memoryError}>
        {(id) => (
          <Input
            id={id}
            type="number"
            inputMode="numeric"
            min={16}
            step={1}
            value={form.memoryText}
            onChange={(e) => patch({ memoryText: e.target.value })}
            disabled={disabled}
            aria-invalid={Boolean(memoryError) || undefined}
          />
        )}
      </Field>

      <Field
        label="Minimum memory (MiB, optional)"
        error={balloonError}
        hint="With ballooning, the guest may be shrunk down to this much memory. Leave empty for PVE's default; 0 disables ballooning."
      >
        {(id) => (
          <Input
            id={id}
            type="number"
            inputMode="numeric"
            min={0}
            step={1}
            value={form.balloonText}
            onChange={(e) => patch({ balloonText: e.target.value })}
            disabled={disabled}
            aria-invalid={Boolean(balloonError) || undefined}
          />
        )}
      </Field>
    </div>
  );
}
