import { Fragment, useMemo, useState } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';

import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Input } from '@/components/ui/input';
import { UsageBar } from '@/components/UsageBar';
import { EmptyState } from '@/components/EmptyState';
import { TagChip } from '@/components/TagChip';
import { Skeleton } from '@/components/ui/skeleton';
import { useClusterResources, useStorageContent } from '@/api/hooks';
import { errorMessage } from '@/api/errors';
import { formatBytes, formatDateTime } from '@/lib/format';
import type { NodeTabProps } from '@/pages/node/tabs';
import type { StorageContentItem } from '@/api/types';

function StorageContentPanel({ node, storage }: { node: string; storage: string }) {
  const { data: items, isLoading, isError, error } = useStorageContent(node, storage);
  const [filter, setFilter] = useState('');

  const grouped = useMemo(() => {
    const list = items ?? [];
    const needle = filter.trim().toLowerCase();
    const filtered = needle ? list.filter((item) => item.volid.toLowerCase().includes(needle)) : list;
    const groups = new Map<string, StorageContentItem[]>();
    for (const item of filtered) {
      const key = item.content;
      const bucket = groups.get(key) ?? [];
      bucket.push(item);
      groups.set(key, bucket);
    }
    return [...groups.entries()].sort(([a], [b]) => a.localeCompare(b));
  }, [items, filter]);

  if (isLoading) return <Skeleton className="h-32" />;
  if (isError) return <EmptyState message={`Could not load storage content: ${errorMessage(error)}`} />;
  if (!items || items.length === 0) return <EmptyState message="No content on this storage." />;

  return (
    <div className="flex flex-col gap-3 p-3">
      <Input
        placeholder="Filter by volume ID..."
        value={filter}
        onChange={(e) => setFilter(e.target.value)}
        className="h-8 max-w-sm text-xs"
      />
      {grouped.length === 0 ? (
        <EmptyState message="No content matches the filter." />
      ) : (
        grouped.map(([content, rows]) => (
          <div key={content} className="flex flex-col gap-1">
            <div className="text-xs font-medium tracking-[0.08em] text-muted-foreground uppercase">
              {content} ({rows.length})
            </div>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Volume ID</TableHead>
                  <TableHead>Format</TableHead>
                  <TableHead className="text-right">Size</TableHead>
                  <TableHead className="text-right">VMID</TableHead>
                  <TableHead>Created</TableHead>
                  <TableHead>Notes</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((item) => (
                  <TableRow key={item.volid}>
                    <TableCell className="max-w-xs truncate" title={item.volid} data-testid="storage-volume-id">
                      {item.volid}
                    </TableCell>
                    <TableCell>{item.format ?? '-'}</TableCell>
                    <TableCell className="text-right font-numeric">{formatBytes(item.size)}</TableCell>
                    <TableCell className="text-right font-numeric">{item.vmid ?? '-'}</TableCell>
                    <TableCell className="font-numeric">{item.ctime ? formatDateTime(item.ctime) : '-'}</TableCell>
                    <TableCell className="max-w-xs truncate text-muted-foreground" title={item.notes}>
                      {item.notes ?? '-'}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        ))
      )}
    </div>
  );
}

/** The node Storage tab: every storage on this node, expandable to its content list. */
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
                  <TableCell>{name}</TableCell>
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
                    <TableCell colSpan={8} className="bg-background p-0">
                      <StorageContentPanel node={node} storage={name} />
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
