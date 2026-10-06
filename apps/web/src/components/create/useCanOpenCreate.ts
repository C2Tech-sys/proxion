import { USE_FIXTURES } from '@/api/client';
import { useAuthMe } from '@/api/hooks';

/**
 * Whether the "Create" entry points (top bar button, node context menu items) are offered at all:
 * only for a signed-in session. The shared service token can never create guests, so there the
 * entry points are hidden (not merely disabled). Fixture/demo mode always offers them, same
 * carve-out `NodePowerMenu`/`GuestContextMenu` use.
 *
 * Deliberately NOT gated on `VM.Allocate`: the permission hooks in `actionHooks.ts` are scoped to
 * a vmid, node or storage path (none accepts `/` or `/vms`), so there is no cheap cluster-wide
 * check. The items are shown and the wizard dialog gates on the privilege itself.
 */
export function useCanOpenCreate(): boolean {
  const auth = useAuthMe();
  return USE_FIXTURES || auth.data?.mode === 'session';
}
