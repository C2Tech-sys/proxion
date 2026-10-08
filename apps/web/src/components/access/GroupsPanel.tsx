import { useState } from 'react';
import { Pencil, Plus, Trash2 } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { EmptyState } from '@/components/EmptyState';
import { ConfirmDialog } from '@/components/access/ConfirmDialog';
import { GroupDialog } from '@/components/access/GroupDialog';
import { IconAction } from '@/components/access/accessShared';
import { gateReason, mutationErrorText } from '@/components/access/accessHelpers';
import type { AccessPanelContext } from '@/components/access/UsersPanel';
import { useAccessGroups, useAccessUsers, useDeleteGroup } from '@/api/accessHooks';
import type { AccessGroup } from '@/api/access';

type Dialog = { kind: 'add' } | { kind: 'edit'; group: AccessGroup } | { kind: 'delete'; groupid: string };

/** Groups sub-tab: group table with members, Edit / Delete and "Add group". */
export function GroupsPanel({ ctx }: { ctx: AccessPanelContext }) {
  const groups = useAccessGroups();
  const users = useAccessUsers();
  const del = useDeleteGroup();
  const [dialog, setDialog] = useState<Dialog | undefined>(undefined);
  const [mountKey, setMountKey] = useState(0);

  function open(next: Dialog) {
    del.reset();
    setMountKey((k) => k + 1);
    setDialog(next);
  }
  const close = () => setDialog(undefined);

  const reason = gateReason(ctx.session, ctx.groupPerms, 'Group.Allocate');
  const members = (groupid: string) => (users.data ?? []).filter((u) => u.groups.includes(groupid)).map((u) => u.userid);

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between">
        <p className="text-sm text-muted-foreground">Groups collect users so permissions can be granted to all of them at once.</p>
        <Button size="sm" variant="outline" disabled={reason !== undefined} title={reason} onClick={() => open({ kind: 'add' })}>
          <Plus className="size-3.5" />
          Add group
        </Button>
      </div>

      {groups.isError ? (
        <EmptyState message="The group list could not be loaded." />
      ) : !groups.data ? (
        <EmptyState message="Loading groups..." />
      ) : groups.data.length === 0 ? (
        <EmptyState message="There are no groups." />
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Group</TableHead>
              <TableHead>Comment</TableHead>
              <TableHead>Members</TableHead>
              <TableHead className="text-right">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {groups.data.map((group) => (
              <TableRow key={group.groupid}>
                <TableCell className="font-medium">{group.groupid}</TableCell>
                <TableCell>{group.comment}</TableCell>
                <TableCell>{members(group.groupid).join(', ')}</TableCell>
                <TableCell>
                  <div className="flex justify-end gap-0.5">
                    <IconAction label={`Edit group ${group.groupid}`} icon={Pencil} disabledReason={reason} onClick={() => open({ kind: 'edit', group })} />
                    <IconAction
                      label={`Delete group ${group.groupid}`}
                      icon={Trash2}
                      destructive
                      disabledReason={reason}
                      onClick={() => open({ kind: 'delete', groupid: group.groupid })}
                    />
                  </div>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}

      {dialog?.kind === 'add' && <GroupDialog key={mountKey} open onOpenChange={(o) => !o && close()} />}
      {dialog?.kind === 'edit' && <GroupDialog key={mountKey} open group={dialog.group} onOpenChange={(o) => !o && close()} />}
      {dialog?.kind === 'delete' && (
        <ConfirmDialog
          key={mountKey}
          open
          onOpenChange={(o) => !o && close()}
          title={`Delete group ${dialog.groupid}?`}
          description="Its members lose the permissions they only had through this group, and its own permissions are removed."
          confirmLabel={`Delete ${dialog.groupid}`}
          isPending={del.isPending}
          error={mutationErrorText(del.error)}
          onConfirm={() => del.mutate(dialog.groupid, { onSuccess: close })}
        />
      )}
    </div>
  );
}
