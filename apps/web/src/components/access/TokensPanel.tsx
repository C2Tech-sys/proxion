import { useState } from 'react';
import { Plus, Trash2, X } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { EmptyState } from '@/components/EmptyState';
import { ConfirmDialog } from '@/components/access/ConfirmDialog';
import { TokenDialog } from '@/components/access/TokenDialog';
import { IconAction } from '@/components/access/accessShared';
import {
  TOKEN_MODE_TOOLTIP,
  formatExpire,
  gateReason,
  mutationErrorText,
} from '@/components/access/accessHelpers';
import type { AccessPanelContext } from '@/components/access/UsersPanel';
import { useAccessUsers, useDeleteToken } from '@/api/accessHooks';

export interface TokensPanelProps {
  ctx: AccessPanelContext;
  /** Show only this user's tokens. */
  userFilter: string | undefined;
  onClearFilter: () => void;
}

/**
 * API Tokens sub-tab: every token (from `GET /access/users?full=1`), optionally of one user, with
 * Delete and "Add token". A token's secret is never listed -- Proxmox VE only returns it when the
 * token is created.
 */
export function TokensPanel({ ctx, userFilter, onClearFilter }: TokensPanelProps) {
  const users = useAccessUsers();
  const del = useDeleteToken();
  const [adding, setAdding] = useState(false);
  const [deleting, setDeleting] = useState<{ userid: string; tokenid: string } | undefined>(undefined);
  const [mountKey, setMountKey] = useState(0);

  const modifyReason = gateReason(ctx.session, ctx.accessPerms, 'User.Modify');
  // A caller's own tokens need no User.Modify; anyone else's do.
  const canForOthers = ctx.session && modifyReason === undefined;
  const eligible = (users.data ?? [])
    .map((u) => u.userid)
    .filter((userid) => (userid === ctx.self ? ctx.session : canForOthers));
  const addReason = !ctx.session ? TOKEN_MODE_TOOLTIP : eligible.length === 0 ? 'There is no user you can create a token for' : undefined;

  const rows = (users.data ?? [])
    .filter((u) => userFilter === undefined || u.userid === userFilter)
    .flatMap((u) => u.tokens.map((t) => ({ userid: u.userid, token: t })));

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between gap-3">
        <p className="flex items-center gap-2 text-sm text-muted-foreground">
          {userFilter ? (
            <>
              API tokens of <span className="font-medium text-foreground">{userFilter}</span>
              <Button variant="ghost" size="sm" className="h-6 gap-1 px-1.5" onClick={onClearFilter}>
                <X className="size-3" />
                Show all
              </Button>
            </>
          ) : (
            'API tokens let scripts and services call the API as a user. The secret is only shown when a token is created.'
          )}
        </p>
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
          Add token
        </Button>
      </div>

      {users.isError ? (
        <EmptyState message="The token list could not be loaded." />
      ) : !users.data ? (
        <EmptyState message="Loading tokens..." />
      ) : rows.length === 0 ? (
        <EmptyState message="There are no API tokens." />
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>User</TableHead>
              <TableHead>Token ID</TableHead>
              <TableHead>Comment</TableHead>
              <TableHead>Expire</TableHead>
              <TableHead>Privilege separation</TableHead>
              <TableHead className="text-right">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map(({ userid, token }) => {
              const reason = userid === ctx.self ? (ctx.session ? undefined : TOKEN_MODE_TOOLTIP) : modifyReason;
              return (
                <TableRow key={`${userid}!${token.tokenid}`}>
                  <TableCell className="font-medium">{userid}</TableCell>
                  <TableCell className="font-mono">{token.tokenid}</TableCell>
                  <TableCell>{token.comment}</TableCell>
                  <TableCell>{formatExpire(token.expire)}</TableCell>
                  <TableCell>{token.privsep ? 'Yes' : 'No'}</TableCell>
                  <TableCell>
                    <div className="flex justify-end">
                      <IconAction
                        label={`Delete token ${userid}!${token.tokenid}`}
                        icon={Trash2}
                        destructive
                        disabledReason={reason}
                        onClick={() => {
                          del.reset();
                          setMountKey((k) => k + 1);
                          setDeleting({ userid, tokenid: token.tokenid });
                        }}
                      />
                    </div>
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      )}

      {adding && (
        <TokenDialog
          key={mountKey}
          open
          onOpenChange={(o) => !o && setAdding(false)}
          userids={eligible}
          initialUserid={userFilter !== undefined && eligible.includes(userFilter) ? userFilter : ctx.self}
        />
      )}
      {deleting && (
        <ConfirmDialog
          key={mountKey}
          open
          onOpenChange={(o) => !o && setDeleting(undefined)}
          title={`Delete token ${deleting.userid}!${deleting.tokenid}?`}
          description="Anything using this token stops working immediately, and its permissions are removed. This cannot be undone."
          confirmLabel="Delete token"
          isPending={del.isPending}
          error={mutationErrorText(del.error)}
          onConfirm={() => del.mutate(deleting, { onSuccess: () => setDeleting(undefined) })}
        />
      )}
    </div>
  );
}
