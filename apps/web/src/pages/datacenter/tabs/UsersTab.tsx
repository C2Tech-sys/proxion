import { useState } from 'react';
import { KeyRound } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { GroupsPanel } from '@/components/access/GroupsPanel';
import { PasswordDialog } from '@/components/access/PasswordDialog';
import { PermissionsPanel } from '@/components/access/PermissionsPanel';
import { RolesPanel } from '@/components/access/RolesPanel';
import { TokensPanel } from '@/components/access/TokensPanel';
import { UsersPanel, type AccessPanelContext } from '@/components/access/UsersPanel';
import { TOKEN_MODE_TOOLTIP } from '@/components/access/accessHelpers';
import { useAccessSessionMode, useCurrentUserid } from '@/api/accessHooks';
import { usePathPermissions } from '@/api/accessPermissionHooks';
import { realmOf } from '@/api/access';

const SUB_TABS = [
  { value: 'users', label: 'Users' },
  { value: 'groups', label: 'Groups' },
  { value: 'roles', label: 'Roles' },
  { value: 'permissions', label: 'Permissions' },
  { value: 'tokens', label: 'API Tokens' },
] as const;
type SubTab = (typeof SUB_TABS)[number]['value'];

const PAM_HINT = 'Passwords of pam users are managed on the Proxmox host (passwd), not here';

/**
 * Datacenter -> Users & Permissions (T68): Users, Groups, Roles (read-only), Permissions (ACL) and
 * API Tokens sub-tabs, plus "Change my password" for the signed-in user. Reads go through the
 * read-only `/api/pve/*` proxy; writes go through `/api/actions/datacenter/access/*`, and every
 * write control is disabled in service-token mode or without the relevant PVE privilege (the
 * server enforces both regardless).
 */
export function UsersTab() {
  const session = useAccessSessionMode();
  const self = useCurrentUserid();
  const accessPerms = usePathPermissions('/access').data;
  const groupPerms = usePathPermissions('/access/groups').data;
  const [sub, setSub] = useState<SubTab>('users');
  const [tokenUser, setTokenUser] = useState<string | undefined>(undefined);
  const [changingOwn, setChangingOwn] = useState(false);
  const [passwordKey, setPasswordKey] = useState(0);

  const ctx: AccessPanelContext = { session, self, accessPerms, groupPerms };

  const ownPasswordReason = !session || self === undefined ? TOKEN_MODE_TOOLTIP : realmOf(self) !== 'pve' ? PAM_HINT : undefined;

  return (
    <div data-testid="dc-users-tab" className="flex flex-col gap-3">
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-sm font-medium">Users &amp; Permissions</h2>
        <Button
          size="sm"
          variant="outline"
          disabled={ownPasswordReason !== undefined}
          title={ownPasswordReason}
          onClick={() => {
            setPasswordKey((k) => k + 1);
            setChangingOwn(true);
          }}
        >
          <KeyRound className="size-3.5" />
          Change my password
        </Button>
      </div>

      <Tabs value={sub} onValueChange={(v) => setSub(v as SubTab)}>
        <TabsList>
          {SUB_TABS.map((t) => (
            <TabsTrigger key={t.value} value={t.value}>
              {t.label}
            </TabsTrigger>
          ))}
        </TabsList>
        <TabsContent value="users">
          <UsersPanel
            ctx={ctx}
            onShowTokens={(userid) => {
              setTokenUser(userid);
              setSub('tokens');
            }}
          />
        </TabsContent>
        <TabsContent value="groups">
          <GroupsPanel ctx={ctx} />
        </TabsContent>
        <TabsContent value="roles">
          <RolesPanel />
        </TabsContent>
        <TabsContent value="permissions">
          <PermissionsPanel session={session} />
        </TabsContent>
        <TabsContent value="tokens">
          <TokensPanel ctx={ctx} userFilter={tokenUser} onClearFilter={() => setTokenUser(undefined)} />
        </TabsContent>
      </Tabs>

      {changingOwn && self !== undefined && (
        <PasswordDialog key={passwordKey} open userid={self} isSelf onOpenChange={(o) => !o && setChangingOwn(false)} />
      )}
    </div>
  );
}

export default UsersTab;
