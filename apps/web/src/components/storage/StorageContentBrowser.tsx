import { useMemo, useState, type ReactNode } from 'react';
import { Link } from '@tanstack/react-router';
import { ArrowDown, ArrowUp, ShieldCheck } from 'lucide-react';

import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { EmptyState } from '@/components/EmptyState';
import { Skeleton } from '@/components/ui/skeleton';
import { useClusterResources, useStorageContent } from '@/api/hooks';
import { errorMessage } from '@/api/errors';
import { formatBytes, formatDateTime } from '@/lib/format';
import { cn } from '@/lib/utils';
import {
  buildVmidIndex,
  CONTENT_TYPE_LABELS,
  CONTENT_TYPE_ORDER,
  contentTypeCounts,
  DEFAULT_STORAGE_BROWSER_STATE,
  selectStorageContent,
  stripStoragePrefix,
  type StorageBrowserState,
  type StorageContentType,
  type StorageSortKey,
} from '@/lib/storageList';
import type { BackupContentItem } from '@/api/types';

const VERIFICATION_VARIANT: Record<string, 'default' | 'destructive' | 'secondary'> = {
  ok: 'default',
  failed: 'destructive',
};

function ChipButton({ active, onClick, children }: { active: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={cn(
        'rounded-md border border-border px-2 py-1 text-xs whitespace-nowrap outline-none',
        active
          ? 'border-accent/40 bg-accent/20 text-foreground'
          : 'text-muted-foreground hover:bg-accent/10 hover:text-foreground',
      )}
    >
      {children}
    </button>
  );
}

interface SortableHeadProps {
  label: string;
  sortKey: StorageSortKey;
  activeKey: StorageSortKey;
  dir: 'asc' | 'desc';
  onToggle: (key: StorageSortKey) => void;
  className?: string;
}

function SortableHead({ label, sortKey, activeKey, dir, onToggle, className }: SortableHeadProps) {
  const active = activeKey === sortKey;
  return (
    <TableHead className={className}>
      <button
        type="button"
        onClick={() => onToggle(sortKey)}
        className="flex items-center gap-1 outline-none hover:text-foreground"
      >
        {label}
        {active && (dir === 'asc' ? <ArrowUp className="size-3" /> : <ArrowDown className="size-3" />)}
      </button>
    </TableHead>
  );
}

export interface StorageContentBrowserProps {
  node: string;
  storage: string;
  /** `page`: state is URL-backed, driven by `state`/`onStateChange` (the route's own search).
   *  `compact`: state is local to this component instance (no URL) -- used inline in the node
   *  Storage tab's expandable row, where a filter typed while browsing one storage shouldn't
   *  survive collapsing/re-expanding it, let alone show up in the URL. */
  mode: 'page' | 'compact';
  state?: StorageBrowserState;
  onStateChange?: (next: StorageBrowserState) => void;
}

/**
 * The content browser shared by the storage object page (`page` mode, T28) and the node Storage
 * tab's expandable row (`compact` mode) -- one implementation of the type-chip strip, search box
 * and sortable table, so the two call sites can never drift.
 */
export function StorageContentBrowser({ node, storage, mode, state, onStateChange }: StorageContentBrowserProps) {
  const { data: items, isLoading, isError, error } = useStorageContent(node, storage);
  const { data: resources } = useClusterResources();
  const [localState, setLocalState] = useState<StorageBrowserState>(DEFAULT_STORAGE_BROWSER_STATE);

  const current = mode === 'page' && state ? state : localState;

  function update(partial: Partial<StorageBrowserState>) {
    const next = { ...current, ...partial };
    if (mode === 'page' && onStateChange) onStateChange(next);
    else setLocalState(next);
  }

  function toggleSort(key: StorageSortKey) {
    const nextDir: 'asc' | 'desc' = current.sort === key ? (current.dir === 'asc' ? 'desc' : 'asc') : 'asc';
    update({ sort: key, dir: nextDir });
  }

  const vmidIndex = useMemo(() => buildVmidIndex(resources ?? []), [resources]);
  const counts = useMemo(() => contentTypeCounts(items ?? []), [items]);
  const totalCount = (items ?? []).length;
  const filtered = useMemo(
    () => selectStorageContent(items ?? [], { type: current.type, q: current.q }, current.sort, current.dir),
    [items, current.type, current.q, current.sort, current.dir],
  );

  if (isLoading) return <Skeleton className="h-48" />;
  if (isError) return <EmptyState message={`Could not load storage content: ${errorMessage(error)}`} />;

  const availableTypes = CONTENT_TYPE_ORDER.filter((t) => (counts[t] ?? 0) > 0);
  // The Protected/Verification columns (same rendering as the VM Backups tab) only make sense
  // once the view is narrowed to backups -- showing them for a mixed "All" view would mean a
  // column of "-" for every non-backup row.
  const showBackupColumns = current.type === 'backup';

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex flex-wrap items-center gap-1" role="group" aria-label="Content type">
          <ChipButton active={current.type === 'all'} onClick={() => update({ type: 'all' })}>
            All ({totalCount})
          </ChipButton>
          {availableTypes.map((t) => (
            <ChipButton key={t} active={current.type === t} onClick={() => update({ type: t })}>
              {CONTENT_TYPE_LABELS[t]} ({counts[t]})
            </ChipButton>
          ))}
        </div>
        <Input
          value={current.q}
          onChange={(e) => update({ q: e.target.value })}
          placeholder="Search by volume ID or notes"
          aria-label="Search storage content"
          className="h-8 w-64 text-xs"
        />
      </div>

      {totalCount === 0 ? (
        <EmptyState message="This storage has no content." />
      ) : filtered.length === 0 ? (
        <EmptyState message="No content matches." />
      ) : (
        <div className="overflow-x-auto rounded-lg border border-border">
          <Table>
            <TableHeader>
              <TableRow>
                <SortableHead label="Name" sortKey="name" activeKey={current.sort} dir={current.dir} onToggle={toggleSort} />
                <TableHead>Type</TableHead>
                <TableHead>Format</TableHead>
                <SortableHead
                  label="Size"
                  sortKey="size"
                  activeKey={current.sort}
                  dir={current.dir}
                  onToggle={toggleSort}
                  className="text-right"
                />
                <SortableHead
                  label="Owner"
                  sortKey="vmid"
                  activeKey={current.sort}
                  dir={current.dir}
                  onToggle={toggleSort}
                  className="text-right"
                />
                <SortableHead label="Created" sortKey="ctime" activeKey={current.sort} dir={current.dir} onToggle={toggleSort} />
                {showBackupColumns && (
                  <>
                    <TableHead>Protected</TableHead>
                    <TableHead>Verification</TableHead>
                  </>
                )}
                <TableHead>Notes</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {filtered.map((item) => {
                const owner = item.vmid !== undefined ? vmidIndex.get(item.vmid) : undefined;
                const backup = item as BackupContentItem;
                const typeLabel = CONTENT_TYPE_LABELS[item.content as StorageContentType] ?? item.content;
                return (
                  <TableRow key={item.volid}>
                    <TableCell className="max-w-xs truncate" title={item.volid} data-testid="storage-volume-id">
                      {stripStoragePrefix(item.volid)}
                    </TableCell>
                    <TableCell>{typeLabel}</TableCell>
                    <TableCell>{item.format ?? '-'}</TableCell>
                    <TableCell className="text-right font-numeric">{formatBytes(item.size)}</TableCell>
                    <TableCell className="text-right font-numeric">
                      {item.vmid === undefined ? (
                        '-'
                      ) : owner ? (
                        <Link
                          to="/vm/$node/$type/$vmid"
                          params={{ node: owner.node, type: owner.type, vmid: String(item.vmid) }}
                          search={{ tab: 'summary' }}
                          className="text-accent hover:underline"
                        >
                          {item.vmid}
                        </Link>
                      ) : (
                        item.vmid
                      )}
                    </TableCell>
                    <TableCell className="font-numeric">{item.ctime ? formatDateTime(item.ctime) : '-'}</TableCell>
                    {showBackupColumns && (
                      <>
                        <TableCell>
                          {backup.protected ? <ShieldCheck className="size-3.5 text-status-running" /> : '-'}
                        </TableCell>
                        <TableCell>
                          {backup.verification ? (
                            <Badge variant={VERIFICATION_VARIANT[backup.verification.state] ?? 'secondary'}>
                              {backup.verification.state}
                            </Badge>
                          ) : (
                            '-'
                          )}
                        </TableCell>
                      </>
                    )}
                    <TableCell className="max-w-xs truncate text-muted-foreground" title={item.notes}>
                      {item.notes ?? '-'}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  );
}
