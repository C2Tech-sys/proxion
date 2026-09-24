import type { TimeSeriesData } from '@/components/charts/chart-types';

/** One panel's worth of chart data: a shared x-axis and one or more series. */
export type ChartPanelData = TimeSeriesData;

/** Fields PVE returns from `.../nodes/{node}/{qemu|lxc}/{vmid}/rrddata` (a superset across guest types). */
export interface VmRrdRow {
  time: number;
  cpu?: number | undefined;
  maxcpu?: number | undefined;
  mem?: number | undefined;
  maxmem?: number | undefined;
  disk?: number | undefined;
  maxdisk?: number | undefined;
  netin?: number | undefined;
  netout?: number | undefined;
  diskread?: number | undefined;
  diskwrite?: number | undefined;
}

/** Fields PVE returns from `.../nodes/{node}/rrddata`. */
export interface NodeRrdRow {
  time: number;
  cpu?: number | undefined;
  iowait?: number | undefined;
  loadavg?: number | undefined;
  maxcpu?: number | undefined;
  memtotal?: number | undefined;
  memused?: number | undefined;
  swaptotal?: number | undefined;
  swapused?: number | undefined;
  roottotal?: number | undefined;
  rootused?: number | undefined;
  netin?: number | undefined;
  netout?: number | undefined;
}

export interface VmChartSeries {
  cpu: ChartPanelData;
  memory: ChartPanelData;
  diskIo: ChartPanelData;
  network: ChartPanelData;
}

export interface NodeChartSeries {
  cpu: ChartPanelData;
  load: ChartPanelData;
  memory: ChartPanelData;
  swap: ChartPanelData;
  rootfs: ChartPanelData;
  network: ChartPanelData;
}

/** Turns a missing/undefined/NaN PVE field into `null` so uPlot draws a break, not a false zero. */
function gap(value: number | undefined | null): number | null {
  return value === undefined || value === null || Number.isNaN(value) ? null : value;
}

/** Same as `gap`, scaled by 100 (PVE reports cpu/iowait as a 0..1 fraction, charts want a percent). */
function gapPercent(value: number | undefined | null): number | null {
  return value === undefined || value === null || Number.isNaN(value) ? null : value * 100;
}

function timesOf(rows: readonly { time: number }[]): number[] {
  return rows.map((r) => r.time);
}

/** Transforms VM/CT rrddata rows into the four Monitor-tab / Summary-tab sparkline panels. */
export function vmSeries(rows: VmRrdRow[]): VmChartSeries {
  const x = timesOf(rows);
  return {
    cpu: {
      x,
      series: [{ label: 'CPU', unit: 'percent', color: 'teal', values: rows.map((r) => gapPercent(r.cpu)) }],
    },
    memory: {
      x,
      series: [
        { label: 'Used', unit: 'bytes', color: 'teal', values: rows.map((r) => gap(r.mem)) },
        { label: 'Max', unit: 'bytes', color: 'sky', style: 'dashed', values: rows.map((r) => gap(r.maxmem)) },
      ],
    },
    diskIo: {
      x,
      series: [
        { label: 'Read', unit: 'bytesPerSec', color: 'emerald', values: rows.map((r) => gap(r.diskread)) },
        { label: 'Write', unit: 'bytesPerSec', color: 'amber', values: rows.map((r) => gap(r.diskwrite)) },
      ],
    },
    network: {
      x,
      series: [
        { label: 'In', unit: 'bytesPerSec', color: 'teal', values: rows.map((r) => gap(r.netin)) },
        { label: 'Out', unit: 'bytesPerSec', color: 'violet', values: rows.map((r) => gap(r.netout)) },
      ],
    },
  };
}

/** Transforms node rrddata rows into the six Monitor-tab panels. */
export function nodeSeries(rows: NodeRrdRow[]): NodeChartSeries {
  const x = timesOf(rows);
  return {
    cpu: {
      x,
      series: [
        { label: 'CPU', unit: 'percent', color: 'teal', values: rows.map((r) => gapPercent(r.cpu)) },
        { label: 'IO wait', unit: 'percent', color: 'sky', values: rows.map((r) => gapPercent(r.iowait)) },
      ],
    },
    load: {
      x,
      series: [{ label: 'Load average', unit: 'load', color: 'teal', values: rows.map((r) => gap(r.loadavg)) }],
    },
    memory: {
      x,
      series: [
        { label: 'Used', unit: 'bytes', color: 'teal', values: rows.map((r) => gap(r.memused)) },
        { label: 'Total', unit: 'bytes', color: 'sky', style: 'dashed', values: rows.map((r) => gap(r.memtotal)) },
      ],
    },
    swap: {
      x,
      series: [
        { label: 'Used', unit: 'bytes', color: 'teal', values: rows.map((r) => gap(r.swapused)) },
        { label: 'Total', unit: 'bytes', color: 'sky', style: 'dashed', values: rows.map((r) => gap(r.swaptotal)) },
      ],
    },
    rootfs: {
      x,
      series: [
        { label: 'Used', unit: 'bytes', color: 'teal', values: rows.map((r) => gap(r.rootused)) },
        { label: 'Total', unit: 'bytes', color: 'sky', style: 'dashed', values: rows.map((r) => gap(r.roottotal)) },
      ],
    },
    network: {
      x,
      series: [
        { label: 'In', unit: 'bytesPerSec', color: 'teal', values: rows.map((r) => gap(r.netin)) },
        { label: 'Out', unit: 'bytesPerSec', color: 'violet', values: rows.map((r) => gap(r.netout)) },
      ],
    },
  };
}

/** Timeframes offered for a VM/CT Monitor tab, matching PVE's rrddata `timeframe` values. */
export const VM_RRD_TIMEFRAMES = ['hour', 'day', 'week', 'month', 'year'] as const;
export type VmRrdTimeframe = (typeof VM_RRD_TIMEFRAMES)[number];

export function isVmRrdTimeframe(value: unknown): value is VmRrdTimeframe {
  return typeof value === 'string' && (VM_RRD_TIMEFRAMES as readonly string[]).includes(value);
}

/** Timeframes offered for a node Monitor tab; nodes also get `decade` (PVE 9). */
export const NODE_RRD_TIMEFRAMES = ['hour', 'day', 'week', 'month', 'year', 'decade'] as const;
export type NodeRrdTimeframe = (typeof NODE_RRD_TIMEFRAMES)[number];

export function isNodeRrdTimeframe(value: unknown): value is NodeRrdTimeframe {
  return typeof value === 'string' && (NODE_RRD_TIMEFRAMES as readonly string[]).includes(value);
}

/** Display label for a timeframe chip. */
export const RRD_TIMEFRAME_LABEL: Record<NodeRrdTimeframe, string> = {
  hour: 'Hour',
  day: 'Day',
  week: 'Week',
  month: 'Month',
  year: 'Year',
  decade: 'Decade',
};

/**
 * PVE's `.../rrddata` step in seconds per timeframe (each returns ~70 fixed-step samples
 * ending "now"): hour=60s, day=30m, week=3h, month=12h, year=7d, decade=70d (PVE 9).
 */
export const RRD_STEP_SECONDS: Record<NodeRrdTimeframe, number> = {
  hour: 60,
  day: 30 * 60,
  week: 3 * 3600,
  month: 12 * 3600,
  year: 7 * 86400,
  decade: 70 * 86400,
};

/**
 * Rebases a fixed-step RRD series so its last sample lands on `endTime`, preserving point
 * count, order and any gaps (fields are copied as-is, only `time` changes). Used to make
 * fixture data -- recorded once, whenever it was generated -- always look live, and to
 * guarantee the uniform per-timeframe step real PVE rrddata has.
 */
export function rebaseRrdTimestamps<T extends { time: number }>(rows: T[], step: number, endTime: number): T[] {
  const n = rows.length;
  return rows.map((row, i) => ({ ...row, time: endTime - (n - 1 - i) * step }));
}
