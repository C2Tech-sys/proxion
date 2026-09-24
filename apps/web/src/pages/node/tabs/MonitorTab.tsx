import { useNavigate, useSearch } from '@tanstack/react-router';

import { EmptyState } from '@/components/EmptyState';
import { Panel } from '@/components/Panel';
import { RangeChips } from '@/components/charts/RangeChips';
import { TimeSeriesChart } from '@/components/charts/TimeSeriesChart';
import { Skeleton } from '@/components/ui/skeleton';
import { useNodeRrd } from '@/api/hooks';
import { usePrefs } from '@/api/prefsHooks';
import {
  isNodeRrdTimeframe,
  NODE_RRD_TIMEFRAMES,
  RRD_TIMEFRAME_LABEL,
  nodeSeries,
  type NodeRrdTimeframe,
} from '@/lib/rrd';
import type { NodeTabProps } from '@/pages/node/tabs';

/** Node Monitor tab: CPU/Load/Memory/Swap/Root FS/Network over a selectable RRD timeframe. */
export function MonitorTab({ node }: NodeTabProps) {
  const { range } = useSearch({ from: '/_shell/node/$node' });
  const navigate = useNavigate({ from: '/node/$node' });
  // URL wins; otherwise the user's default-range preference (Preferences page); otherwise
  // 'hour'. Applied where the range is *read*, so the address bar stays clean until the user
  // picks a range themselves.
  const { data: prefs } = usePrefs();
  const preferred = prefs?.defaultRange;
  const effectiveRange: NodeRrdTimeframe =
    range ?? (preferred !== undefined && isNodeRrdTimeframe(preferred) ? preferred : 'hour');
  const { data: rows, isLoading, isError } = useNodeRrd(node, effectiveRange);

  function setRange(next: NodeRrdTimeframe) {
    void navigate({ search: (prev) => ({ ...prev, range: next }), replace: true });
  }

  return (
    <div className="flex flex-col gap-3">
      <RangeChips value={effectiveRange} options={NODE_RRD_TIMEFRAMES} labels={RRD_TIMEFRAME_LABEL} onChange={setRange} />

      {isError ? (
        <EmptyState message="Could not load performance data." />
      ) : isLoading || !rows ? (
        <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
          {['cpu', 'load', 'memory', 'swap', 'rootfs', 'network'].map((key) => (
            <Skeleton key={key} className="h-52" />
          ))}
        </div>
      ) : (
        <MonitorGrid rows={rows} />
      )}
    </div>
  );
}

function MonitorGrid({ rows }: { rows: Parameters<typeof nodeSeries>[0] }) {
  const series = nodeSeries(rows);
  return (
    <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
      <Panel title="CPU">
        <TimeSeriesChart {...series.cpu} />
      </Panel>
      <Panel title="Load">
        <TimeSeriesChart {...series.load} />
      </Panel>
      <Panel title="Memory">
        <TimeSeriesChart {...series.memory} />
      </Panel>
      <Panel title="Swap">
        <TimeSeriesChart {...series.swap} />
      </Panel>
      <Panel title="Root FS">
        <TimeSeriesChart {...series.rootfs} />
      </Panel>
      <Panel title="Network">
        <TimeSeriesChart {...series.network} />
      </Panel>
    </div>
  );
}
