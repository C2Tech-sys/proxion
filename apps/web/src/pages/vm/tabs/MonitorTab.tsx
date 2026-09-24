import { useNavigate, useSearch } from '@tanstack/react-router';

import { EmptyState } from '@/components/EmptyState';
import { Panel } from '@/components/Panel';
import { RangeChips } from '@/components/charts/RangeChips';
import { TimeSeriesChart } from '@/components/charts/TimeSeriesChart';
import { Skeleton } from '@/components/ui/skeleton';
import { useRrd } from '@/api/hooks';
import { usePrefs } from '@/api/prefsHooks';
import { RRD_TIMEFRAME_LABEL, VM_RRD_TIMEFRAMES, isVmRrdTimeframe, vmSeries, type VmRrdTimeframe } from '@/lib/rrd';
import type { VmTabProps } from '@/pages/vm/tabs';

/** VM/CT Monitor tab: CPU/Memory/Disk I/O/Network over a selectable RRD timeframe. */
export function MonitorTab({ node, type, vmid }: VmTabProps) {
  const { range } = useSearch({ from: '/_shell/vm/$node/$type/$vmid' });
  const navigate = useNavigate({ from: '/vm/$node/$type/$vmid' });
  
  // URL wins; otherwise the user's default-range preference (Preferences page); otherwise
  // 'hour'. The preference is applied where the range is *read*, so the address bar stays
  // clean until the user picks a range themselves.
  const { data: prefs } = usePrefs();
  const preferred = prefs?.defaultRange;
  const effectiveRange: VmRrdTimeframe =
    range ?? (preferred !== undefined && isVmRrdTimeframe(preferred) ? preferred : 'hour');
  const { data: rows, isLoading, isError } = useRrd(node, type, vmid, effectiveRange);

  function setRange(next: VmRrdTimeframe) {
    void navigate({ search: (prev) => ({ ...prev, range: next }), replace: true });
  }

  return (
    <div className="flex flex-col gap-3">
      <RangeChips value={effectiveRange} options={VM_RRD_TIMEFRAMES} labels={RRD_TIMEFRAME_LABEL} onChange={setRange} />

      {isError ? (
        <EmptyState message="Could not load performance data." />
      ) : isLoading || !rows ? (
        <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
          {['cpu', 'memory', 'disk', 'network'].map((key) => (
            <Skeleton key={key} className="h-52" />
          ))}
        </div>
      ) : (
        <MonitorGrid rows={rows} />
      )}
    </div>
  );
}

function MonitorGrid({ rows }: { rows: Parameters<typeof vmSeries>[0] }) {
  const series = vmSeries(rows);
  return (
    <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
      <Panel title="CPU">
        <TimeSeriesChart {...series.cpu} />
      </Panel>
      <Panel title="Memory">
        <TimeSeriesChart {...series.memory} />
      </Panel>
      <Panel title="Disk I/O">
        <TimeSeriesChart {...series.diskIo} />
      </Panel>
      <Panel title="Network">
        <TimeSeriesChart {...series.network} />
      </Panel>
    </div>
  );
}
