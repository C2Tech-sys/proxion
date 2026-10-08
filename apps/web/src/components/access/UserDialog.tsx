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
  BARE_EMAIL_RE,
  USER_NAME_RE,
  dateInputToExpire,
  expireToDateInput,
  missingPrivilegeTooltip,
  mutationErrorText,
  passwordError,
} from '@/components/access/accessHelpers';
import { useAccessGroups, useAccessRealms, useCreateUser, useUpdateUser } from '@/api/accessHooks';
import { usePathPermissions } from '@/api/accessPermissionHooks';
import type { AccessUser, CreateUserBody, UpdateUserBody } from '@/api/access';

export interface UserDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The user being edited. Omit to add a new one. */
  user?: AccessUser | undefined;
}

const REALM_PRIVILEGE = 'Realm.AllocateUser';

/**
 * Adds or edits a Proxmox VE user. Adding: user name + realm (from `/access/domains`), a password
 * with confirmation for the `pve` realm (other realms authenticate elsewhere), enable switch,
 * expiry date, name / email / comment and group membership. Editing: the same minus the id and the
 * password (use "Change password"); only the fields that changed are sent, and a field that was
 * cleared is sent as `null`. A server error stays inline and the dialog stays open.
 *
 * Mount it fresh per open (the tab renders it conditionally).
 */
export function UserDialog({ open, onOpenChange, user }: UserDialogProps) {
  const id = useId();
  const isNew = user === undefined;
  const create = useCreateUser();
  const update = useUpdateUser();
  const mutation = isNew ? create : update;
  const realms = useAccessRealms();
  const groups = useAccessGroups();

  const [name, setName] = useState('');
  const [realmChoice, setRealmChoice] = useState<string | undefined>(undefined);
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [enable, setEnable] = useState(user?.enable ?? true);
  const [expireText, setExpireText] = useState(user ? expireToDateInput(user.expire) : '');
  const [firstname, setFirstname] = useState(user?.firstname ?? '');
  const [lastname, setLastname] = useState(user?.lastname ?? '');
  const [email, setEmail] = useState(user?.email ?? '');
  const [comment, setComment] = useState(user?.comment ?? '');
  const [memberOf, setMemberOf] = useState<string[]>(user?.groups ?? []);

  // Membership in the order the groups are listed (a click order would make the request unstable).
  const groupOrder = (groups.data ?? []).map((g) => g.groupid);
  const orderedGroups = [...memberOf].sort(
    (a, b) => (groupOrder.indexOf(a) + 1 || Infinity) - (groupOrder.indexOf(b) + 1 || Infinity) || a.localeCompare(b),
  );
  const realmNames = (realms.data ?? []).map((r) => r.realm);
  const realm = realmChoice ?? (realmNames.includes('pve') ? 'pve' : (realmNames[0] ?? 'pve'));
  const usesPassword = isNew && realm === 'pve';
  const realmPermissions = usePathPermissions(isNew ? `/access/realm/${realm}` : '');
  const realmAllowed = !isNew || realmPermissions.data === undefined || realmPermissions.data.can(REALM_PRIVILEGE);

  const errors = {
    name: isNew && name !== '' && !USER_NAME_RE.test(name) ? 'Use letters, digits, ".", "_" or "-".' : undefined,
    password: usesPassword ? passwordError(password, confirm) : undefined,
    email: email.trim() !== '' && !BARE_EMAIL_RE.test(email.trim()) ? 'Enter a plain address such as name@example.com.' : undefined,
  };
  const required = isNew ? name.trim() !== '' && (!usesPassword || password !== '') : true;
  const valid = Object.values(errors).every((e) => e === undefined) && required;

  function buildCreate(): CreateUserBody {
    const body: CreateUserBody = { userid: `${name.trim()}@${realm}`, enable };
    if (usesPassword) body.password = password;
    if (expireText !== '') body.expire = dateInputToExpire(expireText);
    if (firstname.trim() !== '') body.firstname = firstname.trim();
    if (lastname.trim() !== '') body.lastname = lastname.trim();
    if (email.trim() !== '') body.email = email.trim();
    if (orderedGroups.length > 0) body.groups = orderedGroups;
    if (comment.trim() !== '') body.comment = comment.trim();
    return body;
  }

  /** Only what changed; a field emptied by the user is `null` (cleared). */
  function buildUpdate(current: AccessUser): UpdateUserBody {
    const body: UpdateUserBody = {};
    if (enable !== current.enable) body.enable = enable;
    if (expireText !== expireToDateInput(current.expire)) {
      body.expire = expireText === '' ? null : dateInputToExpire(expireText);
    }
    const text: Array<['firstname' | 'lastname' | 'email' | 'comment', string]> = [
      ['firstname', firstname],
      ['lastname', lastname],
      ['email', email],
      ['comment', comment],
    ];
    for (const [key, value] of text) {
      const next = value.trim();
      if (next !== (current[key] ?? '')) body[key] = next === '' ? null : next;
    }
    const before = [...current.groups].sort().join(',');
    if ([...memberOf].sort().join(',') !== before) body.groups = orderedGroups.length > 0 ? orderedGroups : null;
    return body;
  }

  const editBody = user ? buildUpdate(user) : undefined;
  const changed = editBody !== undefined && Object.keys(editBody).length > 0;
  const canSave = valid && realmAllowed && !mutation.isPending && (isNew || changed);

  function submit() {
    if (!canSave) return;
    const done = { onSuccess: () => onOpenChange(false) };
    if (user && editBody) update.mutate({ userid: user.userid, body: editBody }, done);
    else create.mutate(buildCreate(), done);
  }

  function onKeyDown(event: KeyboardEvent<HTMLElement>) {
    if (event.key === 'Enter' && event.target instanceof HTMLInputElement) {
      event.preventDefault();
      submit();
    }
  }

  const busy = mutation.isPending;
  const serverError = mutationErrorText(mutation.error);

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next && busy) return;
        onOpenChange(next);
      }}
    >
      <DialogContent onKeyDown={onKeyDown} className="max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{isNew ? 'Add user' : `Edit user ${user.userid}`}</DialogTitle>
          <DialogDescription>
            {isNew
              ? 'Create a Proxmox VE user. Grant it access afterwards under Permissions.'
              : 'Change the details of this user. Use "Change password" to set a new password.'}
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-4">
          {isNew && (
            <div className="grid grid-cols-[1fr_auto] gap-3">
              <Field label="User name" htmlFor={`${id}-name`} error={errors.name}>
                <Input
                  id={`${id}-name`}
                  autoFocus
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  disabled={busy}
                  aria-invalid={errors.name !== undefined || undefined}
                  autoComplete="off"
                />
              </Field>
              <Field label="Realm" htmlFor={`${id}-realm`}>
                <NativeSelect id={`${id}-realm`} value={realm} onChange={(e) => setRealmChoice(e.target.value)} disabled={busy}>
                  {(realmNames.length > 0 ? realmNames : ['pve']).map((r) => (
                    <option key={r} value={r}>
                      {r}
                    </option>
                  ))}
                </NativeSelect>
              </Field>
            </div>
          )}

          {usesPassword && (
            <>
              <Field label="Password" htmlFor={`${id}-password`} error={errors.password} hint="8 to 64 characters.">
                <Input
                  id={`${id}-password`}
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  disabled={busy}
                  autoComplete="new-password"
                />
              </Field>
              <Field label="Confirm password" htmlFor={`${id}-confirm`}>
                <Input
                  id={`${id}-confirm`}
                  type="password"
                  value={confirm}
                  onChange={(e) => setConfirm(e.target.value)}
                  disabled={busy}
                  autoComplete="new-password"
                />
              </Field>
            </>
          )}

          <div className="grid grid-cols-2 gap-3">
            <Field label="First name" htmlFor={`${id}-first`}>
              <Input id={`${id}-first`} value={firstname} onChange={(e) => setFirstname(e.target.value)} disabled={busy} />
            </Field>
            <Field label="Last name" htmlFor={`${id}-last`}>
              <Input id={`${id}-last`} value={lastname} onChange={(e) => setLastname(e.target.value)} disabled={busy} />
            </Field>
          </div>

          <Field label="Email" htmlFor={`${id}-email`} error={errors.email}>
            <Input
              id={`${id}-email`}
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              disabled={busy}
              aria-invalid={errors.email !== undefined || undefined}
            />
          </Field>

          <Field label="Comment" htmlFor={`${id}-comment`}>
            <Input id={`${id}-comment`} value={comment} onChange={(e) => setComment(e.target.value)} disabled={busy} />
          </Field>

          <div className="grid grid-cols-2 items-end gap-3">
            <Field label="Expire" htmlFor={`${id}-expire`} hint="Leave empty for never.">
              <Input
                id={`${id}-expire`}
                type="date"
                value={expireText}
                onChange={(e) => setExpireText(e.target.value)}
                disabled={busy}
              />
            </Field>
            <CheckField id={`${id}-enable`} label="Enabled" checked={enable} onChange={setEnable} disabled={busy} />
          </div>

          {(groups.data?.length ?? 0) > 0 && (
            <fieldset className="flex flex-col gap-1.5">
              <legend className="mb-1 text-sm font-medium">Groups</legend>
              <div className="flex flex-wrap gap-x-4 gap-y-1.5">
                {groups.data?.map((g) => (
                  <CheckField
                    key={g.groupid}
                    id={`${id}-group-${g.groupid}`}
                    label={g.groupid}
                    checked={memberOf.includes(g.groupid)}
                    disabled={busy}
                    onChange={(checked) =>
                      setMemberOf((prev) => (checked ? [...prev, g.groupid] : prev.filter((x) => x !== g.groupid)))
                    }
                  />
                ))}
              </div>
            </fieldset>
          )}

          {!realmAllowed && (
            <p role="alert" className="text-sm text-status-error">
              {missingPrivilegeTooltip(REALM_PRIVILEGE)} on realm {realm}.
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
            {isNew ? 'Add user' : 'Save'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
