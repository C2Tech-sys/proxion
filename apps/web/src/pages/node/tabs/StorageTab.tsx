import { Fragment, useState } from 'react';
import { Link } from '@tanstack/react-router';
import { ArrowDown, ArrowUp, ChevronDown, ChevronRight } from 'lucide-react';

import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { UsageBar } from '@/components/UsageBar';
import { EmptyState } from '@/components/EmptyState';
import { TagChip } from '@/components/TagChip';
import { Skeleton } from '@/components/ui/skeleton';
import { StorageContentBrowser } from '@/components/storage/StorageContentBrowser';
import { useClusterResources } from '@/api/hooks';
import { useStorageSort } from '@/api/prefsHooks';
import { errorMessage } from '@/api/errors';
import { parseContentTypes } from '@/lib/contentTypes';
import { formatBytes } from '@/lib/format';
import { sortStorages, type SortDir, type StorageSortKey } from '@/lib/storageSort';
import { cn } from '@/lib/utils';
import type { NodeTabProps } from '@/pages/node/tabs';

interface StorageSortHeadProps {
  label: string;
  /** The key a click on this header sorts by. */
  sortKeyName: StorageSortKey;
  /** Every saved key that makes this column the active one (the Used column shows a bar plus a
   *  fraction, so it sorts by `usage` -- but a saved `used` from the dashboard lights it too). */
  activeKeys?: readonly StorageSortKey[];
  activeKey: StorageSortKey;
  dir: SortDir;
  onSort: (key: StorageSortKey, dir: SortDir) => void;
  className?: string;
}

/** A sortable column header (the `SortHead` pattern from `TasksTable`, plus `aria-sort`). First
 *  click on a column sorts ascending; a click on the active column flips the direction. */
function StorageSortHead({
  label,
  sortKeyName,
  activeKeys = [sortKeyName],
  activeKey,
  dir,
  onSort,
  className,
}: StorageSortHeadProps) {
  const active = activeKeys.includes(activeKey);
  const ariaSort = active ? (dir === 'asc' ? 'ascending' : 'descending') : undefined;
  return (
    <TableHead aria-sort={ariaSort} className={className}>
      <button
        type="button"
        onClick={() => onSort(active ? activeKey : sortKeyName, active ? (dir === 'asc' ? 'desc' : 'asc') : 'asc')}
        className={cn('flex items-center gap-1 hover:text-foreground', className?.includes('text-right') && 'ml-auto')}
      >
        {label}
        {active && (dir === 'asc' ? <ArrowUp className="size-3" /> : <ArrowDown className="size-3" />)}
      </button>
    </TableHead>
  );
}

/** The node Storage tab: every storage on this node, expandable to its content list. The
 *  expanded row's content list is the same `StorageContentBrowser` the storage object page uses
 *  (T28), in `compact` mode -- local filter/sort state, no URL, exactly the inline-browsing
 *  behavior this tab always had. */
export function StorageTab({ node }: NodeTabProps) {
  const { data: resources, isLoading, isError, error } = useClusterResources();
  const [expanded, setExpanded] = useState<string | null>(null);
  const { sort, setSort } = useStorageSort();

  // Sorted at render time (name ascending unless a `storageSort` preference says otherwise): PVE's
  // `/cluster/resources` order is not stable between polls, and live mode replaces the whole array
  // on every push. `expanded` is keyed by storage name, so the open row follows its storage.
  const storages = sortStorages(
    (resources ?? []).filter((r) => r.type === 'storage' && r.node === node),
    sort.key,
    sort.dir,
  );
  const sortProps = {
    activeKey: sort.key,
    dir: sort.dir,
    onSort: (key: StorageSortKey, dir: SortDir) => setSort({ key, dir }),
  };

  if (isLoading) return <Skeleton className="h-64" />;
  if (isError) return <EmptyState message={`Could not load storages: ${errorMessage(error)}`} />;
  if (storages.length === 0) return <EmptyState message="No storages configured on this node." />;

  return (
    <div className="rounded-lg border border-border">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead className="w-6"></TableHead>
            <StorageSortHead label="Name" sortKeyName="name" {...sortProps} />
            <StorageSortHead label="Type" sortKeyName="type" {...sortProps} />
            <TableHead>Content</TableHead>
            <TableHead>Shared</TableHead>
            <TableHead>Enabled</TableHead>
            <StorageSortHead
              label="Used"
              sortKeyName="usage"
              activeKeys={['usage', 'used']}
              className="w-40"
              {...sortProps}
            />
            <StorageSortHead label="Avail" sortKeyName="avail" className="text-right" {...sortProps} />
          </TableRow>
        </TableHeader>
        <TableBody>
          {storages.map((s) => {
            const name = s.storage ?? '';
            const isOpen = expanded === name;
            const used = s.disk ?? 0;
            const total = s.maxdisk ?? 0;
            const avail = Math.max(0, total - used);
            const contentTypes = parseContentTypes(s.content);
            return (
              <Fragment key={s.id}>
                <TableRow className="cursor-pointer" onClick={() => setExpanded(isOpen ? null : name)}>
                  <TableCell>
                    {isOpen ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}
                  </TableCell>
                  <TableCell onClick={(e) => e.stopPropagation()}>
                    <Link
                      to="/storage/$node/$storage"
                      params={{ node, storage: name }}
                      className="text-accent hover:underline"
                    >
                      {name}
                    </Link>
                  </TableCell>
                  <TableCell>{s.plugintype ?? '-'}</TableCell>
                  <TableCell>
                    <div className="flex flex-wrap gap-1">
                      {contentTypes.map((c) => (
                        <TagChip key={c} tag={c} />
                      ))}
                    </div>
                  </TableCell>
                  <TableCell>{s.shared === 1 ? 'Yes' : 'No'}</TableCell>
                  <TableCell>{s.status === 'available' ? 'Yes' : 'No'}</TableCell>
                  <TableCell>
                    <UsageBar fraction={total ? used / total : 0} label={formatBytes(used)} />
                  </TableCell>
                  <TableCell className="text-right font-numeric">{formatBytes(avail)}</TableCell>
                </TableRow>
                {isOpen && (
                  <TableRow className="hover:bg-transparent">
                    <TableCell colSpan={8} className="bg-background p-3">
                      <StorageContentBrowser node={node} storage={name} mode="compact" />
                    </TableCell>
                  </TableRow>
                )}
              </Fragment>
            );
          })}
        </TableBody>
      </Table>
    </div>
  );
}
