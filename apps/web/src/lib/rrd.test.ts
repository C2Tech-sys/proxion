import { describe, expect, it } from 'vitest';

import {
  RRD_STEP_SECONDS,
  isNodeRrdTimeframe,
  isVmRrdTimeframe,
  nodeSeries,
  rebaseRrdTimestamps,
  vmSeries,
  type NodeRrdRow,
  type VmRrdRow,
} from './rrd';

const vmRows: VmRrdRow[] = [
  { time: 1000, cpu: 0.1, maxcpu: 4, mem: 1024, maxmem: 4096, netin: 100, netout: 50, diskread: 10, diskwrite: 5 },
  { time: 1060, cpu: 0.2, maxcpu: 4, mem: 2048, maxmem: 4096, netin: 200, netout: 60, diskread: 20, diskwrite: 8 },
  // A gap: PVE omits fields entirely for missing samples.
  { time: 1120 },
  { time: 1180, cpu: 0.3, maxcpu: 4, mem: 3072, maxmem: 4096, netin: 300, netout: 70, diskread: 30, diskwrite: 9 },
];

const nodeRows: NodeRrdRow[] = [
  {
    time: 1000,
    cpu: 0.05,
    iowait: 0.01,
    loadavg: 1.2,
    memused: 1000,
    memtotal: 8000,
    swapused: 0,
    swaptotal: 2000,
    rootused: 5000,
    roottotal: 20000,
    netin: 500,
    netout: 400,
  },
  { time: 1060 },
  {
    time: 1120,
    cpu: 0.1,
    iowait: 0.02,
    loadavg: 1.5,
    memused: 1200,
    memtotal: 8000,
    swapused: 10,
    swaptotal: 2000,
    rootused: 5200,
    roottotal: 20000,
    netin: 550,
    netout: 420,
  },
];

describe('vmSeries', () => {
  it('returns empty panels for empty input', () => {
    const result = vmSeries([]);
    expect(result.cpu.x).toEqual([]);
    expect(result.cpu.series[0]?.values).toEqual([]);
    expect(result.memory.series).toHaveLength(2);
    expect(result.diskIo.series).toHaveLength(2);
    expect(result.network.series).toHaveLength(2);
  });

  it('converts cpu fraction to a percent', () => {
    const result = vmSeries(vmRows);
    expect(result.cpu.x).toEqual([1000, 1060, 1120, 1180]);
    expect(result.cpu.series).toHaveLength(1);
    expect(result.cpu.series[0]?.unit).toBe('percent');
    expect(result.cpu.series[0]?.values).toEqual([10, 20, null, 30]);
  });

  it('turns a gap row into null for every series, not zero', () => {
    const result = vmSeries(vmRows);
    expect(result.memory.series[0]?.values[2]).toBeNull();
    expect(result.memory.series[1]?.values[2]).toBeNull();
    expect(result.diskIo.series[0]?.values[2]).toBeNull();
    expect(result.diskIo.series[1]?.values[2]).toBeNull();
    expect(result.network.series[0]?.values[2]).toBeNull();
    expect(result.network.series[1]?.values[2]).toBeNull();
  });

  it('passes mem/maxmem through as raw bytes, marking Max as a dashed reference line', () => {
    const result = vmSeries(vmRows);
    expect(result.memory.series[0]?.values).toEqual([1024, 2048, null, 3072]);
    expect(result.memory.series[1]?.values).toEqual([4096, 4096, null, 4096]);
    expect(result.memory.series[0]?.unit).toBe('bytes');
    expect(result.memory.series[1]?.style).toBe('dashed');
  });

  it('maps disk and network fields to bytesPerSec series', () => {
    const result = vmSeries(vmRows);
    expect(result.diskIo.series[0]?.label).toBe('Read');
    expect(result.diskIo.series[0]?.values).toEqual([10, 20, null, 30]);
    expect(result.diskIo.series[1]?.label).toBe('Write');
    expect(result.diskIo.series[1]?.unit).toBe('bytesPerSec');
    expect(result.network.series[0]?.values).toEqual([100, 200, null, 300]);
    expect(result.network.series[1]?.values).toEqual([50, 60, null, 70]);
  });
});

describe('nodeSeries', () => {
  it('returns empty panels for empty input', () => {
    const result = nodeSeries([]);
    expect(result.cpu.x).toEqual([]);
    expect(result.load.series[0]?.values).toEqual([]);
  });

  it('converts cpu and iowait fractions to percent, keeping them as two series', () => {
    const result = nodeSeries(nodeRows);
    expect(result.cpu.series).toHaveLength(2);
    expect(result.cpu.series[0]?.label).toBe('CPU');
    expect(result.cpu.series[0]?.values).toEqual([5, null, 10]);
    expect(result.cpu.series[1]?.label).toBe('IO wait');
    expect(result.cpu.series[1]?.values).toEqual([1, null, 2]);
  });

  it('leaves load average unscaled with unit "load"', () => {
    const result = nodeSeries(nodeRows);
    expect(result.load.series[0]?.unit).toBe('load');
    expect(result.load.series[0]?.values).toEqual([1.2, null, 1.5]);
  });

  it('maps memory/swap/rootfs used-vs-total pairs as bytes', () => {
    const result = nodeSeries(nodeRows);
    expect(result.memory.series[0]?.values).toEqual([1000, null, 1200]);
    expect(result.memory.series[1]?.values).toEqual([8000, null, 8000]);
    expect(result.swap.series[0]?.values).toEqual([0, null, 10]);
    expect(result.rootfs.series[1]?.values).toEqual([20000, null, 20000]);
    expect(result.memory.series[0]?.unit).toBe('bytes');
  });

  it('maps netin/netout to bytesPerSec', () => {
    const result = nodeSeries(nodeRows);
    expect(result.network.series[0]?.values).toEqual([500, null, 550]);
    expect(result.network.series[1]?.values).toEqual([400, null, 420]);
  });

  it('treats an entirely missing row as a gap across every panel', () => {
    const result = nodeSeries(nodeRows);
    for (const panel of [result.cpu, result.load, result.memory, result.swap, result.rootfs, result.network]) {
      for (const s of panel.series) {
        expect(s.values[1]).toBeNull();
      }
    }
  });
});

describe('timeframe guards', () => {
  it('accepts the five VM timeframes and rejects decade', () => {
    expect(isVmRrdTimeframe('hour')).toBe(true);
    expect(isVmRrdTimeframe('year')).toBe(true);
    expect(isVmRrdTimeframe('decade')).toBe(false);
    expect(isVmRrdTimeframe('bogus')).toBe(false);
    expect(isVmRrdTimeframe(undefined)).toBe(false);
  });

  it('accepts decade for node timeframes', () => {
    expect(isNodeRrdTimeframe('decade')).toBe(true);
    expect(isNodeRrdTimeframe('hour')).toBe(true);
    expect(isNodeRrdTimeframe('bogus')).toBe(false);
  });
});

describe('RRD_STEP_SECONDS', () => {
  it('matches PVE rrddata step per timeframe', () => {
    expect(RRD_STEP_SECONDS.hour).toBe(60);
    expect(RRD_STEP_SECONDS.day).toBe(1800);
    expect(RRD_STEP_SECONDS.week).toBe(10800);
    expect(RRD_STEP_SECONDS.month).toBe(43200);
    expect(RRD_STEP_SECONDS.year).toBe(604800);
    expect(RRD_STEP_SECONDS.decade).toBe(6048000);
  });
});

describe('rebaseRrdTimestamps', () => {
  it('walks a fixed-step series back from endTime, landing the last sample exactly on it', () => {
    const rows = [{ time: 111 }, { time: 222 }, { time: 333 }, { time: 444 }];
    const endTime = 2_000_000;
    const rebased = rebaseRrdTimestamps(rows, RRD_STEP_SECONDS.hour, endTime);
    expect(rebased.map((r) => r.time)).toEqual([
      endTime - 3 * 60,
      endTime - 2 * 60,
      endTime - 1 * 60,
      endTime,
    ]);
  });

  it('produces strictly monotonic timestamps spaced by exactly `step`', () => {
    const rows = Array.from({ length: 70 }, (_, i) => ({ time: i }));
    const rebased = rebaseRrdTimestamps(rows, RRD_STEP_SECONDS.day, 5_000_000);
    for (let i = 1; i < rebased.length; i++) {
      expect(rebased[i]!.time - rebased[i - 1]!.time).toBe(RRD_STEP_SECONDS.day);
    }
    expect(rebased[rebased.length - 1]!.time).toBe(5_000_000);
  });

  it('preserves every other field untouched, including gap rows', () => {
    const rows: VmRrdRow[] = [
      { time: 1, cpu: 0.5 },
      { time: 2 }, // gap: no fields but time
    ];
    const rebased = rebaseRrdTimestamps(rows, 60, 1_000_000);
    expect(rebased[0]).toEqual({ time: 1_000_000 - 60, cpu: 0.5 });
    expect(rebased[1]).toEqual({ time: 1_000_000 });
  });

  it('handles an empty series without throwing', () => {
    expect(rebaseRrdTimestamps([], 60, 1_000_000)).toEqual([]);
  });
});
