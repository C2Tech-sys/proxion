import { useMemo, useState } from 'react';
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
import { Checkbox } from '@/components/ui/checkbox';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { useClusterResources } from '@/api/hooks';
import { useMigrateGuest, useMigratePrecheck } from '@/api/actionHooks';
import { GuestActionError, type MigrateGuestBody, type MigratePrecheck } from '@/api/actions';
import type { GuestType } from '@/api/types';

export interface MigrateGuestDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  node: string;
  type: GuestType;
  vmid: number;
  name: string;
  status: string;
}

interface NodeOption {
  node: string;
  online: boolean;
  eligible: boolean;
  /** Why this node can't be picked -- shown as the item's secondary text and its `title`.
   * `undefined` when `eligible` is true. */
  reason: string | undefined;
}

/**
 * Whether `nodeName` can be migrated to, and why not when it can't -- offline first (PVE's own
 * precheck says nothing about a node that's down), then PVE's own precheck data: present in
 * `notAllowedNodes` (with whatever detail PVE gave -- unavailable storage, a blocking HA
 * resource, or neither), or, when PVE gave a non-empty `allowedNodes` allow-list at all, simply
 * absent from it. `precheck` is `undefined` while the cluster-wide precheck (see
 * `MigrateGuestDialog`'s own doc comment) hasn't resolved yet -- every node reads as ineligible
 * until it has, rather than defaulting to "allowed" on missing data.
 */
function nodeEligibility(
  nodeName: string,
  online: boolean,
  precheck: MigratePrecheck | undefined,
): { eligible: boolean; reason: string | undefined } {
  if (!online) return { eligible: false, reason: 'Offline' };
  if (!precheck) return { eligible: false, reason: 'Checking…' };

  const notAllowed = precheck.notAllowedNodes[nodeName];
  if (notAllowed) {
    if (notAllowed.unavailableStorages.length > 0) {
      return { eligible: false, reason: `Storage not available: ${notAllowed.unavailableStorages.join(', ')}` };
    }
    if (notAllowed.blockingHaResources.length > 0) {
      return { eligible: false, reason: `Blocked by HA: ${notAllowed.blockingHaResources.join(', ')}` };
    }
    return { eligible: false, reason: 'Not allowed by Proxmox' };
  }

  if (precheck.allowedNodes.length > 0 && !precheck.allowedNodes.includes(nodeName)) {
    return { eligible: false, reason: 'Not allowed by Proxmox' };
  }

  return { eligible: true, reason: undefined };
}

/**
 * A guest migrate, in a plain `Dialog` (not `AlertDialog` -- this isn't a confirmation, it's a
 * form with real choices), following `RenameGuestDialog`/`SnapshotCreateDialog`'s own shape: a
 * target-node picker and the qemu/lxc options the precheck and the guest's own running state
 * allow. Give this a `key` that changes across opens (see `RenameGuestDialog`'s own doc comment)
 * so a fresh open starts from a clean target/option selection -- since the component itself stays
 * mounted (just hidden) between opens otherwise (`ObjectHeader`/`GuestContextMenu` render it
 * unconditionally), that `key` is also what stops `useMigratePrecheck` below from firing a
 * precheck request for a dialog nobody has opened yet: `enabled` is wired to `open`.
 *
 * Node eligibility: `useMigratePrecheck` is queried once with no `target` at all as soon as the
 * dialog opens, so PVE's cluster-wide `allowedNodes`/`notAllowedNodes` are known before any
 * target is chosen -- every other node in the picker is disabled unless it's online AND not
 * excluded by that data (`nodeEligibility`), each showing its own reason as secondary text. The
 * default target is the first eligible node; if there isn't one, the target stays unset and the
 * confirm button is disabled with a "No eligible target node" note. Once a target is chosen (by
 * that default or by hand), the very same hook is re-queried WITH it (PVE's precheck refines
 * local-disk/storage detail once it knows the actual target) -- one hook, `target` just becomes
 * part of its query key, and `placeholderData` keeps showing the last known data while the new
 * query is in flight so the picker never flickers back to "everything unknown" mid-choice.
 *
 * qemu: an "Include local disks" checkbox when the precheck reports any (default checked), and
 * an "Online (live) migration" checkbox while the guest is running (default checked). lxc: a
 * running guest can't live-migrate -- there's no checkbox, `restart: true` is always sent, and a
 * fixed note explains why; a stopped guest sends nothing extra.
 */
export function MigrateGuestDialog({ open, onOpenChange, node, type, vmid, name, status }: MigrateGuestDialogProps) {
  const clusterResources = useClusterResources();
  const mutation = useMigrateGuest();
  const running = status === 'running';

  const nodeRows = useMemo(
    () => (clusterResources.data ?? []).filter((r) => r.type === 'node' && r.node !== node),
    [clusterResources.data, node],
  );

  const [targetOverride, setTargetOverride] = useState<string | undefined>(undefined);
  const target = targetOverride;

  // Queried with `target` as-is -- `undefined` on first open (the cluster-wide precheck), then
  // whatever node is chosen. `enabled: open` so a dialog nobody has opened yet (this component
  // stays mounted, just hidden, between opens -- see the doc comment above) never fires a request.
  const precheck = useMigratePrecheck(node, type, vmid, target, open);

  const nodeOptions = useMemo<NodeOption[]>(() => {
    return nodeRows
      .map((r) => {
        const online = r.status === 'online';
        const { eligible, reason } = nodeEligibility(r.node, online, precheck.data);
        return { node: r.node, online, eligible, reason };
      })
      .sort((a, b) => a.node.localeCompare(b.node));
  }, [nodeRows, precheck.data]);

  // Picks the default target -- the first eligible node -- as soon as the cluster-wide precheck
  // (queried with no target) resolves and nothing has been chosen yet. Adjusted directly during
  // render (React's own sanctioned pattern for "state derived from a prop/query", rather than a
  // `useEffect` with a `setState` in its body, which would just cost an extra commit+re-render
  // for the exact same result): React discards this render and immediately re-renders with the
  // new `targetOverride` before anything is ever shown. Never overrides an explicit (or
  // already-defaulted) choice -- once `targetOverride` is set, this whole branch is skipped.
  if (targetOverride === undefined && precheck.data) {
    const firstEligible = nodeOptions.find((o) => o.eligible);
    if (firstEligible) setTargetOverride(firstEligible.node);
  }

  const currentOption = target !== undefined ? nodeOptions.find((o) => o.node === target) : undefined;
  // Defence in depth: the picker itself should never let a not-allowed/offline node be selected,
  // but this is checked again here so confirm can never fire for one regardless.
  const targetEligible = currentOption?.eligible === true;
  const hasEligibleOption = nodeOptions.some((o) => o.eligible);
  const noEligibleTarget = precheck.data !== undefined && !hasEligibleOption;

  const hasLocalDisks = (precheck.data?.localDisks.length ?? 0) > 0;
  const localResources = precheck.data?.localResources ?? [];

  const [onlineOverride, setOnlineOverride] = useState<boolean | undefined>(undefined);
  const online = onlineOverride ?? true;
  const [withLocalDisksOverride, setWithLocalDisksOverride] = useState<boolean | undefined>(undefined);
  const withLocalDisks = withLocalDisksOverride ?? true;

  const serverError =
    mutation.isError && mutation.error instanceof GuestActionError
      ? mutation.error.message
      : mutation.isError
        ? 'The migration could not be started.'
        : undefined;

  function submit() {
    if (!target || !targetEligible || mutation.isPending) return;
    const body: MigrateGuestBody = { target };
    if (type === 'qemu') {
      if (running) body.online = online;
      if (hasLocalDisks) body.withLocalDisks = withLocalDisks;
    } else if (running) {
      body.restart = true;
    }
    mutation.mutate({ node, type, vmid, name, body }, { onSuccess: () => onOpenChange(false) });
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
          <DialogTitle>Migrate {name}</DialogTitle>
          <DialogDescription>Moves this guest to another node in the cluster.</DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-1.5">
          <label className="text-sm text-muted-foreground" htmlFor="migrate-target">
            Target node
          </label>
          <Select
            {...(target !== undefined ? { value: target } : {})}
            onValueChange={(value) => setTargetOverride(value)}
            disabled={mutation.isPending || nodeOptions.length === 0}
          >
            <SelectTrigger id="migrate-target" aria-label="Target node" className="w-full">
              <SelectValue placeholder="Choose a node" />
            </SelectTrigger>
            <SelectContent>
              {nodeOptions.map((option) => (
                <SelectItem
                  key={option.node}
                  value={option.node}
                  disabled={!option.eligible}
                  title={option.reason}
                >
                  <div className="flex flex-col">
                    <span>{option.node}</span>
                    {option.reason && <span className="text-xs text-muted-foreground">{option.reason}</span>}
                  </div>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {noEligibleTarget && <p className="text-xs text-status-error">No eligible target node</p>}
        </div>

        {type === 'qemu' && running && (
          <div className="flex items-center gap-2">
            <Checkbox
              id="migrate-online"
              checked={online}
              onCheckedChange={(checked) => setOnlineOverride(checked === true)}
              disabled={mutation.isPending}
            />
            <label htmlFor="migrate-online" className="text-sm">
              Online (live) migration
            </label>
          </div>
        )}

        {type === 'qemu' && hasLocalDisks && (
          <div className="flex items-center gap-2">
            <Checkbox
              id="migrate-local-disks"
              checked={withLocalDisks}
              onCheckedChange={(checked) => setWithLocalDisksOverride(checked === true)}
              disabled={mutation.isPending}
            />
            <label htmlFor="migrate-local-disks" className="text-sm">
              Migrate local disks
            </label>
          </div>
        )}

        {type === 'lxc' && running && (
          <p className="text-xs text-muted-foreground">
            Restart mode: the container is stopped, moved and started again.
          </p>
        )}

        {localResources.length > 0 && (
          <p className="text-xs text-status-paused">
            These local resources may block the migration: {localResources.join(', ')}
          </p>
        )}

        {serverError && <p className="text-xs text-status-error">{serverError}</p>}

        <DialogFooter>
          <Button variant="outline" disabled={mutation.isPending} onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button disabled={!target || !targetEligible || mutation.isPending} onClick={submit}>
            {mutation.isPending && <Loader2 className="size-4 animate-spin" />}
            Migrate
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
