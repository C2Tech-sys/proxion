import { cn } from '@/lib/utils';

export interface FirewallSwitchProps {
  /** The accessible name, also the visible label. */
  label: string;
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  disabled?: boolean | undefined;
  /** Tooltip while disabled (the standard read-only / missing-privilege wording). */
  title?: string | undefined;
  hint?: string | undefined;
}

/** A labelled on/off switch (`role="switch"`) for the Firewall tab's options card. */
export function FirewallSwitch({ label, checked, onCheckedChange, disabled, title, hint }: FirewallSwitchProps) {
  return (
    <div className="flex items-center justify-between gap-3" title={disabled ? title : undefined}>
      <div className="flex min-w-0 flex-col">
        <span className="text-sm">{label}</span>
        {hint && <span className="text-xs text-muted-foreground">{hint}</span>}
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-label={label}
        disabled={disabled}
        title={disabled ? title : undefined}
        onClick={() => onCheckedChange(!checked)}
        className={cn(
          'relative inline-flex h-5 w-9 shrink-0 items-center rounded-full border border-transparent outline-none transition-colors',
          'focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50',
          checked ? 'bg-primary' : 'bg-input',
        )}
      >
        <span
          aria-hidden="true"
          className={cn(
            'pointer-events-none block size-4 rounded-full bg-background shadow-xs transition-transform',
            checked ? 'translate-x-4' : 'translate-x-0.5',
          )}
        />
      </button>
    </div>
  );
}
