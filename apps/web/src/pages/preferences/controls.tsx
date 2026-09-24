import { cn } from '@/lib/utils';

export interface SegmentedControlProps<T extends string> {
  value: T;
  options: readonly T[];
  labels: Record<T, string>;
  onChange: (value: T) => void;
  ariaLabel: string;
  disabled?: boolean;
}

/** A small button-row single-choice control (theme, density, default range, refresh interval).
 *  Same visual language as `components/charts/RangeChips.tsx` (this page's own copy: that one's
 *  aria-label is hardcoded to "Time range" and lives in the charts module, not preferences). */
export function SegmentedControl<T extends string>({
  value,
  options,
  labels,
  onChange,
  ariaLabel,
  disabled,
}: SegmentedControlProps<T>) {
  return (
    <div
      role="group"
      aria-label={ariaLabel}
      className="inline-flex items-center gap-0.5 rounded-md border border-border bg-background p-0.5"
    >
      {options.map((option) => {
        const active = option === value;
        return (
          <button
            key={option}
            type="button"
            disabled={disabled}
            aria-pressed={active}
            onClick={() => onChange(option)}
            className={cn(
              'rounded-sm px-2.5 py-1 text-xs font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50',
              active
                ? 'bg-accent/15 text-accent'
                : 'text-muted-foreground hover:text-foreground disabled:hover:text-muted-foreground',
            )}
          >
            {labels[option]}
          </button>
        );
      })}
    </div>
  );
}

export interface SwitchToggleProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
  ariaLabel: string;
  disabled?: boolean;
}

/** A minimal on/off switch (no radix-react-switch dependency in this workspace yet) -- a plain
 *  `role="switch"` button, styled to match the segmented control above. */
export function SwitchToggle({ checked, onChange, ariaLabel, disabled }: SwitchToggleProps) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={ariaLabel}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={cn(
        'relative inline-flex h-5 w-9 shrink-0 items-center rounded-full border transition-colors disabled:cursor-not-allowed disabled:opacity-50',
        checked ? 'border-accent bg-accent' : 'border-border bg-muted',
      )}
    >
      <span
        className={cn(
          'inline-block size-3.5 translate-x-0.5 rounded-full bg-background shadow transition-transform',
          checked && 'translate-x-[18px]',
        )}
      />
    </button>
  );
}
