import { useEffect, useRef } from 'react';
import type uPlotType from 'uplot';
import 'uplot/dist/uPlot.min.css';

import { useUiStore } from '@/store/ui';
import { cn } from '@/lib/utils';
import { formatDateTime } from '@/lib/format';
import { DEFAULT_CHART_COLOR_ORDER, resolveChartColor, resolveCssVar } from '@/lib/chart-colors';
import { formatAxisTime, formatForUnit } from '@/components/charts/chart-types';
import type { TimeSeriesData, TimeSeriesSeries } from '@/components/charts/chart-types';

/**
 * Fixed y-axis gutter width in CSS pixels. Reserves enough room for the widest label this
 * chart ever draws (e.g. "999.9 MiB/s") so it's never clipped -- a measured width would be
 * more exact, but ties the result to uPlot's internal canvas scaling in ways that are easy to
 * get subtly wrong; a fixed reservation is simple and always correct.
 */
const Y_AXIS_WIDTH = 72;

export type { ChartUnit, TimeSeriesData, TimeSeriesSeries } from '@/components/charts/chart-types';

export interface TimeSeriesChartProps extends TimeSeriesData {
  height?: number | undefined;
  className?: string | undefined;
}

/** Resolves series `i`'s color: its own token if set, else the next one in the shared rotation. */
function seriesColor(s: TimeSeriesSeries, i: number, el?: Element): string {
  const token =
    s.color ?? DEFAULT_CHART_COLOR_ORDER[i % DEFAULT_CHART_COLOR_ORDER.length] ?? 'teal';
  return resolveChartColor(token, el);
}

function lastPoints(data: TimeSeriesData, count: number) {
  const start = Math.max(0, data.x.length - count);
  return data.x.slice(start).map((time, offset) => ({
    time,
    values: data.series.map((s) => s.values[start + offset] ?? null),
  }));
}

function summarize(data: TimeSeriesData): string {
  const labels = data.series.map((s) => s.label).join(', ') || 'no series';
  if (data.x.length === 0) return `Time series chart of ${labels}. No data.`;
  const first = data.x[0];
  const last = data.x[data.x.length - 1];
  const range =
    first !== undefined && last !== undefined
      ? `${formatDateTime(first)} to ${formatDateTime(last)}`
      : '';
  const latest = data.series
    .map((s) => {
      const v = s.values[s.values.length - 1];
      return `${s.label} ${v == null ? 'no data' : formatForUnit(s.unit, v)}`;
    })
    .join(', ');
  return `Time series chart of ${labels} from ${range}. Latest: ${latest}.`;
}

/** Builds the uPlot series/axis config for a fixed set of series (labels/units/colors are stable per chart). */
function buildStructuralOptions(
  x: number[],
  series: TimeSeriesSeries[],
  width: number,
  height: number,
  container: HTMLElement,
): uPlotType.Options {
  const gridColor = resolveCssVar('--border', container, '#8888884d');
  const textColor = resolveCssVar('--muted-foreground', container, '#888');
  // uPlot draws axis/legend text on canvas, which can't see `var(--font-sans)` -- resolve
  // Proxion's actual Open Sans stack so charts match the rest of the UI instead of uPlot's
  // own Arial default.
  const axisFont = `12px ${resolveCssVar('--font-sans', container, 'ui-sans-serif')}`;
  const unit = series[0]?.unit ?? 'count';
  // Samples are evenly spaced (PVE rrddata has a fixed step per timeframe); pick the x-axis
  // tick format from that spacing so hour/day charts read as a clock, week gets a weekday,
  // and month/year/decade drop down to a date -- see chart-types' formatAxisTime.
  const xStep = x.length > 1 ? (x[1] ?? 0) - (x[0] ?? 0) : 60;

  return {
    width,
    height,
    // PVE rrddata timestamps are unix seconds; `ms` is the multiplier that turns one data unit
    // into 1 millisecond, so seconds-based data needs 1e-3 (uPlot's own default) -- NOT 1,
    // which claims the data is already in milliseconds and made the built-in legend's "Time"
    // column read back a bogus 1970-something date while our own axis/tooltip (which convert
    // the raw seconds value themselves) still looked correct.
    ms: 1e-3,
    // [top, right, bottom, left]. The right side needs more than a token 8px: the rightmost
    // x-axis tick's label is centered under its tick mark, so roughly half of that label's
    // width can extend past the last plotted point -- and past the chart's own `overflow:
    // hidden` wrapper (added to keep the cursor crosshair contained; see the `ready` hook
    // below) that would otherwise clip it. The week timeframe's "<weekday>, <hour>" label is
    // the widest of the bunch (see chart-types.ts's weekday-clock format) and was the one
    // observed clipped ("Thu, 0" for "Thu, 07"); 24px comfortably covers half of it.
    padding: [8, 24, 0, 0],
    series: [
      {},
      ...series.map((s, i) => ({
        label: s.label,
        stroke: seriesColor(s, i, container),
        width: 1.5,
        ...(s.style === 'dashed' ? { dash: [6, 4] } : {}),
        points: { show: false },
        spanGaps: false,
        value: (_self: uPlotType, raw: number | null | undefined) =>
          raw == null ? '--' : formatForUnit(s.unit, raw),
      })),
    ],
    scales: { x: { time: true } },
    axes: [
      {
        stroke: textColor,
        font: axisFont,
        grid: { stroke: gridColor, width: 1 },
        ticks: { stroke: gridColor },
        values: (_self, splits) => splits.map((v) => formatAxisTime(xStep, v)),
      },
      {
        stroke: textColor,
        font: axisFont,
        grid: { stroke: gridColor, width: 1 },
        ticks: { stroke: gridColor },
        size: Y_AXIS_WIDTH,
        values: (_self, splits) => splits.map((v) => formatForUnit(unit, v)),
      },
    ],
    cursor: {
      points: { show: true },
    },
    legend: { live: true },
  };
}

/**
 * A React wrapper around uPlot: sizes to its container (ResizeObserver), reads series colors
 * from the theme's CSS tokens (re-resolved when the theme toggles), and shows a crosshair
 * cursor with a unified hover tooltip alongside uPlot's live-values legend. No animation --
 * uPlot draws directly to canvas, so `prefers-reduced-motion` needs nothing extra here.
 */
export function TimeSeriesChart({ x, series, height = 180, className }: TimeSeriesChartProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const plotRef = useRef<uPlotType | null>(null);
  const latestRef = useRef<TimeSeriesData>({ x, series });
  const theme = useUiStore((s) => s.theme);

  // Keep `latestRef` current for the effects below without reading/writing it during render.
  useEffect(() => {
    latestRef.current = { x, series };
  });

  // Structural signature: rebuild the plot only when the shape of the chart changes (series
  // count/labels/units/colors, height, or theme), not on every data poll.
  const structuralKey = `${theme}|${height}|${series
    .map((s) => `${s.label}:${s.unit}:${s.color ?? ''}`)
    .join(',')}`;

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return undefined;

    let cancelled = false;
    let plot: uPlotType | null = null;
    let ro: ResizeObserver | null = null;

    // uPlot touches `matchMedia` as soon as its module evaluates, which jsdom (used by tests
    // that never render a chart at all) doesn't implement. Loading it lazily means that only
    // ever runs where a chart is actually mounted.
    void import('uplot').then(({ default: UPlot }) => {
      if (cancelled) return;

      const { x: initialX, series: initialSeries } = latestRef.current;
      const width = container.clientWidth || 320;
      const opts = buildStructuralOptions(initialX, initialSeries, width, height, container);

      const tooltip = document.createElement('div');
      tooltip.className = 'ts-chart-tooltip';
      // True while synthesizing the "default to last sample" hover below, so the setCursor
      // hook can update uPlot's own legend (which is what that's for) without also popping open
      // our floating tooltip on every chart at once -- that tooltip is for an actual hover.
      let isSyntheticHover = false;
      opts.hooks = {
        ready: [
          (u) => {
            // `u.over` is already `position: absolute` (uPlot's own stylesheet), which is all
            // an absolutely-positioned descendant (the tooltip) needs as a containing block --
            // it does NOT need to be switched to `relative`. Doing that used to drop `u.over`
            // out of absolute overlay mode into normal flow, so its cursor lines (`.u-cursor-x`
            // / `.u-cursor-y`, sized 100% of `u.over`) rendered *after* the canvas instead of
            // overlaid on it: dashed crosshairs hanging below the chart and spilling into the
            // gap before the next panel instead of stopping at this chart's plot area.
            u.over.appendChild(tooltip);

            // Default the legend to the last sample's values instead of leaving it blank
            // ("Time: -- CPU: --") until the person actually hovers, by synthesizing a pointer
            // move at the chart's right edge -- the same event uPlot's own cursor handling
            // responds to for a real hover.
            const showLatest = () => {
              const rect = u.over.getBoundingClientRect();
              if (rect.width === 0) return; // no real layout (e.g. under jsdom) to simulate against
              isSyntheticHover = true;
              u.over.dispatchEvent(
                new MouseEvent('mousemove', {
                  clientX: rect.right - 1,
                  clientY: rect.top + rect.height / 2,
                  bubbles: true,
                }),
              );
              isSyntheticHover = false;
            };
            showLatest();
            u.over.addEventListener('mouseleave', showLatest);
          },
        ],
        setCursor: [
          (u) => {
            const idx = u.cursor.idx;
            const { x: liveX, series: liveSeries } = latestRef.current;
            if (isSyntheticHover || idx == null || idx < 0 || liveX[idx] === undefined) {
              tooltip.style.display = 'none';
              return;
            }
            const time = liveX[idx];
            const rows = liveSeries
              .map((s, i) => {
                const v = s.values[idx] ?? null;
                return `<div><span class="ts-chart-tooltip-dot" style="background:${seriesColor(
                  s,
                  i,
                  container,
                )}"></span>${s.label}: ${v == null ? '--' : formatForUnit(s.unit, v)}</div>`;
              })
              .join('');
            tooltip.innerHTML = `<div class="ts-chart-tooltip-time">${formatDateTime(time)}</div>${rows}`;
            tooltip.style.display = 'block';
            const left = (u.cursor.left ?? 0) + 12;
            const top = (u.cursor.top ?? 0) + 12;
            tooltip.style.transform = `translate(${left}px, ${top}px)`;
          },
        ],
      };

      const data = [initialX, ...initialSeries.map((s) => s.values)] as uPlotType.AlignedData;
      plot = new UPlot(opts, data, container);
      plotRef.current = plot;

      ro = new ResizeObserver((entries) => {
        const entry = entries[0];
        if (!entry) return;
        const nextWidth = entry.contentRect.width;
        if (nextWidth > 0) plot?.setSize({ width: nextWidth, height });
      });
      ro.observe(container);
    });

    return () => {
      cancelled = true;
      ro?.disconnect();
      plot?.destroy();
      plotRef.current = null;
    };
  }, [structuralKey, height]);

  // Data-only updates (new poll of the same shape): push new values without rebuilding.
  useEffect(() => {
    plotRef.current?.setData([x, ...series.map((s) => s.values)] as uPlotType.AlignedData);
  }, [x, series]);

  const data: TimeSeriesData = { x, series };
  const ariaLabel = summarize(data);
  const recent = lastPoints(data, 5);

  return (
    // `relative`: gives the sr-only table below a positioned containing block. Without it, an
    // absolutely-positioned descendant's containing block is the initial containing block (the
    // viewport/body), so if that descendant ever escapes its own clipping (see below) it can
    // grow the whole document instead of just this chart.
    <div className={cn('relative', className)}>
      <div
        ref={containerRef}
        role="img"
        aria-label={ariaLabel}
        // `overflow: hidden` is a belt-and-suspenders clip: uPlot's cursor lines and legend
        // are sized/positioned to stay within this box, but nothing outside this component
        // should ever have to rely on that -- a future regression there is contained here
        // instead of bleeding dashed crosshairs into the surrounding page.
        style={{ width: '100%', height, overflow: 'hidden' }}
      />
      {/*
       * The `sr-only` clip (position:absolute, 1x1px, overflow:hidden) goes on this wrapping
       * `<div>`, not directly on the `<table>` below: a `<table>` element's table-layout
       * algorithm can ignore an explicit `height: 1px` and reflow to its content's natural
       * height instead (observed: ~132px for this table), so putting `sr-only` on the table
       * itself left a 132px-tall, unclipped box sitting in the document (its containing block
       * was `<body>`, since nothing here was `position: relative` -- see above), which pushed
       * the whole page's scrollHeight past the viewport and made the window itself scroll. A
       * plain `<div>` respects `height: 1px` correctly, so wrapping the (still fully-marked-up,
       * for assistive tech) table in one fixes the clipping without changing what's exposed.
       */}
      <div className="sr-only">
        <table>
          <caption>{ariaLabel}</caption>
          <thead>
            <tr>
              <th scope="col">Time</th>
              {series.map((s) => (
                <th scope="col" key={s.label}>
                  {s.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {recent.map((row) => (
              <tr key={row.time}>
                <td>{formatDateTime(row.time)}</td>
                {row.values.map((v, i) => (
                  <td key={series[i]?.label ?? i}>
                    {v == null ? '--' : formatForUnit(series[i]?.unit ?? 'count', v)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
