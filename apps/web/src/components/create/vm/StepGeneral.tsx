import { Input } from '@/components/ui/input';
import { NativeSelect } from '@/components/hardware/NativeSelect';
import { CheckRow, Field, type StepProps } from '@/components/create/vm/fields';
import { MAX_NAME_LENGTH, typedError } from '@/components/create/vm/wizardState';

/** Step 1: node, VM ID, name, resource pool, tags, start-after-created. */
export function StepGeneral({ form, patch, errors, data, disabled }: StepProps) {
  return (
    <div className="flex flex-col gap-4">
      <Field label="Node" error={errors.node}>
        {(id) => (
          <NativeSelect
            id={id}
            value={form.node}
            onChange={(e) => patch({ node: e.target.value })}
            disabled={disabled || data.nodes.length === 0}
          >
            {form.node === '' && <option value="">Select a node</option>}
            {data.nodes.map((n) => (
              <option key={n.name} value={n.name} disabled={n.status !== 'online'}>
                {n.name}
                {n.status !== 'online' ? ` (${n.status})` : ''}
              </option>
            ))}
          </NativeSelect>
        )}
      </Field>

      <Field
        label="VM ID"
        hint="Prefilled with the next free ID; change it if you need a specific one."
        error={typedError(form.vmidText, errors.vmid)}
      >
        {(id) => (
          <Input
            id={id}
            inputMode="numeric"
            value={form.vmidText}
            onChange={(e) => patch({ vmidText: e.target.value, vmidTouched: true })}
            disabled={disabled}
            aria-invalid={Boolean(typedError(form.vmidText, errors.vmid)) || undefined}
          />
        )}
      </Field>

      <Field label="Name" error={typedError(form.name, errors.name)}>
        {(id) => (
          <Input
            id={id}
            value={form.name}
            onChange={(e) => patch({ name: e.target.value })}
            maxLength={MAX_NAME_LENGTH + 20}
            autoComplete="off"
            spellCheck={false}
            disabled={disabled}
            aria-invalid={Boolean(typedError(form.name, errors.name)) || undefined}
          />
        )}
      </Field>

      <Field label="Resource pool (optional)" error={typedError(form.pool, errors.pool)}>
        {(id) => (
          <Input
            id={id}
            value={form.pool}
            onChange={(e) => patch({ pool: e.target.value })}
            autoComplete="off"
            spellCheck={false}
            disabled={disabled}
            aria-invalid={Boolean(typedError(form.pool, errors.pool)) || undefined}
          />
        )}
      </Field>

      <Field
        label="Tags (optional)"
        hint="Separate tags with spaces or commas."
        error={typedError(form.tagsText, errors.tags)}
      >
        {(id) => (
          <Input
            id={id}
            value={form.tagsText}
            onChange={(e) => patch({ tagsText: e.target.value })}
            autoComplete="off"
            spellCheck={false}
            disabled={disabled}
            aria-invalid={Boolean(typedError(form.tagsText, errors.tags)) || undefined}
          />
        )}
      </Field>

      <CheckRow
        label="Start after created"
        checked={form.start}
        onChange={(start) => patch({ start })}
        disabled={disabled}
      />
    </div>
  );
}
