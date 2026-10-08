import { useState } from 'react';
import { Pencil, Plus, Trash2, Users } from 'lucide-react';

import { EmptyState } from '@/components/EmptyState';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { USE_FIXTURES } from '@/api/client';
import { useAuthMe } from '@/api/hooks';
import { usePathPermissions } from '@/api/datacenterPermissionHooks';
import { usePools } from '@/api/poolsHooks';
import type { Pool } from '@/api/pools';
import { AddPoolDialog, DeletePoolDialog, EditPoolCommentDialog } from '@/components/pools/PoolDialogs';
import { PoolMembersSheet } from '@/components/pools/PoolMembersSheet';

const READ_ONLY_REASON = 'Read-only: signed in with a service token';
const PRIVILEGE = 'Pool.Allocate';

interface RowProps {
  pool: Pool;
  isSessionMode: boolean;
  onEdit: (pool: Pool) => void;
  onMembers: (pool: Pool) => void;
  onDelete: (pool: Pool) => void;
}

/** One pool; its own permission lookup, since Pool.Allocate can be granted per `/pool/<id>`. */
function PoolRow({ pool, isSessionMode, onEdit, onMembers, onDelete }: RowProps) {
  const permissions = usePathPermissions(`/pool/${pool.poolid}`);
  const gateReason = !isSessionMode
    ? READ_ONLY_REASON
    : permissions.data?.can(PRIVILEGE) !== true
      ? `You don't have ${PRIVILEGE} on this pool`
      : undefined;
  const deleteReason = gateReason ?? (pool.members.length > 0 ? 'Remove all members first' : undefined);

  return (
    <TableRow data-testid={`pool-row-${pool.poolid}`}>
      <TableCell className="font-medium">{pool.poolid}</TableCell>
      <TableCell>{pool.comment ?? ''}</TableCell>
      <TableCell className="font-numeric">{pool.members.length}</TableCell>
      <TableCell>
        <div className="flex justify-end gap-1">
          <Button
            variant="ghost"
            size="icon"
            className="size-7 shrink-0"
            aria-label={`Edit ${pool.poolid}`}
            disabled={gateReason !== undefined}
            aria-disabled={gateReason !== undefined || undefined}
            title={gateReason}
            onClick={() => onEdit(pool)}
          >
            <Pencil className="size-3.5" />
          </Button>
          {/* Viewing the members is read-only; only the controls inside the sheet are gated. */}
          <Button
            variant="ghost"
            size="icon"
            className="size-7 shrink-0"
            aria-label={`Members of ${pool.poolid}`}
            onClick={() => onMembers(pool)}
          >
            <Users className="size-3.5" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="size-7 shrink-0 text-destructive hover:text-destructive"
            aria-label={`Delete ${pool.poolid}`}
            disabled={deleteReason !== undefined}
            aria-disabled={deleteReason !== undefined || undefined}
            title={deleteReason}
            onClick={() => onDelete(pool)}
          >
            <Trash2 className="size-3.5" />
          </Button>
        </div>
      </TableCell>
    </TableRow>
  );
}

/** The members sheet needs the sheet-level gate for the open pool. */
function MembersSheetHost({
  pool,
  pools,
  isSessionMode,
  onOpenChange,
}: {
  pool: Pool | null;
  pools: Pool[];
  isSessionMode: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const permissions = usePathPermissions(pool ? `/pool/${pool.poolid}` : '');
  const disabledReason = !isSessionMode
    ? READ_ONLY_REASON
    : pool !== null && permissions.data?.can(PRIVILEGE) !== true
      ? `You don't have ${PRIVILEGE} on this pool`
      : undefined;
  return <PoolMembersSheet pool={pool} pools={pools} disabledReason={disabledReason} onOpenChange={onOpenChange} />;
}

/**
 * Datacenter -> Pools: every pool with its comment and member count, Add pool, Edit comment, a
 * Members sheet (add guests / storages, remove with checkboxes) and Delete (typed confirm, offered
 * only for an empty pool). Writes are gated on a session sign-in (not a service token) and on
 * `Pool.Allocate` (`/pool` to create, `/pool/<id>` per row); the server enforces both independently.
 */
export function PoolsTab() {
  const pools = usePools();
  const auth = useAuthMe();
  const addPermissions = usePathPermissions('/pool');
  const [adding, setAdding] = useState(false);
  const [editTarget, setEditTarget] = useState<Pool | null>(null);
  // The id, not the row: the sheet re-reads the pool from the query after each change.
  const [membersId, setMembersId] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<Pool | null>(null);

  const isSessionMode = USE_FIXTURES || auth.data?.mode === 'session';
  const addReason = !isSessionMode
    ? READ_ONLY_REASON
    : addPermissions.data?.can(PRIVILEGE) !== true
      ? `You don't have ${PRIVILEGE} on /pool`
      : undefined;
  const membersPool = (pools.data ?? []).find((p) => p.poolid === membersId) ?? null;

  return (
    <div data-testid="dc-pools-tab" className="flex flex-col gap-3">
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-sm font-medium">Pools</h2>
        <Button size="sm" disabled={addReason !== undefined} aria-disabled={addReason !== undefined || undefined} title={addReason} onClick={() => setAdding(true)}>
          <Plus className="size-3.5" />
          Add pool
        </Button>
      </div>

      {pools.isLoading ? (
        <div className="flex flex-col gap-2" aria-label="Loading pools">
          <Skeleton className="h-8 w-full" />
          <Skeleton className="h-8 w-full" />
        </div>
      ) : pools.isError ? (
        <EmptyState message="The pools could not be loaded." />
      ) : (pools.data ?? []).length === 0 ? (
        <EmptyState message="No pools yet." />
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Pool</TableHead>
              <TableHead>Comment</TableHead>
              <TableHead>Members</TableHead>
              <TableHead>
                <span className="sr-only">Actions</span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {(pools.data ?? []).map((pool) => (
              <PoolRow
                key={pool.poolid}
                pool={pool}
                isSessionMode={isSessionMode}
                onEdit={setEditTarget}
                onMembers={(p) => setMembersId(p.poolid)}
                onDelete={setDeleteTarget}
              />
            ))}
          </TableBody>
        </Table>
      )}

      {adding && <AddPoolDialog open onOpenChange={(open) => !open && setAdding(false)} />}
      {editTarget !== null && (
        <EditPoolCommentDialog
          open
          onOpenChange={(open) => !open && setEditTarget(null)}
          poolid={editTarget.poolid}
          comment={editTarget.comment ?? ''}
        />
      )}
      {deleteTarget !== null && (
        <DeletePoolDialog open onOpenChange={(open) => !open && setDeleteTarget(null)} poolid={deleteTarget.poolid} />
      )}
      <MembersSheetHost
        pool={membersPool}
        pools={pools.data ?? []}
        isSessionMode={isSessionMode}
        onOpenChange={(open) => !open && setMembersId(null)}
      />
    </div>
  );
}

export default PoolsTab;
