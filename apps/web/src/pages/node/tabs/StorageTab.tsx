import { Fragment, useState } from 'react';
import { Link } from '@tanstack/react-router';
import { ChevronDown, ChevronRight } from 'lucide-react';

import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { UsageBar } from '@/components/UsageBar';
import { EmptyState } from '@/components/EmptyState';
import { TagChip } from '@/components/TagChip';
import { Skeleton } from '@/components/ui/skeleton';
import { StorageContentBrowser } from '@/components/storage/StorageContentBrowser';
import { useClusterResources } from '@/api/hooks';
import { errorMessage } from '@/api/errors';
import { formatBytes } from '@/lib/format';
import type { NodeTabProps } from '@/pages/node/tabs';

/** The node Storage tab: every storage on this node, expandable to its content list. The
 *  expanded row's content list is the same `StorageContentBrowser` the storage object page uses
 *  (T28), in `compact` mode -- local filter/sort state, no URL, exactly the inline-browsing
 *  behavior this tab always had. */
export function StorageTab({ node }: NodeTabProps) {
  const { data: resources, isLoading, isError, error } = useClusterResources();
  const [expanded, setExpanded] = useState<string | null>(null);

  const storages = (resources ?? []).filter((r) => r.type === 'storage' && r.node === node);

  if (isLoading) return <Skeleton className="h-64" />;
  if (isError) return <EmptyState message={`Could not load storages: ${errorMessage(error)}`} />;
  if (storages.length === 0) return <EmptyState message="No storages configured on this node." />;

  return (
    <div className="rounded-lg border border-border">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead className="w-6"></TableHead>
            <TableHead>Name</TableHead>
            <TableHead>Type</TableHead>
            <TableHead>Content</TableHead>
            <TableHead>Shared</TableHead>
            <TableHead>Enabled</TableHead>
            <TableHead className="w-40">Used</TableHead>
            <TableHead className="text-right">Avail</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {storages.map((s) => {
            const name = s.storage ?? '';
            const isOpen = expanded === name;
            const used = s.disk ?? 0;
            const total = s.maxdisk ?? 0;
            const avail = Math.max(0, total - used);
            const contentTypes = (s.content ?? '').split(',').filter(Boolean);
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
