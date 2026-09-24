import { formatPercent } from '@/lib/format';
import { Sparkline } from '@/components/Sparkline';

export interface GaugeProps {
  label: string;
  fraction: number;
  detail?: string | undefined;
  history?: number[] | undefined;
  historyMax?: number | undefined;
}

/** A labeled resource gauge: value + percent bar + a sparkline of recent history. */
export function Gauge({ label, fraction, detail, history, historyMax }: GaugeProps) {
  const clamped = Number.isFinite(fraction) ? Math.max(0, Math.min(1, fraction)) : 0;
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-xs text-muted-foreground">{label}</span>
        <span className="font-display text-[28px] leading-none font-light tracking-[var(--font-display-tracking)] font-numeric">
          {formatPercent(clamped)}
        </span>
      </div>
      <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
        <div
          className="h-full rounded-full bg-accent transition-[width] duration-150 ease-out motion-reduce:transition-none"
          style={{ width: `${clamped * 100}%` }}
        />
      </div>
      <div className="flex items-center justify-between gap-2">
        {detail ? <span className="text-xs text-muted-foreground font-numeric">{detail}</span> : <span />}
        {history && history.length > 1 ? (
          <Sparkline values={history} max={historyMax} width={72} height={18} />
        ) : null}
      </div>
    </div>
  );
}
