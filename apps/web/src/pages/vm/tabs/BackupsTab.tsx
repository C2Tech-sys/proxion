import { useQueries } from '@tanstack/react-query';
import { ShieldCheck } from 'lucide-react';

import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Badge } from '@/components/ui/badge';
import { EmptyState } from '@/components/EmptyState';
import { Skeleton } from '@/components/ui/skeleton';
import { useClusterResources } from '@/api/hooks';
import { api } from '@/api/client';
import { errorMessage } from '@/api/errors';
import { formatBytes, formatDateTime } from '@/lib/format';
import type { VmTabProps } from '@/pages/vm/tabs';
import type { BackupContentItem } from '@/api/types';

/** Storage name from a `storage:path` volid, e.g. `tank-backups:backup/vzdump-...` -> `tank-backups`. */
function storageOf(volid: string): string {
  return volid.split(':')[0] ?? '';
}

const VERIFICATION_VARIANT: Record<string, 'default' | 'destructive' | 'secondary'> = {
  ok: 'default',
  failed: 'destructive',
};

/** The VM/CT Backups tab: every backup volume for this guest, across every backup-capable storage. */
export function BackupsTab({ node, vmid }: VmTabProps) {
  const {
    data: resources,
    isLoading: resourcesLoading,
    isError: resourcesError,
    error: resourcesErrorObj,
  } = useClusterResources();
  const backupStorages = (resources ?? [])
    .filter((r) => r.type === 'storage' && r.node === node && r.content?.includes('backup'))
    .map((r) => r.storage)
    .filter((s): s is string => Boolean(s));

  const results = useQueries({
    queries: backupStorages.map((storage) => ({
      queryKey: ['storage-content', node, storage],
      queryFn: () => api.getStorageContent(node, storage),
    })),
  });

  if (resourcesLoading || results.some((r) => r.isLoading)) {
    return <Skeleton className="h-48" />;
  }

  if (resourcesError) {
    return <EmptyState message={`Could not load storages: ${errorMessage(resourcesErrorObj)}`} />;
  }

  const firstFailedResult = results.find((r) => r.isError);
  if (firstFailedResult) {
    return <EmptyState message={`Could not load backups: ${errorMessage(firstFailedResult.error)}`} />;
  }

  const items = results
    .flatMap((r) => (r.data ?? []) as BackupContentItem[])
    .filter((item) => item.content === 'backup' && item.vmid === vmid)
    .sort((a, b) => (b.ctime ?? 0) - (a.ctime ?? 0));

  if (items.length === 0) {
    return <EmptyState message="No backups for this guest." />;
  }

  return (
    <div className="rounded-lg border border-border">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Volume ID</TableHead>
            <TableHead>Storage</TableHead>
            <TableHead>Format</TableHead>
            <TableHead className="text-right">Size</TableHead>
            <TableHead>Created</TableHead>
            <TableHead>Notes</TableHead>
            <TableHead>Protected</TableHead>
            <TableHead>Verification</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {items.map((item) => (
            <TableRow key={item.volid}>
              <TableCell className="max-w-xs truncate" title={item.volid} data-testid="backup-volume-id">
                {item.volid}
              </TableCell>
              <TableCell>{storageOf(item.volid)}</TableCell>
              <TableCell>{item.format ?? '-'}</TableCell>
              <TableCell className="text-right font-numeric">{formatBytes(item.size)}</TableCell>
              <TableCell className="font-numeric">{item.ctime ? formatDateTime(item.ctime) : '-'}</TableCell>
              <TableCell className="max-w-xs truncate text-muted-foreground" title={item.notes}>
                {item.notes ?? '-'}
              </TableCell>
              <TableCell>{item.protected ? <ShieldCheck className="size-3.5 text-status-running" /> : '-'}</TableCell>
              <TableCell>
                {item.verification ? (
                  <Badge variant={VERIFICATION_VARIANT[item.verification.state] ?? 'secondary'}>
                    {item.verification.state}
                  </Badge>
                ) : (
                  '-'
                )}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
