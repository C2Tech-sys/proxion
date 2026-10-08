import { useState } from 'react';

import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { EmptyState } from '@/components/EmptyState';
import { RolePrivilegesDialog } from '@/components/access/RolePrivilegesDialog';
import { useAccessRoles } from '@/api/accessHooks';
import type { AccessRole } from '@/api/access';

/** Roles sub-tab: read-only list; "N privileges" opens the full privilege list of a role. */
export function RolesPanel() {
  const roles = useAccessRoles();
  const [selected, setSelected] = useState<AccessRole | undefined>(undefined);

  return (
    <div className="flex flex-col gap-3">
      <p className="text-sm text-muted-foreground">Roles are named sets of privileges. They are read-only here.</p>
      {roles.isError ? (
        <EmptyState message="The role list could not be loaded." />
      ) : !roles.data ? (
        <EmptyState message="Loading roles..." />
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Role</TableHead>
              <TableHead>Built-in</TableHead>
              <TableHead>Privileges</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {roles.data.map((role) => (
              <TableRow key={role.roleid}>
                <TableCell className="font-medium">{role.roleid}</TableCell>
                <TableCell>{role.special ? <Badge variant="outline">Built-in</Badge> : null}</TableCell>
                <TableCell>
                  <Button
                    variant="link"
                    size="sm"
                    className="h-auto p-0"
                    aria-label={`Privileges of ${role.roleid}`}
                    onClick={() => setSelected(role)}
                  >
                    {role.privs.length} {role.privs.length === 1 ? 'privilege' : 'privileges'}
                  </Button>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
      <RolePrivilegesDialog role={selected} onClose={() => setSelected(undefined)} />
    </div>
  );
}
