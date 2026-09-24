import { useState } from 'react';

import { useGuestAction } from '@/api/actionHooks';
import type { GuestAction, GuestActionBody } from '@/api/actions';
import type { GuestType } from '@/api/types';

export interface GuestActionTarget {
  node: string;
  type: GuestType;
  vmid: number;
  name: string;
}

/**
 * Shared "request -> confirm -> mutate" flow for one guest's quick actions, so `ObjectHeader`
 * and `InventoryTree`'s context menu drive the exact same `GuestActionDialog` the exact same
 * way. `request` opens the dialog for one action; `confirm` runs the mutation (closing the
 * dialog once it settles, success or failure -- the mutation's own toast reports which);
 * `cancel` closes it without doing anything, and is a no-op while a request is in flight.
 */
export function useGuestActionFlow(target: GuestActionTarget) {
  const [pendingAction, setPendingAction] = useState<GuestAction | null>(null);
  const mutation = useGuestAction();

  function request(action: GuestAction): void {
    setPendingAction(action);
  }

  function cancel(): void {
    if (mutation.isPending) return;
    setPendingAction(null);
  }

  function confirm(body?: GuestActionBody): void {
    if (!pendingAction) return;
    mutation.mutate(
      {
        node: target.node,
        type: target.type,
        vmid: target.vmid,
        action: pendingAction,
        ...(body !== undefined ? { body } : {}),
      },
      { onSettled: () => setPendingAction(null) },
    );
  }

  return { pendingAction, request, cancel, confirm, isPending: mutation.isPending };
}
