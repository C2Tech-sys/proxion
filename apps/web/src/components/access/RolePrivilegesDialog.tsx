import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import type { AccessRole } from '@/api/access';

export interface RolePrivilegesDialogProps {
  role: AccessRole | undefined;
  onClose: () => void;
}

/** Read-only list of the privileges a role grants. Open while `role` is set. */
export function RolePrivilegesDialog({ role, onClose }: RolePrivilegesDialogProps) {
  return (
    <Dialog open={role !== undefined} onOpenChange={(next) => !next && onClose()}>
      <DialogContent className="max-h-[80vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{role?.roleid} privileges</DialogTitle>
          <DialogDescription>
            {role?.special ? 'A built-in role; it cannot be changed. ' : ''}
            {role && role.privs.length === 0 ? 'This role grants no privileges.' : `${role?.privs.length ?? 0} privileges.`}
          </DialogDescription>
        </DialogHeader>
        <ul className="grid grid-cols-1 gap-x-4 gap-y-1 font-mono text-xs sm:grid-cols-2">
          {role?.privs.map((p) => (
            <li key={p}>{p}</li>
          ))}
        </ul>
      </DialogContent>
    </Dialog>
  );
}
