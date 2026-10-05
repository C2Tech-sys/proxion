import { useState, type ReactNode } from 'react';
import { TriangleAlert } from 'lucide-react';

import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { NativeSelect } from '@/components/hardware/NativeSelect';

/** Form pieces shared by the USB and PCI device dialogs. */

export function Field({
  label,
  htmlFor,
  error,
  hint,
  children,
}: {
  label: string;
  htmlFor: string;
  error?: string | undefined;
  hint?: string | undefined;
  children: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={htmlFor} className="text-sm font-medium">
        {label}
      </label>
      {children}
      {error ? (
        <p className="text-xs text-status-error">{error}</p>
      ) : hint ? (
        <p className="text-xs text-muted-foreground">{hint}</p>
      ) : null}
    </div>
  );
}

export function CheckField({
  id,
  label,
  hint,
  checked,
  onChange,
  disabled,
}: {
  id: string;
  label: string;
  hint?: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled: boolean;
}) {
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

/** A native radio with its label; the group is named by the caller's `name`. */
export function RadioOption({
  name,
  value,
  checked,
  label,
  onSelect,
  disabled,
}: {
  name: string;
  value: string;
  checked: boolean;
  label: string;
  onSelect: (value: string) => void;
  disabled: boolean;
}) {
  return (
    <label className="flex items-center gap-2 text-sm">
      <input
        type="radio"
        name={name}
        value={value}
        checked={checked}
        onChange={() => onSelect(value)}
        disabled={disabled}
        className="size-4 accent-primary"
      />
      {label}
    </label>
  );
}

/** The raw-passthrough caveat both dialogs show next to the "raw device" choice. */
export function RawDeviceWarning() {
  return (
    <p className="flex items-start gap-1.5 rounded-md border border-border bg-muted/40 p-2 text-xs text-muted-foreground">
      <TriangleAlert className="mt-0.5 size-3.5 shrink-0" />
      <span>Raw USB/PCI passthrough needs root@pam in Proxmox; other users must pick a mapped device.</span>
    </p>
  );
}

export interface PickItem {
  value: string;
  label: string;
  /** Items sharing a `group` render under one `<optgroup>`. */
  group?: string;
}

const MANUAL = '__manual__';

/**
 * A device identifier chosen from a detected list OR typed by hand. With a list it is a native
 * select whose last option switches to a text field; with no list (still loading, the lookup was
 * refused with a 403, or nothing was found) it is the text field alone, with a note saying why.
 * A value that is not in the list (an edit of a device that is gone) also shows the text field.
 */
export function PickOrType({
  id,
  label,
  items,
  loading,
  forbidden,
  forbiddenNote,
  value,
  onChange,
  placeholder,
  error,
  disabled,
  pickPlaceholder,
}: {
  id: string;
  label: string;
  items: PickItem[];
  loading: boolean;
  forbidden: boolean;
  forbiddenNote: string;
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
  error?: string | undefined;
  disabled: boolean;
  pickPlaceholder: string;
}) {
  const [manual, setManual] = useState(false);
  const inList = items.some((i) => i.value === value);
  const showInput = !loading && (items.length === 0 || manual || (value !== '' && !inList));
  const groups = [...new Set(items.map((i) => i.group).filter((g): g is string => g !== undefined))];
  const ungrouped = items.filter((i) => i.group === undefined);

  const hint = forbidden
    ? forbiddenNote
    : !loading && items.length === 0
      ? 'Nothing was detected; enter it manually.'
      : undefined;

  return (
    <Field label={label} htmlFor={id} error={error} hint={hint}>
      {(loading || items.length > 0) && (
        <NativeSelect
          id={showInput ? `${id}-pick` : id}
          aria-label={showInput ? `${label} (detected)` : undefined}
          value={showInput ? MANUAL : value}
          disabled={disabled || loading}
          onChange={(e) => {
            if (e.target.value === MANUAL) {
              setManual(true);
            } else {
              setManual(false);
              onChange(e.target.value);
            }
          }}
        >
          {loading ? (
            <option value="">Loading...</option>
          ) : (
            <>
              <option value="" disabled>
                {pickPlaceholder}
              </option>
              {ungrouped.map((i) => (
                <option key={i.value} value={i.value}>
                  {i.label}
                </option>
              ))}
              {groups.map((g) => (
                <optgroup key={g} label={g}>
                  {items
                    .filter((i) => i.group === g)
                    .map((i) => (
                      <option key={i.value} value={i.value}>
                        {i.label}
                      </option>
                    ))}
                </optgroup>
              ))}
              <option value={MANUAL}>Enter manually...</option>
            </>
          )}
        </NativeSelect>
      )}
      {showInput && (
        <Input
          id={id}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          disabled={disabled}
          aria-invalid={error !== undefined || undefined}
          placeholder={placeholder}
          autoComplete="off"
        />
      )}
    </Field>
  );
}
