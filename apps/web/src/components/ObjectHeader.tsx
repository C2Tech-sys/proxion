import { useState, type ReactNode } from 'react';
import {
  ArrowRightLeft,
  Loader2,
  MoreHorizontal,
  Pause,
  Pencil,
  Play,
  Power,
  RotateCcw,
  RotateCw,
  Square,
} from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Breadcrumbs, type BreadcrumbItem } from '@/components/Breadcrumbs';
import { StatusDot } from '@/components/StatusDot';
import { TagChip } from '@/components/TagChip';
import { GuestActionDialog } from '@/components/actions/GuestActionDialog';
import { useGuestActionFlow } from '@/components/actions/useGuestActionFlow';
import { RenameGuestDialog } from '@/components/actions/RenameGuestDialog';
import { MigrateGuestDialog } from '@/components/actions/MigrateGuestDialog';
import { useAuthMe, useClusterResources } from '@/api/hooks';
import { usePermissions } from '@/api/actionHooks';
import { USE_FIXTURES } from '@/api/client';
import type { GuestType } from '@/api/types';
import { formatUptime } from '@/lib/format';
import { statusToColor } from '@/lib/status';
import { cn } from '@/lib/utils';

const STATUS_BADGE_CLASS: Record<ReturnType<typeof statusToColor>, string> = {
  running: 'border-status-running/40 bg-status-running/10 text-status-running',
  stopped: 'border-status-stopped/40 bg-status-stopped/10 text-status-stopped',
  paused: 'border-status-paused/40 bg-status-paused/10 text-status-paused',
  error: 'border-status-error/40 bg-status-error/10 text-status-error',
  template: 'border-status-template/40 bg-status-template/10 text-status-template',
  migrating: 'border-status-migrating/40 bg-status-migrating/10 text-status-migrating',
};

export interface ObjectHeaderProps {
  breadcrumb: BreadcrumbItem[];
  name: string;
  vmid?: number | undefined;
  status: string;
  template?: boolean | undefined;
  node: string;
  /** VM/CT quick actions render only when both `type` and `vmid` are given -- a node page (which
   * passes neither) gets no actions at all. */
  type?: GuestType | undefined;
  uptime?: number | undefined;
  tags?: string[] | undefined;
  extra?: ReactNode;
}

/** Shared header for node and VM/CT object pages. VM/CT pages get real quick actions, gated on a
 * signed-in session and the caller's own `VM.PowerMgmt`; node pages render none. */
export function ObjectHeader({
  breadcrumb,
  name,
  vmid,
  status,
  template,
  node,
  type,
  uptime,
  tags,
  extra,
}: ObjectHeaderProps) {
  const color = statusToColor(status, template);
  const label = template ? 'template' : status;
  const hasGuestTarget = type !== undefined && vmid !== undefined;

  return (
    <div className="flex flex-col gap-1 border-b border-border px-4 py-2.5">
      <Breadcrumbs items={breadcrumb} />
      <div className="flex items-center gap-2">
        <StatusDot status={status} template={template} />
        <h1 className="min-w-0 truncate font-display text-[26px] leading-tight font-light tracking-[var(--font-display-tracking)]">
          {name}
        </h1>
        {vmid !== undefined && (
          <span className="shrink-0 text-xs text-muted-foreground font-numeric">VMID {vmid}</span>
        )}
        <Badge variant="outline" className={cn('shrink-0', STATUS_BADGE_CLASS[color])}>
          {label}
        </Badge>

        <div className="ml-auto flex shrink-0 items-center gap-1">
          {extra}
          {hasGuestTarget && (
            <GuestQuickActions node={node} type={type} vmid={vmid} name={name} status={status} />
          )}
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-2 text-[13px] text-muted-foreground">
        <span>on {node}</span>
        {uptime !== undefined && uptime > 0 && <span className="font-numeric">up {formatUptime(uptime)}</span>}
        {tags?.map((tag) => <TagChip key={tag} tag={tag} />)}
      </div>
    </div>
  );
}

/** The VM/CT quick actions: Start/Shut down/Reboot/Pause/Resume as buttons, Stop/Reset in a
 * "More" menu, all sharing one confirmation dialog via `useGuestActionFlow`. */
function GuestQuickActions({
  node,
  type,
  vmid,
  name,
  status,
}: {
  node: string;
  type: GuestType;
  vmid: number;
  name: string;
  status: string;
}) {
  const auth = useAuthMe();
  const permissions = usePermissions(vmid);
  const clusterResources = useClusterResources();
  const flow = useGuestActionFlow({ node, type, vmid, name });
  const [renameOpen, setRenameOpen] = useState(false);
  const [migrateOpen, setMigrateOpen] = useState(false);

  // Fixture/demo mode has no real session concept (and nothing real to protect) -- it always
  // demonstrates the enabled state. A real deployment gates strictly on the caller's own
  // session + VM.PowerMgmt (or, for rename, VM.Config.Options; for migrate, VM.Migrate);
  // the server enforces all three independently of this client-side gate.
  const isSessionMode = USE_FIXTURES || auth.data?.mode === 'session';
  const hasPowerMgmt = permissions.data?.can('VM.PowerMgmt') === true;
  const hasConfigOptions = permissions.data?.can('VM.Config.Options') === true;
  const hasMigrate = permissions.data?.can('VM.Migrate') === true;
  const otherNodeCount = (clusterResources.data ?? []).filter((r) => r.type === 'node' && r.node !== node).length;
  const canWrite = isSessionMode && hasPowerMgmt;
  const canRename = isSessionMode && hasConfigOptions;
  const canMigrate = isSessionMode && hasMigrate && otherNodeCount > 0;
  const disabledReason = !isSessionMode
    ? 'Read-only: signed in with a service token'
    : !hasPowerMgmt
      ? "You don't have VM.PowerMgmt on this guest"
      : undefined;
  const renameDisabledReason = !isSessionMode
    ? 'Read-only: signed in with a service token'
    : !hasConfigOptions
      ? "You don't have VM.Config.Options on this guest"
      : undefined;
  const migrateDisabledReason = !isSessionMode
    ? 'Read-only: signed in with a service token'
    : !hasMigrate
      ? "You don't have VM.Migrate on this guest"
      : otherNodeCount === 0
        ? 'No other node to migrate to'
        : undefined;

  const running = status === 'running';
  const paused = status === 'paused';
  const stopped = !running && !paused;
  const pendingAction = flow.isPending ? flow.pendingAction : null;
  // Stop/Reset only make sense while the guest is running/paused.
  const showDestructiveActions = running || paused;
  // The "More" trigger itself is only disabled-as-a-whole for `!isSessionMode` -- token mode (or
  // no session) means *nothing* in the menu works, Rename included. Once there's a session, the
  // trigger is always enabled: Rename and Stop/Reset are gated on their own privilege
  // (VM.Config.Options vs VM.PowerMgmt) individually instead, since a caller can hold one without
  // the other -- the same per-item pattern the inventory tree's context menu already uses.
  const moreMenuDisabled = !isSessionMode;

  return (
    <>
      {stopped && (
        <ActionButton
          icon={Play}
          label="Start"
          disabledReason={canWrite ? undefined : disabledReason}
          isPending={pendingAction === 'start'}
          onClick={() => flow.request('start')}
        />
      )}
      {running && (
        <>
          <ActionButton
            icon={Power}
            label="Shut down"
            disabledReason={canWrite ? undefined : disabledReason}
            isPending={pendingAction === 'shutdown'}
            onClick={() => flow.request('shutdown')}
          />
          <ActionButton
            icon={RotateCw}
            label="Reboot"
            disabledReason={canWrite ? undefined : disabledReason}
            isPending={pendingAction === 'reboot'}
            onClick={() => flow.request('reboot')}
          />
        </>
      )}
      {type === 'qemu' && running && (
        <ActionButton
          icon={Pause}
          label="Pause"
          disabledReason={canWrite ? undefined : disabledReason}
          isPending={pendingAction === 'suspend'}
          onClick={() => flow.request('suspend')}
        />
      )}
      {type === 'qemu' && paused && (
        <ActionButton
          icon={Play}
          label="Resume"
          disabledReason={canWrite ? undefined : disabledReason}
          isPending={pendingAction === 'resume'}
          onClick={() => flow.request('resume')}
        />
      )}
      {moreMenuDisabled ? (
        <Tooltip>
          <TooltipTrigger asChild>
            <span tabIndex={0} className="inline-flex rounded-md focus-visible:ring-[3px] focus-visible:ring-ring/50">
              <Button
                variant="ghost"
                size="icon"
                disabled
                aria-disabled="true"
                aria-label="More actions"
                tabIndex={-1}
                className="pointer-events-none"
              >
                <MoreHorizontal className="size-4" />
              </Button>
            </span>
          </TooltipTrigger>
          <TooltipContent>{disabledReason}</TooltipContent>
        </Tooltip>
      ) : (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon" aria-label="More actions">
              {pendingAction === 'stop' || pendingAction === 'reset' ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <MoreHorizontal className="size-4" />
              )}
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem
              disabled={!canRename}
              title={canRename ? undefined : renameDisabledReason}
              onSelect={() => setRenameOpen(true)}
            >
              <Pencil /> Rename…
            </DropdownMenuItem>
            <DropdownMenuItem
              disabled={!canMigrate}
              title={canMigrate ? undefined : migrateDisabledReason}
              onSelect={() => setMigrateOpen(true)}
            >
              <ArrowRightLeft /> Migrate…
            </DropdownMenuItem>
            {showDestructiveActions && (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  variant="destructive"
                  disabled={!canWrite}
                  title={canWrite ? undefined : disabledReason}
                  onSelect={() => flow.request('stop')}
                >
                  <Square /> Stop
                </DropdownMenuItem>
                {type === 'qemu' && (
                  <DropdownMenuItem
                    variant="destructive"
                    disabled={!canWrite}
                    title={canWrite ? undefined : disabledReason}
                    onSelect={() => flow.request('reset')}
                  >
                    <RotateCcw /> Reset
                  </DropdownMenuItem>
                )}
              </>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      )}

      <GuestActionDialog
        key={flow.pendingAction ?? 'none'}
        action={flow.pendingAction}
        target={{ name, vmid, node }}
        isPending={flow.isPending}
        onCancel={flow.cancel}
        onConfirm={flow.confirm}
      />
      <RenameGuestDialog
        key={renameOpen ? 'open' : 'closed'}
        open={renameOpen}
        onOpenChange={setRenameOpen}
        node={node}
        type={type}
        vmid={vmid}
        currentName={name}
      />
      <MigrateGuestDialog
        key={migrateOpen ? 'open' : 'closed'}
        open={migrateOpen}
        onOpenChange={setMigrateOpen}
        node={node}
        type={type}
        vmid={vmid}
        name={name}
        status={status}
      />
    </>
  );
}

/**
 * One quick-action button. Enabled: a plain tooltip naming the action. Disabled (no session, or
 * missing VM.PowerMgmt): visibly and semantically disabled (`disabled` + `aria-disabled`), but
 * still reachable/hoverable via a wrapping trigger so its tooltip explains why. Pending: the
 * icon swaps for a spinner (the button stays enabled-looking but inert -- the dialog that
 * triggered it owns cancel/disable while its own mutation is in flight).
 */
function ActionButton({
  icon: Icon,
  label,
  disabledReason,
  isPending = false,
  onClick,
}: {
  icon: typeof Play;
  label: string;
  disabledReason?: string | undefined;
  isPending?: boolean;
  onClick: () => void;
}) {
  const disabled = disabledReason !== undefined;

  const button = (
    <Button
      variant="ghost"
      size="icon"
      disabled={disabled}
      aria-disabled={disabled || undefined}
      aria-label={label}
      tabIndex={disabled ? -1 : undefined}
      onClick={disabled ? undefined : onClick}
      className={disabled ? 'pointer-events-none' : undefined}
    >
      {isPending ? <Loader2 className="size-4 animate-spin" /> : <Icon className="size-4" />}
    </Button>
  );

  if (!disabled) {
    return (
      <Tooltip>
        <TooltipTrigger asChild>{button}</TooltipTrigger>
        <TooltipContent>{label}</TooltipContent>
      </Tooltip>
    );
  }

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span tabIndex={0} className="inline-flex rounded-md focus-visible:ring-[3px] focus-visible:ring-ring/50">
          {button}
        </span>
      </TooltipTrigger>
      <TooltipContent>{disabledReason}</TooltipContent>
    </Tooltip>
  );
}
