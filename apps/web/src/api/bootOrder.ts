import { USE_FIXTURES } from '@/api/client';
import { GuestActionError } from '@/api/actions';
import { patchFixtureGuestConfig } from '@/api/fixtures';
import type { GuestType } from '@/api/types';

/**
 * VM boot order (T51): the web side of `PUT .../boot-order`
 * (`apps/server/src/actions/bootOrderRoutes.ts`). Own module next to `hardware.ts`; fixture mode
 * is handled inline, same convention as `actions.ts`.
 */

export interface BootOrderResult {
  ok: true;
  /** `['boot']` when PVE is holding the change back until the guest restarts, else `[]`. */
  pending: string[];
}

interface BootOrderErrorBody {
  error?: string;
  message?: string;
  missing?: string;
}

/** Same short, human-readable mapping every guest-action module uses (each keeps its own copy). */
function describeError(status: number, statusText: string, body: BootOrderErrorBody | undefined): string {
  if (body?.message) return body.message;
  switch (body?.error) {
    case 'writes-disabled-in-token-mode':
      return 'Read-only: signed in with a service token';
    case 'forbidden':
      return body?.missing ? `You don't have ${body.missing} on this guest` : "You don't have permission for this";
    case 'pve-unreachable':
      return 'Proxmox VE is unreachable';
    default:
      return body?.error ?? `Request failed: ${status} ${statusText}`;
  }
}

/**
 * Sets a VM's boot order: the devices in boot priority (`['scsi0', 'ide2', 'net0']`); devices not
 * listed are not bootable, and an empty list clears the boot order. Real mode:
 * `PUT /api/actions/guest/:node/:type/:vmid/boot-order`. Fixture mode: writes `boot: order=...`
 * into the in-memory fixture config (an empty list removes the key).
 */
export async function setBootOrder(
  node: string,
  type: GuestType,
  vmid: number,
  order: string[],
): Promise<BootOrderResult> {
  if (USE_FIXTURES) {
    patchFixtureGuestConfig(node, type, vmid, { boot: order.length > 0 ? `order=${order.join(';')}` : undefined });
    return { ok: true, pending: [] };
  }

  const res = await fetch(`/api/actions/guest/${node}/${type}/${vmid}/boot-order`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ order }),
  });
  if (res.status === 200) {
    return (await res.json()) as BootOrderResult;
  }
  let errorBody: BootOrderErrorBody | undefined;
  try {
    errorBody = (await res.json()) as BootOrderErrorBody;
  } catch {
    errorBody = undefined;
  }
  throw new GuestActionError(res.status, describeError(res.status, res.statusText, errorBody));
}
