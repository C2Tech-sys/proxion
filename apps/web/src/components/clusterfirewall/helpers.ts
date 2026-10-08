import { useAuthMe } from '@/api/hooks';
import { USE_FIXTURES } from '@/api/client';
import { useRootPermissions } from '@/api/rootPermissionHooks';

/** Every datacenter firewall write needs this on `/` (what pve-firewall checks). */
export const CLUSTER_FIREWALL_PRIVILEGE = 'Sys.Modify';

export const GROUP_NAME_RE = /^[A-Za-z][A-Za-z0-9_-]{1,19}$/;
export const ALIAS_NAME_RE = /^[A-Za-z][A-Za-z0-9_-]{1,63}$/;
const MAX_COMMENT_LENGTH = 1024;

/** Why the controls are disabled, or `undefined` when the caller can change the datacenter firewall:
 * a service token never can (the server refuses before PVE), and a session needs `Sys.Modify` on `/`.
 * Gating only -- the server enforces both on every write regardless. Fixture/demo mode always
 * demonstrates the enabled state, same as the other write surfaces. */
export function useClusterFirewallGate(): { disabledReason: string | undefined } {
  const auth = useAuthMe();
  const permissions = useRootPermissions();
  const isSessionMode = USE_FIXTURES || auth.data?.mode === 'session';
  const disabledReason = !isSessionMode
    ? 'Read-only: signed in with a service token'
    : permissions.data?.can(CLUSTER_FIREWALL_PRIVILEGE) !== true
      ? `You don't have ${CLUSTER_FIREWALL_PRIVILEGE} on the datacenter`
      : undefined;
  return { disabledReason };
}

/** An IPv4 or IPv6 address, optionally with a `/prefix` of the matching width -- the same shapes the
 * server accepts for an alias or an IP set entry. */
export function isAddressOrCidr(value: string): boolean {
  const slash = value.indexOf('/');
  const address = slash === -1 ? value : value.slice(0, slash);
  let width: 32 | 128 | undefined;
  const octets = address.split('.');
  if (octets.length === 4 && octets.every((o) => /^\d{1,3}$/.test(o) && Number(o) <= 255)) {
    width = 32;
  } else if (address.includes(':') && /^[0-9A-Fa-f:.]+$/.test(address)) {
    try {
      new URL(`http://[${address}]/`);
      width = 128;
    } catch {
      width = undefined;
    }
  }
  if (width === undefined) return false;
  if (slash === -1) return true;
  const prefix = value.slice(slash + 1);
  return /^\d{1,3}$/.test(prefix) && Number(prefix) <= width;
}

/** The shared inline check for a comment field. */
export function commentError(comment: string): string | undefined {
  if (comment.length > MAX_COMMENT_LENGTH) return `A comment is at most ${MAX_COMMENT_LENGTH} characters.`;
  return undefined;
}
