import { useEffect, useRef, useState } from 'react';
import { ArrowDown, ArrowUp, Loader2 } from 'lucide-react';

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { EditHardwareButton } from '@/components/hardware/EditHardwareButton';
import { useAuthMe } from '@/api/hooks';
import { usePermissions } from '@/api/actionHooks';
import { useSetBootOrder } from '@/api/bootOrderHooks';
import { hardwareErrorMessage } from '@/api/hardwareHooks';
import { USE_FIXTURES } from '@/api/client';
import { listBootCandidates, parseGuestBootOrder, type BootCandidate } from '@/lib/pve-config';
import type { GuestConfig, GuestType } from '@/api/types';

interface Entry extends BootCandidate {
  enabled: boolean;
}

/** Enabled devices first, in the current boot order; everything else after, in candidate order. */
function initialEntries(candidates: BootCandidate[], order: string[]): Entry[] {
  const byKey = new Map(candidates.map((c) => [c.key, c]));
  const enabled: Entry[] = order.flatMap((key) => {
    const candidate = byKey.get(key);
    return candidate ? [{ ...candidate, enabled: true }] : [];
  });
  const rest: Entry[] = candidates
    .filter((c) => !enabled.some((e) => e.key === c.key))
    .map((c) => ({ ...c, enabled: false }));
  return [...enabled, ...rest];
}

export interface BootOrderDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  node: string;
  type: GuestType;
  vmid: number;
  /** Every bootable device the guest has. */
  candidates: BootCandidate[];
  /** The current boot order (device keys). */
  currentOrder: string[];
  /** The config uses the legacy `boot: cdn` form; saving rewrites it as `order=...`. */
  legacy: boolean;
}

/**
 * Edits a VM's boot order: every bootable device (disks, CD/DVD drives, NICs) in a list with an
 * "enabled" checkbox and Up/Down buttons (plain buttons, so it is keyboard accessible without a
 * drag-and-drop dependency). Enabled devices are always listed first, in boot priority; unticking
 * one moves it below them, ticking one adds it to the end of the enabled ones. Save sends the
 * enabled device keys in order (none ticked = no boot device).
 *
 * Mount it fresh per open (the Hardware tab renders it conditionally).
 */
export function BootOrderDialog({
  open,
  onOpenChange,
  node,
  type,
  vmid,
  candidates,
  currentOrder,
  legacy,
}: BootOrderDialogProps) {
  const mutation = useSetBootOrder();
  const [entries, setEntries] = useState<Entry[]>(() => initialEntries(candidates, currentOrder));
  const listRef = useRef<HTMLUListElement>(null);
  const refocus = useRef<{ key: string; dir: 'up' | 'down' } | null>(null);

  const order = entries.filter((e) => e.enabled).map((e) => e.key);
  // Boot devices this editor cannot offer (USB, PCI passthrough, ...) are dropped on save.
  const candidateKeys = new Set(candidates.map((c) => c.key));
  const unmanaged = currentOrder.filter((key) => !candidateKeys.has(key));
  const baseline = currentOrder.filter((key) => candidateKeys.has(key));
  const changed = legacy || unmanaged.length > 0 || order.join(';') !== baseline.join(';');

  const serverError = mutation.isError
    ? hardwareErrorMessage(mutation.error, 'The boot order could not be updated.')
    : undefined;

  // A moved row is re-inserted in the DOM, which drops keyboard focus; put it back on the same
  // button (or its opposite, when the row reached the end of the list and that button disabled).
  useEffect(() => {
    const target = refocus.current;
    refocus.current = null;
    if (!target || !listRef.current) return;
    const find = (dir: 'up' | 'down') =>
      listRef.current?.querySelector<HTMLButtonElement>(`button[data-boot-move="${target.key}:${dir}"]:not(:disabled)`);
    (find(target.dir) ?? find(target.dir === 'up' ? 'down' : 'up'))?.focus();
  }, [entries]);

  function toggle(key: string, enabled: boolean) {
    setEntries((current) => {
      const item = current.find((e) => e.key === key);
      if (!item) return current;
      const rest = current.filter((e) => e.key !== key);
      const enabledCount = rest.filter((e) => e.enabled).length;
      const next = { ...item, enabled };
      // Keeps "enabled first": a newly enabled device joins the end of the enabled block, a newly
      // disabled one the start of the disabled block.
      return [...rest.slice(0, enabledCount), next, ...rest.slice(enabledCount)];
    });
  }

  function move(key: string, dir: 'up' | 'down') {
    refocus.current = { key, dir };
    setEntries((current) => {
      const index = current.findIndex((e) => e.key === key);
      const target = dir === 'up' ? index - 1 : index + 1;
      const other = current[target];
      if (index === -1 || !other || !other.enabled) return current;
      const next = [...current];
      [next[index], next[target]] = [next[target]!, next[index]!];
      return next;
    });
  }

  function submit() {
    if (!changed || mutation.isPending) return;
    mutation.mutate({ node, type, vmid, order }, { onSuccess: () => onOpenChange(false) });
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next && mutation.isPending) return;
        onOpenChange(next);
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Edit boot order</DialogTitle>
          <DialogDescription>
            The guest tries the ticked devices from top to bottom. Devices that are not ticked are not
            bootable. If the guest is running, PVE applies the change after its next restart.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-3">
          {entries.length === 0 ? (
            <p className="text-sm text-muted-foreground">This guest has no bootable devices.</p>
          ) : (
            <ul ref={listRef} className="flex flex-col gap-1.5" aria-label="Boot devices">
              {entries.map((entry, index) => {
                const enabledCount = entries.filter((e) => e.enabled).length;
                const id = `boot-${entry.key}`;
                return (
                  <li
                    key={entry.key}
                    data-testid="boot-candidate"
                    className="flex items-center gap-2 rounded-md border border-border px-2.5 py-1.5"
                  >
                    <Checkbox
                      id={id}
                      checked={entry.enabled}
                      onCheckedChange={(checked) => toggle(entry.key, checked === true)}
                      disabled={mutation.isPending}
                    />
                    <label htmlFor={id} className="min-w-0 flex-1 break-words text-sm">
                      {entry.label}
                    </label>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="size-7 shrink-0"
                      aria-label={`Move ${entry.key} up`}
                      data-boot-move={`${entry.key}:up`}
                      disabled={mutation.isPending || !entry.enabled || index === 0}
                      onClick={() => move(entry.key, 'up')}
                    >
                      <ArrowUp className="size-3.5" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="size-7 shrink-0"
                      aria-label={`Move ${entry.key} down`}
                      data-boot-move={`${entry.key}:down`}
                      disabled={mutation.isPending || !entry.enabled || index >= enabledCount - 1}
                      onClick={() => move(entry.key, 'down')}
                    >
                      <ArrowDown className="size-3.5" />
                    </Button>
                  </li>
                );
              })}
            </ul>
          )}

          {order.length === 0 && entries.length > 0 && (
            <p className="text-xs text-muted-foreground">
              No device ticked: the boot order is cleared and PVE uses its default.
            </p>
          )}
          {unmanaged.length > 0 && (
            <p className="text-xs text-muted-foreground">
              {unmanaged.join(', ')} can&apos;t be edited here and will be removed from the boot order when you
              save.
            </p>
          )}
          {legacy && (
            <p className="text-xs text-muted-foreground">
              This guest uses PVE&apos;s legacy boot setting; saving converts it to a device list.
            </p>
          )}
          {serverError && (
            <p role="alert" className="text-xs text-status-error">
              {serverError}
            </p>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" disabled={mutation.isPending} onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button disabled={!changed || mutation.isPending} onClick={submit}>
            {mutation.isPending && <Loader2 className="size-4 animate-spin" />}
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export interface BootOrderEditButtonProps {
  node: string;
  type: GuestType;
  vmid: number;
  config: GuestConfig;
}

/**
 * The Boot order row's pencil plus the dialog it opens. Self-contained (it owns its open state and
 * gate) so the Hardware tab only places it: enabled in a session (not service-token) sign-in with
 * `VM.Config.Options` on the guest; otherwise disabled with the standard tooltip. Renders nothing
 * for a container -- it has no boot order.
 */
export function BootOrderEditButton({ node, type, vmid, config }: BootOrderEditButtonProps) {
  const auth = useAuthMe();
  const permissions = usePermissions(vmid);
  const [open, setOpen] = useState(false);

  if (type !== 'qemu') return null;

  // Fixture/demo mode always demonstrates the enabled state, same as every other hardware pencil.
  const isSessionMode = USE_FIXTURES || auth.data?.mode === 'session';
  const privilege = 'VM.Config.Options';
  const disabledReason = !isSessionMode
    ? 'Read-only: signed in with a service token'
    : permissions.data?.can(privilege) !== true
      ? `You don't have ${privilege} on this guest`
      : undefined;
  const { order, legacy } = parseGuestBootOrder(config);

  return (
    <>
      <EditHardwareButton label="boot order" disabledReason={disabledReason} onClick={() => setOpen(true)} />
      {open && (
        <BootOrderDialog
          open
          onOpenChange={setOpen}
          node={node}
          type={type}
          vmid={vmid}
          candidates={listBootCandidates(config)}
          currentOrder={order}
          legacy={legacy}
        />
      )}
    </>
  );
}
