import { formatBytes, formatPercent, formatRate } from '@/lib/format';
import type { ChartColorToken } from '@/lib/chart-colors';

/** Unit a series is expressed in; drives axis/legend/tooltip formatting (see `formatForUnit`). */
export type ChartUnit = 'percent' | 'bytes' | 'bytesPerSec' | 'count' | 'load';

export interface TimeSeriesSeries {
  label: string;
  /** `null` entries are gaps -- uPlot draws a break in the line instead of dropping to zero. */
  values: (number | null)[];
  color?: ChartColorToken | undefined;
  unit: ChartUnit;
  /** 'dashed' marks a reference/ceiling line (e.g. "Max"/"Total"), visually distinct from 'solid'
   *  usage lines even when their colors read close together. Defaults to 'solid'. */
  style?: 'solid' | 'dashed' | undefined;
}

export interface TimeSeriesData {
  /** Unix timestamps in seconds, one per sample, shared by every series. */
  x: number[];
  series: TimeSeriesSeries[];
}

/** Formats one value the way its unit's axis/legend/tooltip should read, via the project formatters. */
export function formatForUnit(unit: ChartUnit, value: number): string {
  switch (unit) {
    case 'percent':
      return formatPercent(value / 100);
    case 'bytes':
      return formatBytes(value);
    case 'bytesPerSec':
      return formatRate(value);
    case 'load':
      return value.toFixed(2);
    case 'count':
    default:
      return value.toLocaleString();
  }
}

/**
 * Which date/time shape an x-axis tick should take, picked from the chart's own sample
 * spacing (so it's correct without threading the selected range through as a prop): the
 * hour (60s) and day (1800s) timeframes both read as a clock, week gets a weekday, month
 * drops the time entirely, and year/decade collapse to a month+year.
 */
export type AxisTimeBucket = 'clock' | 'weekday-clock' | 'month-day' | 'month-year';

/** Ascending [stepSeconds midpoint, bucket] boundaries between adjacent RRD_STEP_SECONDS values. */
const AXIS_TIME_BUCKET_BOUNDARIES: [maxStepSeconds: number, bucket: AxisTimeBucket][] = [
  [(1800 + 10800) / 2, 'clock'], // hour (60s) & day (1800s)
  [(10800 + 43200) / 2, 'weekday-clock'], // week (10800s)
  [(43200 + 604800) / 2, 'month-day'], // month (43200s)
  [(604800 + 6048000) / 2, 'month-year'], // year (604800s)
];

/** Picks the axis tick bucket for a series whose samples are `stepSeconds` apart. */
export function axisTimeBucket(stepSeconds: number): AxisTimeBucket {
  for (const [maxStep, bucket] of AXIS_TIME_BUCKET_BOUNDARIES) {
    if (stepSeconds <= maxStep) return bucket;
  }
  return 'month-year'; // decade (6048000s) and anything longer
}

const AXIS_TIME_FORMAT_OPTIONS: Record<AxisTimeBucket, Intl.DateTimeFormatOptions> = {
  clock: { hour: '2-digit', minute: '2-digit', hour12: false },
  // No minutes: at the week timeframe's tick density (roughly one per half-day at 1440px),
  // "Wed 00:00" next to "Thu 00:00" ran together into "Wed 00:00Thu 00:00" -- there wasn't
  // enough pixel gap between ticks for the full "weekday hour:minute" label. Dropping the
  // minutes ("Wed 0") is still unambiguous at this bucket (ticks are hours apart, never
  // sub-hour) and comfortably shorter than the two-tick gap.
  'weekday-clock': { weekday: 'short', hour: 'numeric', hour12: false },
  'month-day': { month: 'short', day: 'numeric' },
  'month-year': { month: 'short', year: 'numeric' },
};

/**
 * Formats one x-axis tick for a chart whose samples are `stepSeconds` apart, in the viewer's
 * own locale: hour/day -> "14:05", week -> "Wed 14", month -> "Sep 16", year/decade ->
 * "Sep 2026". No year is shown on the short ranges, where it would just repeat the current one.
 */
export function formatAxisTime(stepSeconds: number, timestampSeconds: number): string {
  const bucket = axisTimeBucket(stepSeconds);
  return new Intl.DateTimeFormat(undefined, AXIS_TIME_FORMAT_OPTIONS[bucket]).format(
    new Date(timestampSeconds * 1000),
  );
}
