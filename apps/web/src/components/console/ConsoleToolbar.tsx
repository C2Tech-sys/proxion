import type { ComponentType, ReactNode } from 'react';
import { ExternalLink } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import { ConsoleStatusPill, type ConsoleConnectionStatus } from './ConsoleStatusPill';

export interface ConsoleToolbarButtonProps {
  icon: ComponentType<{ className?: string }>;
  label: string;
  onClick?: (() => void) | undefined;
  disabled?: boolean | undefined;
  active?: boolean | undefined;
}

/** One icon button in a console toolbar, with a tooltip for its label (icon-only, dense). */
export function ConsoleToolbarButton({ icon: Icon, label, onClick, disabled, active }: ConsoleToolbarButtonProps) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          type="button"
          variant={active ? 'secondary' : 'ghost'}
          size="icon"
          className="size-7"
          onClick={onClick}
          disabled={disabled}
          aria-label={label}
          aria-pressed={active}
        >
          <Icon className="size-4" />
        </Button>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}

export interface ConsoleToolbarProps {
  status: ConsoleConnectionStatus;
  reason?: string | undefined;
  /** Fixture mode: whole toolbar renders in its disabled shape, same layout. */
  disabled?: boolean | undefined;
  popoutHref: string;
  onPopout: () => void;
  /** Console/terminal-specific action buttons, rendered before the pop-out button. */
  children?: ReactNode | undefined;
}

/** Shared toolbar shell for VncConsole and Terminal: status pill, actions, pop-out link. */
export function ConsoleToolbar({ status, reason, disabled, popoutHref, onPopout, children }: ConsoleToolbarProps) {
  return (
    <div className={cn('flex items-center gap-1.5 border-b border-border px-2 py-1.5')}>
      <ConsoleStatusPill status={status} reason={reason} />
      <div className="ml-auto flex items-center gap-0.5">
        {children}
        <ConsoleToolbarButton icon={ExternalLink} label="Open in new window" onClick={onPopout} disabled={disabled} />
      </div>
      {/* Kept in the DOM (not just visual) so the pop-out link works with middle-click / "open in tab". */}
      <a href={popoutHref} className="sr-only" tabIndex={-1} aria-hidden="true">
        Pop out
      </a>
    </div>
  );
}
