import { useState } from 'react';
import { ChevronDown, Pencil, Plus, Trash2 } from 'lucide-react';

import { EmptyState } from '@/components/EmptyState';
import { UsageBar } from '@/components/UsageBar';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Skeleton } from '@/components/ui/skeleton';
import { USE_FIXTURES } from '@/api/client';
import { useAuthMe, useClusterResources } from '@/api/hooks';
import { usePathPermissions } from '@/api/datacenterPermissionHooks';
import { useStorageConfigs } from '@/api/storageConfigHooks';
import {
  STORAGE_TYPES,
  STORAGE_TYPE_LABELS,
  summarizePrune,
  type StorageConfig,
  type StorageType,
} from '@/api/storageConfig';
import type { ClusterResource } from '@/api/types';
import { AddStorageDialog } from '@/components/storageconfig/AddStorageDialog';
import { EditStorageDialog } from '@/components/storageconfig/EditStorageDialog';
import { RemoveStorageDialog } from '@/components/storageconfig/RemoveStorageDialog';
import { formatBytes } from '@/lib/format';

const READ_ONLY_REASON = 'Read-only: signed in with a service token';
const PRIVILEGE = 'Datastore.Allocate';

function isStorageType(type: string): type is StorageType {
  return (STORAGE_TYPES as readonly string[]).includes(type);
}

/** The cluster-wide status rows of one storage id (one per node it exists on). */
function usageRows(resources: ClusterResource[] | undefined, storage: string): ClusterResource[] {
  return (resources ?? []).filter((r) => r.type === 'storage' && r.storage === storage);
}

function UsageCell({ rows }: { rows: ClusterResource[] }) {
  if (rows.length === 0) return <span className="text-muted-foreground">-</span>;
  return (
    <div className="flex min-w-40 flex-col gap-1">
      {rows.map((row) => {
        const used = row.disk ?? 0;
        const total = row.maxdisk ?? 0;
        const available = row.status === 'available' && total > 0;
        return (
          <UsageBar
            key={row.id}
            fraction={available ? used / total : 0}
            label={
              available
                ? `${rows.length > 1 ? `${row.node} ` : ''}${formatBytes(used)} / ${formatBytes(total)}`
                : `${rows.length > 1 ? `${row.node} ` : ''}${row.status}`
            }
          />
        );
      })}
    </div>
  );
}

interface RowProps {
  config: StorageConfig;
  resources: ClusterResource[] | undefined;
  isSessionMode: boolean;
  onEdit: (config: StorageConfig) => void;
  onRemove: (config: StorageConfig) => void;
}

/** One storage definition; its own permission lookup, since Datastore.Allocate can be granted per
 * `/storage/<id>` (the lookup is cached per path). */
function StorageRow({ config, resources, isSessionMode, onEdit, onRemove }: RowProps) {
  const permissions = usePathPermissions(`/storage/${config.storage}`);
  const allowed = permissions.data?.can(PRIVILEGE) === true;
  const gateReason = !isSessionMode
    ? READ_ONLY_REASON
    : !allowed
      ? `You don't have ${PRIVILEGE} on this storage`
      : undefined;
  const editReason =
    gateReason ?? (isStorageType(config.type) ? undefined : 'Editing this storage type is not supported here');
  const removeReason = gateReason ?? (config.storage === 'local' ? 'The built-in "local" storage cannot be removed' : undefined);
  const retention = summarizePrune(config.prune);

  return (
    <TableRow data-testid={`storage-row-${config.storage}`}>
      <TableCell className="font-medium">{config.storage}</TableCell>
      <TableCell>{isStorageType(config.type) ? STORAGE_TYPE_LABELS[config.type] : config.type}</TableCell>
      <TableCell>
        <div className="flex flex-col gap-0.5">
          <span>{config.content.join(', ') || '-'}</span>
          {retention !== '' && <span className="text-[11px] text-muted-foreground">Retention: {retention}</span>}
        </div>
      </TableCell>
      <TableCell className="font-numeric break-all">{config.target || '-'}</TableCell>
      <TableCell>{config.shared ? 'Yes' : 'No'}</TableCell>
      <TableCell>
        {config.disabled ? <Badge variant="outline">Disabled</Badge> : 'Yes'}
      </TableCell>
      <TableCell>{config.nodes.length > 0 ? config.nodes.join(', ') : 'All'}</TableCell>
      <TableCell>
        <UsageCell rows={usageRows(resources, config.storage)} />
      </TableCell>
      <TableCell>
        <div className="flex justify-end gap-1">
          <Button
            variant="ghost"
            size="icon"
            className="size-7 shrink-0"
            aria-label={`Edit ${config.storage}`}
            disabled={editReason !== undefined}
            aria-disabled={editReason !== undefined || undefined}
            title={editReason}
            onClick={() => onEdit(config)}
          >
            <Pencil className="size-3.5" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="size-7 shrink-0 text-destructive hover:text-destructive"
            aria-label={`Remove ${config.storage}`}
            disabled={removeReason !== undefined}
            aria-disabled={removeReason !== undefined || undefined}
            title={removeReason}
            onClick={() => onRemove(config)}
          >
            <Trash2 className="size-3.5" />
          </Button>
        </div>
      </TableCell>
    </TableRow>
  );
}

/**
 * Datacenter -> Storage: every storage definition in the cluster (PVE's own panel), with the
 * per-node usage from the cluster resources, an "Add" menu by type, and Edit / Remove per row.
 * Writes are gated on a session sign-in (not a service token) and on `Datastore.Allocate`
 * (`/storage` to add, `/storage/<id>` per row); the server enforces both independently.
 */
export function StorageConfigTab() {
  const configs = useStorageConfigs();
  const resources = useClusterResources();
  const auth = useAuthMe();
  const addPermissions = usePathPermissions('/storage');
  const [addType, setAddType] = useState<StorageType | null>(null);
  const [editTarget, setEditTarget] = useState<StorageConfig | null>(null);
  const [removeTarget, setRemoveTarget] = useState<StorageConfig | null>(null);

  // Fixture/demo mode has no real session concept -- it always demonstrates the enabled state.
  const isSessionMode = USE_FIXTURES || auth.data?.mode === 'session';
  const addReason = !isSessionMode
    ? READ_ONLY_REASON
    : addPermissions.data?.can(PRIVILEGE) !== true
      ? `You don't have ${PRIVILEGE} on /storage`
      : undefined;

  const clusterNodes = (resources.data ?? [])
    .filter((r) => r.type === 'node')
    .map((r) => r.node)
    .sort((a, b) => a.localeCompare(b));

  return (
    <div data-testid="dc-storage-tab" className="flex flex-col gap-3">
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-sm font-medium">Storage</h2>
        {addReason !== undefined ? (
          <Button size="sm" disabled aria-disabled="true" title={addReason}>
            <Plus className="size-3.5" />
            Add
            <ChevronDown className="size-3.5" />
          </Button>
        ) : (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button size="sm">
                <Plus className="size-3.5" />
                Add
                <ChevronDown className="size-3.5" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              {STORAGE_TYPES.map((type) => (
                <DropdownMenuItem key={type} onSelect={() => setAddType(type)}>
                  {STORAGE_TYPE_LABELS[type]}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </div>

      {configs.isLoading ? (
        <div className="flex flex-col gap-2" aria-label="Loading storage">
          <Skeleton className="h-8 w-full" />
          <Skeleton className="h-8 w-full" />
          <Skeleton className="h-8 w-full" />
        </div>
      ) : configs.isError ? (
        <EmptyState message="The storage definitions could not be loaded." />
      ) : (configs.data ?? []).length === 0 ? (
        <EmptyState message="No storage is defined." />
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>ID</TableHead>
              <TableHead>Type</TableHead>
              <TableHead>Content</TableHead>
              <TableHead>Path/Target</TableHead>
              <TableHead>Shared</TableHead>
              <TableHead>Enabled</TableHead>
              <TableHead>Nodes</TableHead>
              <TableHead>Usage</TableHead>
              <TableHead>
                <span className="sr-only">Actions</span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {(configs.data ?? []).map((config) => (
              <StorageRow
                key={config.storage}
                config={config}
                resources={resources.data}
                isSessionMode={isSessionMode}
                onEdit={setEditTarget}
                onRemove={setRemoveTarget}
              />
            ))}
          </TableBody>
        </Table>
      )}

      {addType !== null && (
        <AddStorageDialog
          open
          onOpenChange={(open) => !open && setAddType(null)}
          type={addType}
          clusterNodes={clusterNodes}
        />
      )}
      {editTarget !== null && (
        <EditStorageDialog
          open
          onOpenChange={(open) => !open && setEditTarget(null)}
          config={editTarget}
          clusterNodes={clusterNodes}
        />
      )}
      {removeTarget !== null && (
        <RemoveStorageDialog open onOpenChange={(open) => !open && setRemoveTarget(null)} storage={removeTarget.storage} />
      )}
    </div>
  );
}

export default StorageConfigTab;
