import { useState } from 'react';
import { Camera, CirclePlay, Loader2, MoreHorizontal, RotateCcw, Trash2 } from 'lucide-react';

import { Panel } from '@/components/Panel';
import { KeyValueGrid } from '@/components/KeyValueGrid';
import { EmptyState } from '@/components/EmptyState';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { SnapshotCreateDialog, SnapshotDeleteDialog, SnapshotRollbackDialog } from '@/components/actions/SnapshotDialogs';
import { useAuthMe, useSnapshots, useVmStatus } from '@/api/hooks';
import { usePermissions } from '@/api/actionHooks';
import { USE_FIXTURES } from '@/api/client';
import { errorMessage } from '@/api/errors';
import { buildSnapshotTree, flattenSnapshotTree, type SnapshotTreeNode } from '@/lib/snapshots';
import { formatDateTime } from '@/lib/format';
import { cn } from '@/lib/utils';
import type { VmTabProps } from '@/pages/vm/tabs';

function SnapshotRow({
  node,
  selected,
  onSelect,
  canRollback,
  canDelete,
  isPending,
  onRollback,
  onDelete,
}: {
  node: SnapshotTreeNode;
  selected: boolean;
  onSelect: () => void;
  canRollback: boolean;
  canDelete: boolean;
  isPending: boolean;
  onRollback: () => void;
  onDelete: () => void;
}) {
  const isNow = node.snapshot === null;
  return (
    <li className="flex items-center gap-1 pr-1">
      <button
        type="button"
        onClick={isNow ? undefined : onSelect}
        disabled={isNow}
        style={{ paddingLeft: `${node.depth * 20}px` }}
        className={cn(
          'flex min-w-0 flex-1 items-center gap-2 rounded-sm py-1.5 pr-2 text-left text-sm transition-colors',
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
      {!isNow &&
        (isPending ? (
          <Loader2 className="size-4 shrink-0 animate-spin text-muted-foreground" aria-label="Working…" />
        ) : (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon" className="size-7 shrink-0" aria-label={`Actions for ${node.name}`}>
                <MoreHorizontal className="size-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem
                disabled={!canRollback}
                title={canRollback ? undefined : "You don't have VM.Snapshot.Rollback on this guest"}
                onSelect={onRollback}
              >
                <RotateCcw /> Roll back…
              </DropdownMenuItem>
              <DropdownMenuItem
                variant="destructive"
                disabled={!canDelete}
                title={canDelete ? undefined : "You don't have VM.Snapshot on this guest"}
                onSelect={onDelete}
              >
                <Trash2 /> Delete…
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        ))}
    </li>
  );
}

/** The VM/CT Snapshots tab: parent-chain tree (ending in "NOW") with a details side panel, a
 * "Take snapshot" button gated on a signed-in session + `VM.Snapshot`, and a per-row "…" menu
 * (Roll back needs `VM.Snapshot.Rollback`; Delete needs `VM.Snapshot`) -- the "NOW" sentinel row
 * gets no menu at all. */
export function SnapshotsTab({ node, type, vmid }: VmTabProps) {
  const { data, isLoading, isError, error } = useSnapshots(node, type, vmid);
  const auth = useAuthMe();
  const permissions = usePermissions(vmid);
  const { data: status } = useVmStatus(node, type, vmid);
  const [selected, setSelected] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [rollbackTarget, setRollbackTarget] = useState<SnapshotTreeNode | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<SnapshotTreeNode | null>(null);
  const [pendingSnapname, setPendingSnapname] = useState<string | null>(null);

  // Fixture/demo mode has no real session concept -- it always demonstrates the enabled state,
  // same convention `ObjectHeader`'s guest quick actions use.
  const isSessionMode = USE_FIXTURES || auth.data?.mode === 'session';
  const hasSnapshot = permissions.data?.can('VM.Snapshot') === true;
  const hasRollback = permissions.data?.can('VM.Snapshot.Rollback') === true;
  const canCreate = isSessionMode && hasSnapshot;
  const createDisabledReason = !isSessionMode
    ? 'Read-only: signed in with a service token'
    : !hasSnapshot
      ? "You don't have VM.Snapshot on this guest"
      : undefined;

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

  const takeSnapshotButton = canCreate ? (
    <Button size="sm" onClick={() => setCreateOpen(true)}>
      <Camera /> Take snapshot
    </Button>
  ) : (
    <Tooltip>
      <TooltipTrigger asChild>
        <span tabIndex={0} className="inline-flex rounded-md focus-visible:ring-[3px] focus-visible:ring-ring/50">
          <Button size="sm" disabled aria-disabled="true" tabIndex={-1} className="pointer-events-none">
            <Camera /> Take snapshot
          </Button>
        </span>
      </TooltipTrigger>
      <TooltipContent>{createDisabledReason}</TooltipContent>
    </Tooltip>
  );

  return (
    <>
      {realRows.length === 0 ? (
        <div className="flex flex-col items-start gap-3">
          <EmptyState message="No snapshots for this guest." />
          {takeSnapshotButton}
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-3 lg:grid-cols-[1fr_320px]">
          <Panel title={`Snapshots (${realRows.length})`} action={takeSnapshotButton}>
            <ul className="flex flex-col">
              {rows.map((r) => (
                <SnapshotRow
                  key={`${r.depth}-${r.name}`}
                  node={r}
                  selected={selectedRow?.name === r.name}
                  onSelect={() => setSelected(r.name)}
                  canRollback={isSessionMode && hasRollback}
                  canDelete={isSessionMode && hasSnapshot}
                  isPending={r.snapshot !== null && pendingSnapname === r.snapshot.name}
                  onRollback={() => setRollbackTarget(r)}
                  onDelete={() => setDeleteTarget(r)}
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
      )}

      <SnapshotCreateDialog
        key={createOpen ? 'open' : 'closed'}
        open={createOpen}
        onOpenChange={setCreateOpen}
        node={node}
        type={type}
        vmid={vmid}
        canIncludeRam={type === 'qemu' && status?.status === 'running'}
      />

      {rollbackTarget?.snapshot && (
        <SnapshotRollbackDialog
          key={rollbackTarget.name}
          open
          onOpenChange={(open) => {
            if (!open) setRollbackTarget(null);
          }}
          node={node}
          type={type}
          vmid={vmid}
          guestName={status?.name ?? `VMID ${vmid}`}
          snapname={rollbackTarget.snapshot.name}
          snaptime={rollbackTarget.snapshot.snaptime}
          onPendingChange={(pending) => setPendingSnapname(pending ? rollbackTarget.snapshot!.name : null)}
        />
      )}

      {deleteTarget?.snapshot && (
        <SnapshotDeleteDialog
          key={deleteTarget.name}
          open
          onOpenChange={(open) => {
            if (!open) setDeleteTarget(null);
          }}
          node={node}
          type={type}
          vmid={vmid}
          snapname={deleteTarget.snapshot.name}
          onPendingChange={(pending) => setPendingSnapname(pending ? deleteTarget.snapshot!.name : null)}
        />
      )}
    </>
  );
}
