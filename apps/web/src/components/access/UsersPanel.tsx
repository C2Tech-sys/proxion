import { useState } from 'react';
import { KeyRound, KeySquare, Pencil, Plus, Trash2 } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { EmptyState } from '@/components/EmptyState';
import { ConfirmDialog } from '@/components/access/ConfirmDialog';
import { PasswordDialog } from '@/components/access/PasswordDialog';
import { UserDialog } from '@/components/access/UserDialog';
import { IconAction } from '@/components/access/accessShared';
import {
  TOKEN_MODE_TOOLTIP,
  formatExpire,
  gateReason,
  mutationErrorText,
} from '@/components/access/accessHelpers';
import { useAccessUsers, useDeleteUser } from '@/api/accessHooks';
import { realmOf, type AccessUser } from '@/api/access';
import type { GuestPermissions } from '@/api/actionHooks';

export interface AccessPanelContext {
  /** A real session (or the demo): writes are possible at all. */
  session: boolean;
  /** The signed-in userid, or `undefined` for the shared service token. */
  self: string | undefined;
  /** Permissions on `/access` (`User.Modify`); `undefined` while loading. */
  accessPerms: GuestPermissions | undefined;
  /** Permissions on `/access/groups` (`Group.Allocate`); `undefined` while loading. */
  groupPerms: GuestPermissions | undefined;
}

type Dialog =
  | { kind: 'add' }
  | { kind: 'edit'; user: AccessUser }
  | { kind: 'password'; userid: string }
  | { kind: 'delete'; userid: string };

export interface UsersPanelProps {
  ctx: AccessPanelContext;
  /** Opens the API Tokens sub-tab filtered to one user. */
  onShowTokens: (userid: string) => void;
}

const displayName = (u: AccessUser) => [u.firstname, u.lastname].filter(Boolean).join(' ');

/** Users sub-tab: the user table with Edit / Change password / Tokens / Delete and "Add user". */
export function UsersPanel({ ctx, onShowTokens }: UsersPanelProps) {
  const users = useAccessUsers();
  const del = useDeleteUser();
  const [dialog, setDialog] = useState<Dialog | undefined>(undefined);
  const [mountKey, setMountKey] = useState(0);

  function open(next: Dialog) {
    del.reset();
    setMountKey((k) => k + 1);
    setDialog(next);
  }
  const close = () => setDialog(undefined);

  const addReason = ctx.session ? undefined : TOKEN_MODE_TOOLTIP;
  const modifyReason = gateReason(ctx.session, ctx.accessPerms, 'User.Modify');

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between">
        <p className="text-sm text-muted-foreground">Accounts that can sign in to Proxmox VE or use the API.</p>
        <Button size="sm" variant="outline" disabled={addReason !== undefined} title={addReason} onClick={() => open({ kind: 'add' })}>
          <Plus className="size-3.5" />
          Add user
        </Button>
      </div>

      {users.isError ? (
        <EmptyState message="The user list could not be loaded." />
      ) : !users.data ? (
        <EmptyState message="Loading users..." />
      ) : users.data.length === 0 ? (
        <EmptyState message="There are no users." />
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>User name</TableHead>
              <TableHead>Name</TableHead>
              <TableHead>Enabled</TableHead>
              <TableHead>Expire</TableHead>
              <TableHead>Groups</TableHead>
              <TableHead>Email</TableHead>
              <TableHead>Comment</TableHead>
              <TableHead className="text-right">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {users.data.map((user) => {
              const isSelf = user.userid === ctx.self;
              const isPve = realmOf(user.userid) === 'pve';
              const passwordReason = isSelf ? (ctx.session ? undefined : TOKEN_MODE_TOOLTIP) : modifyReason;
              const deleteReason =
                user.userid === 'root@pam'
                  ? 'root@pam cannot be deleted'
                  : isSelf
                    ? 'You cannot delete the account you are signed in with'
                    : modifyReason;
              return (
                <TableRow key={user.userid}>
                  <TableCell className="font-medium">{user.userid}</TableCell>
                  <TableCell>{displayName(user)}</TableCell>
                  <TableCell>{user.enable ? 'Yes' : <Badge variant="outline">No</Badge>}</TableCell>
                  <TableCell>{formatExpire(user.expire)}</TableCell>
                  <TableCell>{user.groups.join(', ')}</TableCell>
                  <TableCell>{user.email}</TableCell>
                  <TableCell className="max-w-64 truncate" title={user.comment}>
                    {user.comment}
                  </TableCell>
                  <TableCell>
                    <div className="flex justify-end gap-0.5">
                      <IconAction label={`Edit user ${user.userid}`} icon={Pencil} disabledReason={modifyReason} onClick={() => open({ kind: 'edit', user })} />
                      {isPve && (
                        <IconAction
                          label={`Change password for ${user.userid}`}
                          icon={KeyRound}
                          disabledReason={passwordReason}
                          onClick={() => open({ kind: 'password', userid: user.userid })}
                        />
                      )}
                      <IconAction label={`Tokens for ${user.userid}`} icon={KeySquare} onClick={() => onShowTokens(user.userid)} />
                      <IconAction
                        label={`Delete user ${user.userid}`}
                        icon={Trash2}
                        destructive
                        disabledReason={deleteReason}
                        onClick={() => open({ kind: 'delete', userid: user.userid })}
                      />
                    </div>
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      )}

      {dialog?.kind === 'add' && <UserDialog key={mountKey} open onOpenChange={(o) => !o && close()} />}
      {dialog?.kind === 'edit' && <UserDialog key={mountKey} open user={dialog.user} onOpenChange={(o) => !o && close()} />}
      {dialog?.kind === 'password' && (
        <PasswordDialog
          key={mountKey}
          open
          userid={dialog.userid}
          isSelf={dialog.userid === ctx.self}
          onOpenChange={(o) => !o && close()}
        />
      )}
      {dialog?.kind === 'delete' && (
        <ConfirmDialog
          key={mountKey}
          open
          onOpenChange={(o) => !o && close()}
          title={`Delete user ${dialog.userid}?`}
          description="This permanently removes the user, its API tokens and its permissions, and signs it out. This cannot be undone."
          confirmLabel={`Delete ${dialog.userid}`}
          typedConfirm={dialog.userid}
          isPending={del.isPending}
          error={mutationErrorText(del.error)}
          onConfirm={() => del.mutate(dialog.userid, { onSuccess: close })}
        />
      )}
    </div>
  );
}
