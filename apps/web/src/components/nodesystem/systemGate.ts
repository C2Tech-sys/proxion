import { USE_FIXTURES } from '@/api/client';
import { useAuthMe } from '@/api/hooks';
import { useNodePermissions } from '@/api/actionHooks';

/** The privilege every node System write needs. */
export const SYSTEM_PRIVILEGE = 'Sys.Modify';

/**
 * Why the System tab's write controls are disabled, or `undefined` when the caller may write: a
 * service-token session is read-only, and every write needs `Sys.Modify` on the node. (The server
 * enforces both independently.) Fixture/demo mode has no real session concept and always
 * demonstrates the enabled state.
 */
export function useSystemGate(node: string): string | undefined {
  const auth = useAuthMe();
  const permissions = useNodePermissions(node);
  const isSessionMode = USE_FIXTURES || auth.data?.mode === 'session';
  const hasPrivilege = permissions.data?.can(SYSTEM_PRIVILEGE) === true;
  if (!isSessionMode) return 'Read-only: signed in with a service token';
  if (!hasPrivilege) return `You don't have ${SYSTEM_PRIVILEGE} on this node`;
  return undefined;
}

/** Whole-number text -> number; `null` when blank; `undefined` when it is not a whole number in
 * range. */
export function parseBoundedInt(text: string, min: number, max: number): number | null | undefined {
  const trimmed = text.trim();
  if (trimmed === '') return null;
  if (!/^\d+$/.test(trimmed)) return undefined;
  const n = Number(trimmed);
  return n >= min && n <= max ? n : undefined;
}
