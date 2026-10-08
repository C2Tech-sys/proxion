import { useId, useState, type KeyboardEvent } from 'react';
import { Loader2 } from 'lucide-react';

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { NativeSelect } from '@/components/hardware/NativeSelect';
import { CheckField, Field } from '@/components/access/accessShared';
import {
  isValidAclPath,
  missingPrivilegeTooltip,
  mutationErrorText,
} from '@/components/access/accessHelpers';
import {
  useAccessGroups,
  useAccessPathSuggestions,
  useAccessRoles,
  useAccessUsers,
  useSetAcl,
} from '@/api/accessHooks';
import { usePathPermissions } from '@/api/accessPermissionHooks';
import type { AclBody } from '@/api/access';

export interface AclDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

type SubjectType = 'user' | 'group' | 'token';
const ACL_PRIVILEGE = 'Permissions.Modify';

/**
 * Grants a role on a path to a user, a group or an API token ("Add permission"). The path accepts
 * free text with suggestions from the cluster (nodes, guests, storages, pools and the access
 * roots). The dialog checks `Permissions.Modify` on the typed path and says so when it is missing;
 * the server enforces it regardless. A server error stays inline. Mount it fresh per open.
 */
export function AclDialog({ open, onOpenChange }: AclDialogProps) {
  const id = useId();
  const mutation = useSetAcl();
  const roles = useAccessRoles();
  const users = useAccessUsers();
  const groups = useAccessGroups();
  const suggestions = useAccessPathSuggestions();

  const [path, setPath] = useState('/');
  const [roleChoice, setRoleChoice] = useState<string | undefined>(undefined);
  const [type, setType] = useState<SubjectType>('user');
  const [subjectChoice, setSubjectChoice] = useState<string | undefined>(undefined);
  const [propagate, setPropagate] = useState(true);

  const roleIds = (roles.data ?? []).map((r) => r.roleid);
  const role = roleChoice ?? (roleIds.includes('PVEAuditor') ? 'PVEAuditor' : (roleIds[0] ?? ''));

  const subjects: string[] =
    type === 'user'
      ? (users.data ?? []).map((u) => u.userid)
      : type === 'group'
        ? (groups.data ?? []).map((g) => g.groupid)
        : (users.data ?? []).flatMap((u) => u.tokens.map((t) => `${u.userid}!${t.tokenid}`));
  const subject = subjectChoice !== undefined && subjects.includes(subjectChoice) ? subjectChoice : (subjects[0] ?? '');

  const pathValid = isValidAclPath(path.trim());
  const permissions = usePathPermissions(pathValid ? path.trim() : '');
  const allowed = permissions.data === undefined || permissions.data.can(ACL_PRIVILEGE);
  const canSave = pathValid && role !== '' && subject !== '' && allowed && !mutation.isPending;

  function submit() {
    if (!canSave) return;
    const body: AclBody = { path: path.trim(), roles: [role], propagate };
    if (type === 'user') body.users = [subject];
    else if (type === 'group') body.groups = [subject];
    else body.tokens = [subject];
    mutation.mutate(body, { onSuccess: () => onOpenChange(false) });
  }

  function onKeyDown(event: KeyboardEvent<HTMLElement>) {
    if (event.key === 'Enter' && event.target instanceof HTMLInputElement) {
      event.preventDefault();
      submit();
    }
  }

  const busy = mutation.isPending;
  const serverError = mutationErrorText(mutation.error);
  const pathError =
    path.trim() !== '' && !pathValid ? 'Enter a path such as /, /vms/100, /storage/local or /pool/lab.' : undefined;

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next && busy) return;
        onOpenChange(next);
      }}
    >
      <DialogContent onKeyDown={onKeyDown}>
        <DialogHeader>
          <DialogTitle>Add permission</DialogTitle>
          <DialogDescription>
            Give a user, group or API token a role on a path. With "Propagate" it also covers everything below the path.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-4">
          <Field label="Path" htmlFor={`${id}-path`} error={pathError}>
            <Input
              id={`${id}-path`}
              autoFocus
              list={`${id}-paths`}
              value={path}
              onChange={(e) => setPath(e.target.value)}
              disabled={busy}
              aria-invalid={pathError !== undefined || undefined}
              autoComplete="off"
            />
            <datalist id={`${id}-paths`}>
              {suggestions.map((p) => (
                <option key={p} value={p} />
              ))}
            </datalist>
          </Field>

          <Field label="Role" htmlFor={`${id}-role`}>
            <NativeSelect id={`${id}-role`} value={role} onChange={(e) => setRoleChoice(e.target.value)} disabled={busy}>
              {roleIds.map((r) => (
                <option key={r} value={r}>
                  {r}
                </option>
              ))}
            </NativeSelect>
          </Field>

          <div className="grid grid-cols-[auto_1fr] gap-3">
            <Field label="Applies to" htmlFor={`${id}-type`}>
              <NativeSelect
                id={`${id}-type`}
                value={type}
                onChange={(e) => {
                  setType(e.target.value as SubjectType);
                  setSubjectChoice(undefined);
                }}
                disabled={busy}
              >
                <option value="user">User</option>
                <option value="group">Group</option>
                <option value="token">API token</option>
              </NativeSelect>
            </Field>
            <Field
              label={type === 'user' ? 'User' : type === 'group' ? 'Group' : 'API token'}
              htmlFor={`${id}-subject`}
              error={subjects.length === 0 ? `There are no ${type === 'token' ? 'API tokens' : `${type}s`} yet.` : undefined}
            >
              <NativeSelect
                id={`${id}-subject`}
                value={subject}
                onChange={(e) => setSubjectChoice(e.target.value)}
                disabled={busy || subjects.length === 0}
              >
                {subjects.map((s) => (
                  <option key={s} value={s}>
                    {s}
                  </option>
                ))}
              </NativeSelect>
            </Field>
          </div>

          <CheckField id={`${id}-propagate`} label="Propagate" checked={propagate} onChange={setPropagate} disabled={busy} />

          {pathValid && !allowed && (
            <p role="alert" className="text-sm text-status-error">
              {missingPrivilegeTooltip(ACL_PRIVILEGE)} on {path.trim()}.
            </p>
          )}
          {serverError && (
            <p role="alert" className="text-sm text-status-error">
              {serverError}
            </p>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={!canSave}>
            {busy && <Loader2 className="size-4 animate-spin" />}
            Add
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
