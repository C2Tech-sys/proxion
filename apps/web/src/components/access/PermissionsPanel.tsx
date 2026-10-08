import { useState } from 'react';
import { Plus, Trash2 } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { EmptyState } from '@/components/EmptyState';
import { AclDialog } from '@/components/access/AclDialog';
import { ConfirmDialog } from '@/components/access/ConfirmDialog';
import { IconAction } from '@/components/access/accessShared';
import { TOKEN_MODE_TOOLTIP, gateReason, mutationErrorText, removeAclBody } from '@/components/access/accessHelpers';
import { useAccessAcl, useSetAcl } from '@/api/accessHooks';
import { usePathPermissions } from '@/api/accessPermissionHooks';
import type { AccessAclEntry } from '@/api/access';

const TYPE_LABEL: Record<AccessAclEntry['type'], string> = { user: 'User', group: 'Group', token: 'API token' };

/** The per-row Remove button: gated on `Permissions.Modify` on THAT row's path. */
function RemoveAction({ entry, session, onClick }: { entry: AccessAclEntry; session: boolean; onClick: () => void }) {
  const perms = usePathPermissions(entry.path);
  return (
    <IconAction
      label={`Remove permission ${entry.roleid} on ${entry.path} for ${entry.ugid}`}
      icon={Trash2}
      destructive
      disabledReason={gateReason(session, perms.data, 'Permissions.Modify')}
      onClick={onClick}
    />
  );
}

/** Permissions sub-tab: the ACL table with Remove, and "Add permission". */
export function PermissionsPanel({ session }: { session: boolean }) {
  const acl = useAccessAcl();
  const setAcl = useSetAcl();
  const [adding, setAdding] = useState(false);
  const [removing, setRemoving] = useState<AccessAclEntry | undefined>(undefined);
  const [mountKey, setMountKey] = useState(0);

  const addReason = session ? undefined : TOKEN_MODE_TOOLTIP;

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between">
        <p className="text-sm text-muted-foreground">Which user, group or API token holds which role on which path.</p>
        <Button
          size="sm"
          variant="outline"
          disabled={addReason !== undefined}
          title={addReason}
          onClick={() => {
            setMountKey((k) => k + 1);
            setAdding(true);
          }}
        >
          <Plus className="size-3.5" />
          Add permission
        </Button>
      </div>

      {acl.isError ? (
        <EmptyState message="The permissions could not be loaded." />
      ) : !acl.data ? (
        <EmptyState message="Loading permissions..." />
      ) : acl.data.length === 0 ? (
        <EmptyState message="No permissions are set." />
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Path</TableHead>
              <TableHead>User / Group / API token</TableHead>
              <TableHead>Role</TableHead>
              <TableHead>Propagate</TableHead>
              <TableHead className="text-right">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {acl.data.map((entry) => (
              <TableRow key={`${entry.path}|${entry.type}|${entry.ugid}|${entry.roleid}`}>
                <TableCell className="font-mono">{entry.path}</TableCell>
                <TableCell>
                  <span className="mr-2">{entry.ugid}</span>
                  <Badge variant="outline">{TYPE_LABEL[entry.type]}</Badge>
                </TableCell>
                <TableCell>{entry.roleid}</TableCell>
                <TableCell>{entry.propagate ? 'Yes' : 'No'}</TableCell>
                <TableCell>
                  <div className="flex justify-end">
                    <RemoveAction
                      entry={entry}
                      session={session}
                      onClick={() => {
                        setAcl.reset();
                        setMountKey((k) => k + 1);
                        setRemoving(entry);
                      }}
                    />
                  </div>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}

      {adding && <AclDialog key={mountKey} open onOpenChange={(o) => !o && setAdding(false)} />}
      {removing && (
        <ConfirmDialog
          key={mountKey}
          open
          onOpenChange={(o) => !o && setRemoving(undefined)}
          title="Remove permission?"
          description={`${removing.ugid} loses the ${removing.roleid} role on ${removing.path}${removing.propagate ? ' and everything below it' : ''}.`}
          confirmLabel="Remove"
          isPending={setAcl.isPending}
          error={mutationErrorText(setAcl.error)}
          onConfirm={() => setAcl.mutate(removeAclBody(removing), { onSuccess: () => setRemoving(undefined) })}
        />
      )}
    </div>
  );
}
