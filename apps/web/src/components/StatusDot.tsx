import { cn } from '@/lib/utils';
import { statusToColor } from '@/lib/status';

const COLOR_CLASS: Record<ReturnType<typeof statusToColor>, string> = {
  running: 'bg-status-running',
  stopped: 'bg-status-stopped',
  paused: 'bg-status-paused',
  error: 'bg-status-error',
  template: 'bg-status-template',
  migrating: 'bg-status-migrating',
};

export interface StatusDotProps {
  status: string | undefined;
  template?: boolean | undefined;
  className?: string | undefined;
  label?: string | undefined;
}

/** A small filled circle mapping a raw status string to the semantic status color. */
export function StatusDot({ status, template, className, label }: StatusDotProps) {
  const color = statusToColor(status, template);
  return (
    <span
      role="img"
      aria-label={label ?? `Status: ${template ? 'template' : (status ?? 'unknown')}`}
      title={label ?? (template ? 'template' : status)}
      className={cn('inline-block size-2 shrink-0 rounded-full', COLOR_CLASS[color], className)}
    />
  );
}
