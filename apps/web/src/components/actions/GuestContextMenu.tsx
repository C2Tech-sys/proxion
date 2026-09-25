import { useState, type ReactNode } from 'react';
import { Link } from '@tanstack/react-router';
import { ArrowRightLeft, Copy, ExternalLink, Pencil, Power, RotateCw, Square, TvMinimal } from 'lucide-react';
import { toast } from 'sonner';

import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from '@/components/ui/context-menu';
import { GuestActionDialog } from '@/components/actions/GuestActionDialog';
import { useGuestActionFlow } from '@/components/actions/useGuestActionFlow';
import { RenameGuestDialog } from '@/components/actions/RenameGuestDialog';
import { MigrateGuestDialog } from '@/components/actions/MigrateGuestDialog';
import { useAuthMe, useClusterResources } from '@/api/hooks';
import { usePermissions } from '@/api/actionHooks';
import { USE_FIXTURES } from '@/api/client';
import type { GuestType } from '@/api/types';

/** Copies a value to the clipboard with a toast. Not exported (kept module-private, like
 *  `TasksTable.tsx`'s own small helpers) so this file only exports the component -- React Fast
 *  Refresh's lint rule flags a file that exports both; `InventoryTree.tsx`'s `NodeRow` keeps its
 *  own copy for the same "Copy name" action on a node row. */
function copyToClipboard(value: string, label: string) {
  navigator.clipboard
    ?.writeText(value)
    .then(() => toast.success(`Copied ${label}`))
    .catch(() => toast.error(`Could not copy ${label}`));
}

/** Whether the caller may run guest power actions at all: a signed-in session (or fixture/demo
 * mode, which has no real session concept -- see `ObjectHeader.tsx`'s own copy of this rule)
 * holding `VM.PowerMgmt` on this specific guest. */
function useCanRunGuestActions(vmid: number): { canWrite: boolean; disabledReason: string } {
  const auth = useAuthMe();
  const permissions = usePermissions(vmid);
  const isSessionMode = USE_FIXTURES || auth.data?.mode === 'session';
  const hasPowerMgmt = permissions.data?.can('VM.PowerMgmt') === true;
  return {
    canWrite: isSessionMode && hasPowerMgmt,
    disabledReason: !isSessionMode
      ? 'Read-only: signed in with a service token'
      : "You don't have VM.PowerMgmt on this guest",
  };
}

/** Same shape as `useCanRunGuestActions`, gated on `VM.Config.Options` instead -- the privilege
 * "Rename…" needs, independent of `VM.PowerMgmt`. */
function useCanConfigureGuest(vmid: number): { canRename: boolean; disabledReason: string } {
  const auth = useAuthMe();
  const permissions = usePermissions(vmid);
  const isSessionMode = USE_FIXTURES || auth.data?.mode === 'session';
  const hasConfigOptions = permissions.data?.can('VM.Config.Options') === true;
  return {
    canRename: isSessionMode && hasConfigOptions,
    disabledReason: !isSessionMode
      ? 'Read-only: signed in with a service token'
      : "You don't have VM.Config.Options on this guest",
  };
}

/** Same shape as `useCanRunGuestActions`/`useCanConfigureGuest`, gated on `VM.Migrate` and on the
 * cluster actually having another node to migrate to -- a single-node cluster can never satisfy
 * migrate regardless of privilege, so that's reported as its own disabled reason. */
function useCanMigrateGuest(vmid: number, node: string): { canMigrate: boolean; disabledReason: string } {
  const auth = useAuthMe();
  const permissions = usePermissions(vmid);
  const clusterResources = useClusterResources();
  const isSessionMode = USE_FIXTURES || auth.data?.mode === 'session';
  const hasMigrate = permissions.data?.can('VM.Migrate') === true;
  const otherNodeCount = (clusterResources.data ?? []).filter((r) => r.type === 'node' && r.node !== node).length;
  return {
    canMigrate: isSessionMode && hasMigrate && otherNodeCount > 0,
    disabledReason: !isSessionMode
      ? 'Read-only: signed in with a service token'
      : !hasMigrate
        ? "You don't have VM.Migrate on this guest"
        : 'No other node to migrate to',
  };
}

export interface GuestContextMenuTarget {
  node: string;
  type: GuestType;
  vmid: number;
  name: string;
  status: string;
}

export interface GuestContextMenuProps {
  guest: GuestContextMenuTarget;
  children: ReactNode;
}

/**
 * One guest's right-click menu (Open, Open console, Copy VMID/name, Rename…, and the
 * status-gated power actions), shared by the inventory rail (`InventoryTree.tsx`) and the
 * Guests table (`pages/guests/GuestsPage.tsx`) so both surfaces offer the exact same actions,
 * gated the exact same way. Wraps `children` (the row) as the trigger -- `children` must be a
 * single element that accepts a ref (a `Link`, a native `<tr>`/`<div>`, ...), same requirement
 * Radix's `ContextMenuTrigger asChild` always has.
 */
export function GuestContextMenu({ guest, children }: GuestContextMenuProps) {
  const { canWrite, disabledReason } = useCanRunGuestActions(guest.vmid);
  const { canRename, disabledReason: renameDisabledReason } = useCanConfigureGuest(guest.vmid);
  const { canMigrate, disabledReason: migrateDisabledReason } = useCanMigrateGuest(guest.vmid, guest.node);
  const flow = useGuestActionFlow({ node: guest.node, type: guest.type, vmid: guest.vmid, name: guest.name });
  const [renameOpen, setRenameOpen] = useState(false);
  const [migrateOpen, setMigrateOpen] = useState(false);
  const running = guest.status === 'running';
  const stopped = !running && guest.status !== 'paused';

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>{children}</ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuItem asChild>
          <Link
            to="/vm/$node/$type/$vmid"
            params={{ node: guest.node, type: guest.type, vmid: String(guest.vmid) }}
            search={{ tab: 'summary' }}
          >
            <ExternalLink /> Open
          </Link>
        </ContextMenuItem>
        <ContextMenuItem asChild>
          <Link
            to="/vm/$node/$type/$vmid"
            params={{ node: guest.node, type: guest.type, vmid: String(guest.vmid) }}
            search={{ tab: 'console' }}
          >
            <TvMinimal /> Open console
          </Link>
        </ContextMenuItem>
        <ContextMenuItem onSelect={() => copyToClipboard(String(guest.vmid), 'VMID')}>
          <Copy /> Copy VMID
        </ContextMenuItem>
        <ContextMenuItem onSelect={() => copyToClipboard(guest.name, 'name')}>
          <Copy /> Copy name
        </ContextMenuItem>
        <ContextMenuItem
          disabled={!canRename}
          title={canRename ? undefined : renameDisabledReason}
          onSelect={() => setRenameOpen(true)}
        >
          <Pencil /> Rename…
        </ContextMenuItem>
        <ContextMenuItem
          disabled={!canMigrate}
          title={canMigrate ? undefined : migrateDisabledReason}
          onSelect={() => setMigrateOpen(true)}
        >
          <ArrowRightLeft /> Migrate…
        </ContextMenuItem>
        <ContextMenuSeparator />
        {stopped && (
          <ContextMenuItem
            disabled={!canWrite}
            title={canWrite ? undefined : disabledReason}
            onSelect={() => flow.request('start')}
          >
            <Power /> Start
          </ContextMenuItem>
        )}
        {running && (
          <>
            <ContextMenuItem
              disabled={!canWrite}
              title={canWrite ? undefined : disabledReason}
              onSelect={() => flow.request('shutdown')}
            >
              <Power /> Shut down
            </ContextMenuItem>
            <ContextMenuItem
              disabled={!canWrite}
              title={canWrite ? undefined : disabledReason}
              onSelect={() => flow.request('reboot')}
            >
              <RotateCw /> Reboot
            </ContextMenuItem>
            <ContextMenuItem
              variant="destructive"
              disabled={!canWrite}
              title={canWrite ? undefined : disabledReason}
              onSelect={() => flow.request('stop')}
            >
              <Square /> Stop
            </ContextMenuItem>
          </>
        )}
      </ContextMenuContent>
      <GuestActionDialog
        key={flow.pendingAction ?? 'none'}
        action={flow.pendingAction}
        target={{ name: guest.name, vmid: guest.vmid, node: guest.node }}
        isPending={flow.isPending}
        onCancel={flow.cancel}
        onConfirm={flow.confirm}
      />
      <RenameGuestDialog
        key={renameOpen ? 'open' : 'closed'}
        open={renameOpen}
        onOpenChange={setRenameOpen}
        node={guest.node}
        type={guest.type}
        vmid={guest.vmid}
        currentName={guest.name}
      />
      <MigrateGuestDialog
        key={migrateOpen ? 'open' : 'closed'}
        open={migrateOpen}
        onOpenChange={setMigrateOpen}
        node={guest.node}
        type={guest.type}
        vmid={guest.vmid}
        name={guest.name}
        status={guest.status}
      />
    </ContextMenu>
  );
}
