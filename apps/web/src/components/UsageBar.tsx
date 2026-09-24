import { cn } from '@/lib/utils';

export interface UsageBarProps {
  /** 0..1 fraction. Values outside that range are clamped; non-finite is treated as 0. */
  fraction: number;
  className?: string;
  /** Optional trailing label, e.g. "42%" or "12.0 GiB / 32.0 GiB". */
  label?: string;
  /** Width of the track; defaults to filling the parent. */
  trackClassName?: string;
}

/**
 * A compact horizontal usage bar for tables and panels (node CPU/memory, storage used/total).
 * Tone escalates from the running-green to paused-amber to error-red status colors as the
 * fraction climbs, so a glance at a dense table calls out anything close to full.
 */
export function UsageBar({ fraction, className, label, trackClassName }: UsageBarProps) {
  const safe = Number.isFinite(fraction) ? fraction : 0;
  const pct = Math.max(0, Math.min(1, safe)) * 100;
  const tone = pct >= 90 ? 'bg-status-error' : pct >= 75 ? 'bg-status-paused' : 'bg-status-running';

  return (
    <div className={cn('flex min-w-0 items-center gap-2', className)}>
      <div className={cn('h-1.5 min-w-10 flex-1 overflow-hidden rounded-full bg-muted', trackClassName)}>
        <div className={cn('h-full rounded-full', tone)} style={{ width: `${pct}%` }} />
      </div>
      {label !== undefined && (
        <span className="shrink-0 whitespace-nowrap text-[11px] text-muted-foreground font-numeric">{label}</span>
      )}
    </div>
  );
}
