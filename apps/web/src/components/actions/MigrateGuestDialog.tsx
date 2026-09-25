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
import { GuestActionError, type MigrateGuestBody } from '@/api/actions';
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
}

/**
 * A guest migrate, in a plain `Dialog` (not `AlertDialog` -- this isn't a confirmation, it's a
 * form with real choices), following `RenameGuestDialog`/`SnapshotCreateDialog`'s own shape: a
 * target-node picker (other cluster nodes, offline ones disabled), the migrate precheck for the
 * currently-picked target (running state, local disks, local resources), and the qemu/lxc
 * options the precheck and the guest's own running state allow. Give this a `key` that changes
 * across opens (see `RenameGuestDialog`'s own doc comment) so a fresh open starts from a clean
 * target/option selection.
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

  const nodeOptions = useMemo<NodeOption[]>(() => {
    const rows = clusterResources.data ?? [];
    return rows
      .filter((r) => r.type === 'node' && r.node !== node)
      .map((r) => ({ node: r.node, online: r.status === 'online' }))
      .sort((a, b) => a.node.localeCompare(b.node));
  }, [clusterResources.data, node]);

  const firstOnline = nodeOptions.find((n) => n.online)?.node;
  const [targetOverride, setTargetOverride] = useState<string | undefined>(undefined);
  const target = targetOverride ?? firstOnline;

  const precheck = useMigratePrecheck(node, type, vmid, target);
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

  const notAllowedReason = target ? precheck.data?.notAllowedNodes[target] : undefined;

  function submit() {
    if (!target || mutation.isPending) return;
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
                  disabled={!option.online}
                  title={!option.online ? 'Node is offline' : undefined}
                >
                  {option.node}
                  {!option.online ? ' (offline)' : ''}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {notAllowedReason && (
            <p className="text-xs text-status-error">
              PVE reports this target isn't allowed
              {notAllowedReason.unavailableStorages.length > 0
                ? `: unavailable storage ${notAllowedReason.unavailableStorages.join(', ')}`
                : notAllowedReason.blockingHaResources.length > 0
                  ? `: blocked by HA resource ${notAllowedReason.blockingHaResources.join(', ')}`
                  : '.'}
            </p>
          )}
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
          <Button disabled={!target || mutation.isPending} onClick={submit}>
            {mutation.isPending && <Loader2 className="size-4 animate-spin" />}
            Migrate
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
