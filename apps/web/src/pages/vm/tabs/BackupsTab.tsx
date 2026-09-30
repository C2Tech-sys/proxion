import { useState } from 'react';
import { useQueries } from '@tanstack/react-query';
import { Archive, MoreHorizontal, RotateCcw, ShieldCheck, Trash2 } from 'lucide-react';

import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/EmptyState';
import { Skeleton } from '@/components/ui/skeleton';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { BackupNowDialog } from '@/components/actions/BackupNowDialog';
import { RestoreBackupDialog } from '@/components/actions/RestoreBackupDialog';
import { DeleteVolumeDialog } from '@/components/storage/DeleteVolumeDialog';
import { useClusterResources, useAuthMe } from '@/api/hooks';
import { usePermissions, type GuestPermissions } from '@/api/actionHooks';
import { api, USE_FIXTURES } from '@/api/client';
import { errorMessage } from '@/api/errors';
import { formatBytes, formatDateTime } from '@/lib/format';
import type { VmTabProps } from '@/pages/vm/tabs';
import type { BackupContentItem, StorageContentItem } from '@/api/types';

/** Storage name from a `storage:path` volid, e.g. `tank-backups:backup/vzdump-...` -> `tank-backups`. */
function storageOf(volid: string): string {
  return volid.split(':')[0] ?? '';
}

const VERIFICATION_VARIANT: Record<string, 'default' | 'destructive' | 'secondary'> = {
  ok: 'default',
  failed: 'destructive',
};

/** Real PVE nests a permissions result under the requested path (matches
 * `actionHooks.ts`'s own private `scopedPermissions`, duplicated here in miniature since this is
 * the only place in the Backups tab that needs a *per-storage* permission set for several storages
 * at once -- `useStoragePermissions` itself is a single-storage hook and can't be called in a
 * loop). */
function scopedStoragePermissions(envelopeData: unknown, storagePath: string): Record<string, unknown> {
  if (!envelopeData || typeof envelopeData !== 'object') return {};
  const record = envelopeData as Record<string, unknown>;
  const scoped = record[storagePath];
  if (scoped && typeof scoped === 'object') return scoped as Record<string, unknown>;
  return record;
}

const ALL_STORAGE_PRIVILEGES: GuestPermissions = { can: () => true };

/** The VM/CT Backups tab: every backup volume for this guest, across every backup-capable storage
 * on this node, plus (session sign-in only) "Backup now" and per-row Restore/Delete actions
 * (T41). */
export function BackupsTab({ node, type, vmid }: VmTabProps) {
  const {
    data: resources,
    isLoading: resourcesLoading,
    isError: resourcesError,
    error: resourcesErrorObj,
  } = useClusterResources();
  const auth = useAuthMe();
  const permissions = usePermissions(vmid);

  const backupStorages = (resources ?? [])
    .filter((r) => r.type === 'storage' && r.node === node && r.content?.includes('backup'))
    .map((r) => r.storage)
    .filter((s): s is string => Boolean(s));

  const guestName =
    (resources ?? []).find((r) => r.type === type && r.node === node && r.vmid === vmid)?.name ?? `VMID ${vmid}`;

  const results = useQueries({
    queries: backupStorages.map((storage) => ({
      queryKey: ['storage-content', node, storage],
      queryFn: () => api.getStorageContent(node, storage),
    })),
  });

  // One permission check per backup-capable storage (`Datastore.Allocate` and
  // `Datastore.AllocateSpace` on `/storage/{storage}`) -- feeds the per-row Delete gate below,
  // mirroring the server's own `hasAllocateOrBackupPrivilege` (`backupRoutes.ts`/
  // `storageRoutes.ts`). Fixture mode never makes the request -- every privilege reads as granted,
  // same convention `usePermissions`/`useStoragePermissions` use.
  const storagePermResults = useQueries({
    queries: backupStorages.map((storage) => ({
      queryKey: ['storage-permissions', storage],
      queryFn: async (): Promise<GuestPermissions> => {
        const storagePath = `/storage/${storage}`;
        const res = await fetch(`/api/pve/access/permissions?path=${encodeURIComponent(storagePath)}`);
        if (!res.ok) throw new Error(`Failed to load permissions for storage ${storage}: ${res.status}`);
        const envelope = (await res.json()) as { data?: unknown };
        const scoped = scopedStoragePermissions(envelope.data, storagePath);
        return { can: (privilege: string) => Boolean(scoped[privilege]) };
      },
      enabled: !USE_FIXTURES,
      staleTime: 5 * 60 * 1000,
      ...(USE_FIXTURES ? { initialData: ALL_STORAGE_PRIVILEGES } : {}),
    })),
  });
  const storagePermsByStorage = new Map<string, GuestPermissions>(
    backupStorages.map((storage, i) => [storage, storagePermResults[i]?.data ?? { can: () => false }]),
  );

  const [backupOpen, setBackupOpen] = useState(false);
  const [restoreItem, setRestoreItem] = useState<BackupContentItem | null>(null);
  const [deleteItem, setDeleteItem] = useState<StorageContentItem | null>(null);

  // Fixture/demo mode has no real session concept -- it always demonstrates the enabled state,
  // same convention `SnapshotsTab`'s own gating uses.
  const isSessionMode = USE_FIXTURES || auth.data?.mode === 'session';
  const hasBackupPriv = permissions.data?.can('VM.Backup') === true;
  const hasBackupCapableStorage = backupStorages.length > 0;
  const canBackupNow = isSessionMode && hasBackupPriv && hasBackupCapableStorage;
  const backupDisabledReason = !isSessionMode
    ? 'Read-only: signed in with a service token'
    : !hasBackupPriv
      ? "You don't have VM.Backup on this guest"
      : !hasBackupCapableStorage
        ? 'No backup-capable storage on this node'
        : undefined;

  const restoreDisabledReason = !isSessionMode ? 'Read-only: signed in with a service token' : undefined;

  function canDeleteRow(storage: string): boolean {
    const storagePerm = storagePermsByStorage.get(storage);
    if (!storagePerm) return false;
    return storagePerm.can('Datastore.Allocate') || (storagePerm.can('Datastore.AllocateSpace') && hasBackupPriv);
  }

  const backupNowButton = canBackupNow ? (
    <Button size="sm" onClick={() => setBackupOpen(true)}>
      <Archive /> Backup now
    </Button>
  ) : (
    <Tooltip>
      <TooltipTrigger asChild>
        <span tabIndex={0} className="inline-flex rounded-md focus-visible:ring-[3px] focus-visible:ring-ring/50">
          <Button size="sm" disabled aria-disabled="true" tabIndex={-1} className="pointer-events-none">
            <Archive /> Backup now
          </Button>
        </span>
      </TooltipTrigger>
      <TooltipContent>{backupDisabledReason}</TooltipContent>
    </Tooltip>
  );

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

  return (
    <>
      {items.length === 0 ? (
        <div className="flex flex-col items-start gap-3">
          <EmptyState message="No backups for this guest." />
          {backupNowButton}
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          <div className="flex justify-end">{backupNowButton}</div>
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
                  <TableHead className="w-10" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {items.map((item) => {
                  const storage = storageOf(item.volid);
                  const canDelete = canDeleteRow(storage);
                  const deleteDisabledReason = item.protected
                    ? 'Protected backup'
                    : !isSessionMode
                      ? 'Read-only: signed in with a service token'
                      : !canDelete
                        ? "You don't have permission to delete backups on this storage"
                        : undefined;

                  return (
                    <TableRow key={item.volid}>
                      <TableCell className="max-w-xs truncate" title={item.volid} data-testid="backup-volume-id">
                        {item.volid}
                      </TableCell>
                      <TableCell>{storage}</TableCell>
                      <TableCell>{item.format ?? '-'}</TableCell>
                      <TableCell className="text-right font-numeric">{formatBytes(item.size)}</TableCell>
                      <TableCell className="font-numeric">{item.ctime ? formatDateTime(item.ctime) : '-'}</TableCell>
                      <TableCell className="max-w-xs truncate text-muted-foreground" title={item.notes}>
                        {item.notes ?? '-'}
                      </TableCell>
                      <TableCell>
                        {item.protected ? <ShieldCheck className="size-3.5 text-status-running" /> : '-'}
                      </TableCell>
                      <TableCell>
                        {item.verification ? (
                          <Badge variant={VERIFICATION_VARIANT[item.verification.state] ?? 'secondary'}>
                            {item.verification.state}
                          </Badge>
                        ) : (
                          '-'
                        )}
                      </TableCell>
                      <TableCell>
                        <DropdownMenu>
                          <DropdownMenuTrigger asChild>
                            <Button
                              variant="ghost"
                              size="icon"
                              className="size-7 shrink-0"
                              aria-label={`Actions for ${item.volid}`}
                            >
                              <MoreHorizontal className="size-4" />
                            </Button>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="end">
                            <DropdownMenuItem
                              disabled={!isSessionMode}
                              title={restoreDisabledReason}
                              onSelect={() => setRestoreItem(item)}
                            >
                              <RotateCcw /> Restore…
                            </DropdownMenuItem>
                            <DropdownMenuItem
                              variant="destructive"
                              disabled={Boolean(item.protected) || !isSessionMode || !canDelete}
                              title={deleteDisabledReason}
                              onSelect={() => setDeleteItem(item)}
                            >
                              <Trash2 /> Delete…
                            </DropdownMenuItem>
                          </DropdownMenuContent>
                        </DropdownMenu>
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>
        </div>
      )}

      <BackupNowDialog
        key={backupOpen ? 'open' : 'closed'}
        open={backupOpen}
        onOpenChange={setBackupOpen}
        node={node}
        type={type}
        vmid={vmid}
        name={guestName}
        storages={backupStorages}
      />

      {restoreItem && (
        <RestoreBackupDialog
          key={restoreItem.volid}
          open
          onOpenChange={(open) => {
            if (!open) setRestoreItem(null);
          }}
          node={node}
          type={type}
          vmid={vmid}
          item={restoreItem}
        />
      )}

      <DeleteVolumeDialog
        node={node}
        storage={deleteItem ? storageOf(deleteItem.volid) : ''}
        item={deleteItem}
        onOpenChange={(open) => {
          if (!open) setDeleteItem(null);
        }}
      />
    </>
  );
}
