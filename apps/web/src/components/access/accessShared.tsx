import type { ComponentType, ReactNode } from 'react';

import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';

export interface FieldProps {
  label: string;
  htmlFor: string;
  error?: string | undefined;
  hint?: string | undefined;
  children: ReactNode;
}

export function Field({ label, htmlFor, error, hint, children }: FieldProps) {
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

export interface CheckFieldProps {
  id: string;
  label: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
}

export function CheckField({ id, label, checked, onChange, disabled }: CheckFieldProps) {
  return (
    <div className="flex items-center gap-2">
      <Checkbox id={id} checked={checked} onCheckedChange={(c) => onChange(c === true)} disabled={disabled === true} />
      <label htmlFor={id} className="text-sm">
        {label}
      </label>
    </div>
  );
}

export interface IconActionProps {
  label: string;
  icon: ComponentType<{ className?: string }>;
  onClick: () => void;
  /** When set, the button is disabled and this is its tooltip. */
  disabledReason?: string | undefined;
  destructive?: boolean;
}

/** A per-row icon button: accessible name = `label`; tooltip = `label` or the reason it is disabled. */
export function IconAction({ label, icon: Icon, onClick, disabledReason, destructive }: IconActionProps) {
  const disabled = disabledReason !== undefined;
  return (
    <Button
      variant="ghost"
      size="icon"
      className={`size-7 shrink-0${destructive && !disabled ? ' text-destructive hover:text-destructive' : ''}`}
      aria-label={label}
      title={disabledReason ?? label}
      disabled={disabled}
      aria-disabled={disabled || undefined}
      onClick={onClick}
    >
      <Icon className="size-3.5" />
    </Button>
  );
}

