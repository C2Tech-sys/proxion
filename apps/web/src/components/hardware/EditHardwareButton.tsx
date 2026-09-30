import { Pencil } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';

export interface EditHardwareButtonProps {
  /** What the pencil edits, e.g. "CPU" -- becomes the accessible name "Edit CPU". */
  label: string;
  /** When set, the button is disabled and this is its tooltip (the standard read-only / missing
   * privilege wording, same as the object header's own quick actions). */
  disabledReason?: string | undefined;
  onClick: () => void;
}

/**
 * The per-row pencil on the Hardware tab. Gated by the caller (`isSessionMode && can(<priv>)`):
 * a disabled one carries the reason as its `title`, same convention as every other gated write
 * control in this app, so it's readable on hover/long-press and assertable in tests.
 */
export function EditHardwareButton({ label, disabledReason, onClick }: EditHardwareButtonProps) {
  const name = `Edit ${label}`;
  const disabled = disabledReason !== undefined;

  if (disabled) {
    return (
      <Button
        variant="ghost"
        size="icon"
        className="size-7 shrink-0"
        disabled
        aria-disabled="true"
        aria-label={name}
        title={disabledReason}
      >
        <Pencil className="size-3.5" />
      </Button>
    );
  }

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button variant="ghost" size="icon" className="size-7 shrink-0" aria-label={name} onClick={onClick}>
          <Pencil className="size-3.5" />
        </Button>
      </TooltipTrigger>
      <TooltipContent>{name}</TooltipContent>
    </Tooltip>
  );
}
