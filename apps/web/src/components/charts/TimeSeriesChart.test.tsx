import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';

import { TimeSeriesChart } from './TimeSeriesChart';
import type { TimeSeriesData } from './chart-types';

// jsdom has no canvas, so uPlot itself can't run in tests. Mock it with a stand-in that
// records constructor/setData/destroy calls and fires the `ready` hook synchronously, which
// is enough to exercise TimeSeriesChart's own logic (sizing, colors, tooltip wiring) without
// needing a real canvas.
const uplotState = {
  constructed: 0,
  setDataCalls: 0,
  destroyed: 0,
};

vi.mock('uplot', () => {
  class MockUplot {
    root: HTMLElement;
    over: HTMLDivElement;
    cursor: { idx: number | null; left: number; top: number } = { idx: null, left: 0, top: 0 };
    data: unknown;

    constructor(opts: { hooks?: { ready?: ((self: MockUplot) => void)[] } }, data: unknown, target: HTMLElement) {
      uplotState.constructed += 1;
      this.root = target;
      this.data = data;
      this.over = document.createElement('div');
      target.appendChild(this.over);
      opts.hooks?.ready?.forEach((fn) => fn(this));
    }

    setSize() {}

    setData(data: unknown) {
      uplotState.setDataCalls += 1;
      this.data = data;
    }

    destroy() {
      uplotState.destroyed += 1;
    }
  }

  return { default: MockUplot };
});

const data: TimeSeriesData = {
  x: [1000, 1060, 1120, 1180, 1240],
  series: [
    { label: 'CPU', unit: 'percent', color: 'teal', values: [10, 20, null, 30, 40] },
  ],
};

// jsdom doesn't implement ResizeObserver. Defined once (not per-test) so it's still around
// for any chart-construction microtask still in flight when a test's own `afterEach` runs.
class MockResizeObserver {
  observe() {}
  disconnect() {}
}
vi.stubGlobal('ResizeObserver', MockResizeObserver);

beforeEach(() => {
  uplotState.constructed = 0;
  uplotState.setDataCalls = 0;
  uplotState.destroyed = 0;
});

afterEach(() => {
  cleanup();
});

describe('TimeSeriesChart', () => {
  it('exposes an aria-label summary and a visually hidden table of the last 5 points', async () => {
    render(<TimeSeriesChart {...data} />);
    await waitFor(() => expect(uplotState.constructed).toBe(1));

    const img = screen.getByRole('img');
    const label = img.getAttribute('aria-label') ?? '';
    expect(label).toContain('CPU');
    expect(label).toContain('Latest: CPU 40%');

    const table = screen.getByRole('table', { hidden: true });
    const rows = within(table).getAllByRole('row', { hidden: true });
    // header row + 5 data rows
    expect(rows).toHaveLength(6);
    // the null sample renders as a placeholder, not a false zero
    expect(within(table).getByText('--')).toBeInTheDocument();
  });

  it('renders an empty accessible summary for no data without throwing', async () => {
    render(<TimeSeriesChart x={[]} series={[{ label: 'CPU', unit: 'percent', values: [] }]} />);
    expect(screen.getByRole('img').getAttribute('aria-label')).toContain('No data');
    await waitFor(() => expect(uplotState.constructed).toBe(1));
  });

  it('constructs the (mocked) uPlot instance once mounted', async () => {
    render(<TimeSeriesChart {...data} />);
    await waitFor(() => expect(uplotState.constructed).toBe(1));
  });

  it('pushes new values via setData instead of reconstructing when only data changes', async () => {
    const { rerender } = render(<TimeSeriesChart {...data} />);
    await waitFor(() => expect(uplotState.constructed).toBe(1));

    const nextData: TimeSeriesData = {
      x: [...data.x, 1300],
      series: [{ label: 'CPU', unit: 'percent', color: 'teal', values: [...data.series[0]!.values, 50] }],
    };
    rerender(<TimeSeriesChart {...nextData} />);

    await waitFor(() => expect(uplotState.setDataCalls).toBeGreaterThan(0));
    expect(uplotState.constructed).toBe(1);
  });

  it('destroys the instance on unmount', async () => {
    const { unmount } = render(<TimeSeriesChart {...data} />);
    await waitFor(() => expect(uplotState.constructed).toBe(1));
    unmount();
    expect(uplotState.destroyed).toBe(1);
  });
});
