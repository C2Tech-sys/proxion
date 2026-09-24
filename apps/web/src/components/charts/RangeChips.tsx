import { cn } from '@/lib/utils';

export interface RangeChipsProps<T extends string> {
  value: T;
  options: readonly T[];
  labels: Record<T, string>;
  onChange: (value: T) => void;
}

/** The Hour / Day / Week / Month / Year(/Decade) time-range chip row for a Monitor tab. */
export function RangeChips<T extends string>({ value, options, labels, onChange }: RangeChipsProps<T>) {
  return (
    <div role="group" aria-label="Time range" className="flex items-center gap-1">
      {options.map((option) => {
        const active = option === value;
        return (
          <button
            key={option}
            type="button"
            aria-pressed={active}
            onClick={() => onChange(option)}
            className={cn(
              'rounded-full border px-2.5 py-1 text-xs font-medium transition-colors',
              active
                ? 'border-accent bg-accent/15 text-accent'
                : 'border-border text-muted-foreground hover:border-foreground/30 hover:text-foreground',
            )}
          >
            {labels[option]}
          </button>
        );
      })}
    </div>
  );
}
