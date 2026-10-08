import { errorMessage } from '@/api/errors';
import type { AccessAclEntry, AclBody } from '@/api/access';

/** Tooltip on a disabled write control when the identity is the shared service token. */
export const TOKEN_MODE_TOOLTIP = 'Read-only: signed in with a service token';

export function missingPrivilegeTooltip(privilege: string): string {
  return `You don't have ${privilege}`;
}

/**
 * The reason a write control is disabled, or `undefined` when it is allowed. `privileges` may be
 * `undefined` while the permission lookup is still in flight (the control stays enabled -- the
 * server enforces the privilege on every write regardless).
 */
export function gateReason(
  session: boolean,
  privileges: { can: (privilege: string) => boolean } | undefined,
  privilege: string,
): string | undefined {
  if (!session) return TOKEN_MODE_TOOLTIP;
  if (privileges !== undefined && !privileges.can(privilege)) return missingPrivilegeTooltip(privilege);
  return undefined;
}

export function mutationErrorText(error: unknown): string | undefined {
  return error ? errorMessage(error) : undefined;
}

// --- expiry ---------------------------------------------------------------------------------------

const pad = (n: number) => String(n).padStart(2, '0');

/** `YYYY-MM-DD` of a unix-seconds expiry in local time, or `''` for "never" (`0`). */
export function expireToDateInput(expire: number): string {
  if (!expire) return '';
  const d = new Date(expire * 1000);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** A `YYYY-MM-DD` date input value -> unix seconds at the END of that local day (`0` for blank). */
export function dateInputToExpire(value: string): number {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return 0;
  return Math.floor(new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]), 23, 59, 59).getTime() / 1000);
}

/** Table cell text for an expiry. */
export function formatExpire(expire: number): string {
  return expire ? expireToDateInput(expire) : 'never';
}

// --- validation -----------------------------------------------------------------------------------

export const USER_NAME_RE = /^[A-Za-z0-9._-]+$/;
export const GROUP_ID_RE = /^[A-Za-z0-9._-]{1,64}$/;
export const TOKEN_ID_RE = /^[A-Za-z0-9._-]{2,64}$/;
export const ACL_PATH_RE = /^\/[A-Za-z0-9/._-]*$/;
export const BARE_EMAIL_RE = /^[^\s@,<>"]+@[^\s@,<>"]+\.[^\s@,<>"]+$/;

export function isValidAclPath(path: string): boolean {
  return ACL_PATH_RE.test(path) && path.length <= 256 && !path.split('/').some((s) => s === '.' || s === '..');
}

/** Password rules shared by the add-user and change-password dialogs. */
export function passwordError(password: string, confirm: string): string | undefined {
  if (password.length > 0 && (password.length < 8 || password.length > 64)) return 'Use 8 to 64 characters.';
  if (confirm.length > 0 && confirm !== password) return 'The passwords do not match.';
  return undefined;
}

/** The body that removes exactly this ACL entry. */
export function removeAclBody(entry: AccessAclEntry): AclBody {
  const body: AclBody = { path: entry.path, roles: [entry.roleid], propagate: entry.propagate, remove: true };
  if (entry.type === 'user') body.users = [entry.ugid];
  else if (entry.type === 'group') body.groups = [entry.ugid];
  else body.tokens = [entry.ugid];
  return body;
}
