import { useState } from 'react';
import { Camera, CirclePlay } from 'lucide-react';

import { Panel } from '@/components/Panel';
import { KeyValueGrid } from '@/components/KeyValueGrid';
import { EmptyState } from '@/components/EmptyState';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { useSnapshots } from '@/api/hooks';
import { errorMessage } from '@/api/errors';
import { buildSnapshotTree, flattenSnapshotTree, type SnapshotTreeNode } from '@/lib/snapshots';
import { formatDateTime } from '@/lib/format';
import { cn } from '@/lib/utils';
import type { VmTabProps } from '@/pages/vm/tabs';

function SnapshotRow({
  node,
  selected,
  onSelect,
}: {
  node: SnapshotTreeNode;
  selected: boolean;
  onSelect: () => void;
}) {
  const isNow = node.snapshot === null;
  return (
    <li>
      <button
        type="button"
        onClick={isNow ? undefined : onSelect}
        disabled={isNow}
        style={{ paddingLeft: `${node.depth * 20}px` }}
        className={cn(
          'flex w-full items-center gap-2 rounded-sm py-1.5 pr-2 text-left text-sm transition-colors',
          isNow ? 'cursor-default text-muted-foreground italic' : 'hover:bg-muted/60',
          selected && 'bg-accent/15 text-foreground',
        )}
      >
        {isNow ? <CirclePlay className="size-3.5 shrink-0" /> : <Camera className="size-3.5 shrink-0" />}
        <span className="truncate">{node.name}</span>
        {node.snapshot?.vmstate && (
          <Badge variant="outline" className="shrink-0">
            RAM
          </Badge>
        )}
      </button>
    </li>
  );
}

/** The VM/CT Snapshots tab: parent-chain tree (ending in "NOW") with a details side panel. */
export function SnapshotsTab({ node, type, vmid }: VmTabProps) {
  const { data, isLoading, isError, error } = useSnapshots(node, type, vmid);
  const [selected, setSelected] = useState<string | null>(null);

  if (isLoading) {
    return <Skeleton className="h-64" />;
  }

  if (isError) {
    return <EmptyState message={`Could not load snapshots: ${errorMessage(error)}`} />;
  }

  const tree = buildSnapshotTree(data ?? []);
  const rows = flattenSnapshotTree(tree);
  const realRows = rows.filter((r) => r.snapshot !== null);
  const selectedRow = realRows.find((r) => r.name === selected) ?? null;

  if (realRows.length === 0) {
    return <EmptyState message="No snapshots for this guest." />;
  }

  return (
    <div className="grid grid-cols-1 gap-3 lg:grid-cols-[1fr_320px]">
      <Panel title={`Snapshots (${realRows.length})`}>
        <ul className="flex flex-col">
          {rows.map((r) => (
            <SnapshotRow
              key={`${r.depth}-${r.name}`}
              node={r}
              selected={selectedRow?.name === r.name}
              onSelect={() => setSelected(r.name)}
            />
          ))}
        </ul>
      </Panel>
      <Panel title="Details">
        {selectedRow?.snapshot ? (
          <KeyValueGrid
            rows={[
              { label: 'Name', value: selectedRow.snapshot.name },
              { label: 'Parent', value: selectedRow.snapshot.parent ?? 'none' },
              {
                label: 'Created',
                value: selectedRow.snapshot.snaptime ? formatDateTime(selectedRow.snapshot.snaptime) : '-',
              },
              { label: 'Includes RAM', value: selectedRow.snapshot.vmstate ? 'Yes' : 'No' },
              { label: 'Description', value: selectedRow.snapshot.description ?? '-' },
            ]}
          />
        ) : (
          <EmptyState message="Select a snapshot to see details." />
        )}
      </Panel>
    </div>
  );
}
