import { useState, type ComponentType, type ReactNode } from 'react';

import { Table, TableBody, TableCell, TableRow } from '@/components/ui/table';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { EmptyState } from '@/components/EmptyState';
import { TagChip } from '@/components/TagChip';
import { EditHardwareButton } from '@/components/hardware/EditHardwareButton';
import { PendingBanner } from '@/components/hardware/PendingBanner';
import { RenameGuestDialog } from '@/components/actions/RenameGuestDialog';
import { EditOptionDialog } from '@/components/options/EditOptionDialog';
import {
  HOTPLUG_LABELS,
  OPTION_FIELDS,
  osTypeOptionLabel,
  type OptionFieldId,
} from '@/components/options/optionFields';
import { useAuthMe, useVmConfig } from '@/api/hooks';
import { usePermissions } from '@/api/actionHooks';
import { usePendingConfig } from '@/api/hardwareHooks';
import { isPendingEntry } from '@/api/hardware';
import { USE_FIXTURES } from '@/api/client';
import { errorMessage } from '@/api/errors';
import { parseGuestOptions } from '@/lib/pve-config';
import type { GuestConfig, GuestType } from '@/api/types';
import type { VmTabProps } from '@/pages/vm/tabs';

interface Row {
  label: string;
  value: ReactNode;
  /** The PVE config keys this row shows, so a pending change to one of them can badge the row. */
  keys?: string[];
  /** The row's edit affordance (pencil), when it has one. */
  action?: ReactNode;
}

/** What an open edit dialog is editing: the rename dialog (Name / Hostname) or one generic option. */
type EditTarget = { kind: 'rename' } | { kind: 'option'; field: OptionFieldId };

const muted = (text: string): ReactNode => <span className="text-muted-foreground">{text}</span>;

/** A config flag (`1`, `"1"`, `on`, `true`); `fallback` when the key is absent. */
function flag(raw: string | number | undefined, fallback: boolean): boolean {
  if (raw === undefined) return fallback;
  return ['1', 'on', 'true', 'yes'].includes(String(raw).toLowerCase());
}

const yesNo = (value: boolean): string => (value ? 'Yes' : 'No');

function startupValue(config: GuestConfig, type: GuestType): ReactNode {
  const startup = parseGuestOptions(config, type).startup;
  if (startup === undefined) return muted('Default (any)');
  const parts = [
    startup.order !== undefined ? `order=${startup.order}` : null,
    startup.up !== undefined ? `up=${startup.up}` : null,
    startup.down !== undefined ? `down=${startup.down}` : null,
  ].filter((p) => p !== null);
  return parts.join(', ');
}

function tagsValue(config: GuestConfig, type: GuestType): ReactNode {
  const tags = parseGuestOptions(config, type).tags;
  if (tags.length === 0) return muted('No tags');
  return (
    <span className="inline-flex flex-wrap items-center gap-1" data-testid="options-tags">
      {tags.map((tag) => (
        <TagChip key={tag} tag={tag} />
      ))}
    </span>
  );
}

function agentValue(config: GuestConfig, type: GuestType): ReactNode {
  const agent = parseGuestOptions(config, type).agent;
  if (!agent?.enabled) return 'Disabled';
  return agent.fstrimClonedDisks ? 'Enabled (trim cloned disks)' : 'Enabled';
}

function hotplugValue(config: GuestConfig, type: GuestType): ReactNode {
  const { hotplug, hotplugIsDefault } = parseGuestOptions(config, type);
  if (hotplug === undefined) return null;
  const list = hotplug.length === 0 ? 'Disabled' : hotplug.map((item) => HOTPLUG_LABELS[item]).join(', ');
  return hotplugIsDefault ? `${list} (default)` : list;
}

function localtimeValue(config: GuestConfig): ReactNode {
  if (config.localtime === undefined) return muted('Default (based on the OS type)');
  return yesNo(flag(config.localtime, false));
}

function nameserverValue(config: GuestConfig, type: GuestType): ReactNode {
  const servers = parseGuestOptions(config, type).nameserver;
  return servers.length === 0 ? muted('Use host settings') : servers.join(', ');
}

function searchdomainValue(config: GuestConfig, type: GuestType): ReactNode {
  return parseGuestOptions(config, type).searchdomain ?? muted('Use host settings');
}

/** Builds one row's pencil, already gated on session mode and the privilege it needs. */
type ActionFor = (label: string, privilege: string, target: EditTarget) => ReactNode;

function optionRow(
  id: OptionFieldId,
  type: GuestType,
  value: ReactNode,
  actionFor: ActionFor,
): Row {
  const field = OPTION_FIELDS[id];
  const privilege = field.privilege[type] ?? 'VM.Config.Options';
  return {
    label: field.label,
    value,
    keys: field.keys,
    action: actionFor(field.label, privilege, { kind: 'option', field: id }),
  };
}

function qemuRows(config: GuestConfig, actionFor: ActionFor): Row[] {
  const type: GuestType = 'qemu';
  return [
    {
      label: 'Name',
      value: config.name ?? muted('-'),
      keys: ['name'],
      // The existing rename action (PATCH .../config) is reused for this row; it needs
      // VM.Config.Options.
      action: actionFor('Name', 'VM.Config.Options', { kind: 'rename' }),
    },
    optionRow('onboot', type, yesNo(flag(config.onboot, false)), actionFor),
    optionRow('startup', type, startupValue(config, type), actionFor),
    optionRow('ostype', type, osTypeOptionLabel(config.ostype), actionFor),
    optionRow('protection', type, yesNo(flag(config.protection, false)), actionFor),
    optionRow('tags', type, tagsValue(config, type), actionFor),
    optionRow('agent', type, agentValue(config, type), actionFor),
    optionRow('localtime', type, localtimeValue(config), actionFor),
    optionRow('tablet', type, yesNo(flag(config.tablet, true)), actionFor),
    optionRow('acpi', type, yesNo(flag(config.acpi, true)), actionFor),
    optionRow('kvm', type, yesNo(flag(config.kvm, true)), actionFor),
    optionRow('hotplug', type, hotplugValue(config, type), actionFor),
  ];
}

function lxcRows(config: GuestConfig, actionFor: ActionFor): Row[] {
  const type: GuestType = 'lxc';
  return [
    {
      label: 'Hostname',
      value: config.hostname ?? muted('-'),
      keys: ['hostname'],
      action: actionFor('Hostname', 'VM.Config.Options', { kind: 'rename' }),
    },
    optionRow('onboot', type, yesNo(flag(config.onboot, false)), actionFor),
    optionRow('startup', type, startupValue(config, type), actionFor),
    optionRow('protection', type, yesNo(flag(config.protection, false)), actionFor),
    optionRow('tags', type, tagsValue(config, type), actionFor),
    optionRow('nameserver', type, nameserverValue(config, type), actionFor),
    optionRow('searchdomain', type, searchdomainValue(config, type), actionFor),
    { label: 'Unprivileged container', value: yesNo(flag(config.unprivileged, false)), keys: ['unprivileged'] },
    {
      label: 'Architecture',
      value: typeof config.arch === 'string' ? config.arch : muted('amd64 (default)'),
      keys: ['arch'],
    },
  ];
}

/**
 * The Options tab, modelled on PVE's own Options panel (qemu and lxc): a label / value / pencil row
 * list derived entirely from `useVmConfig`. In a session (not service-token) sign-in, every row the
 * caller may change carries a pencil that opens one small dialog (`EditOptionDialog`, driven by the
 * row's descriptor in `optionFields.ts`), gated on session mode and the PVE privilege that edit
 * needs; the server enforces both independently. The Name/Hostname row reuses the existing rename
 * action and `RenameGuestDialog` instead of the options route. While PVE holds changes back until
 * the guest restarts, a banner lists them and the affected rows are badged "pending".
 */
export const OptionsTab: ComponentType<VmTabProps> = ({ node, type, vmid }) => {
  const { data: config, isLoading, isError, error } = useVmConfig(node, type, vmid);
  const auth = useAuthMe();
  const permissions = usePermissions(vmid);
  const pending = usePendingConfig(node, type, vmid);
  const [editing, setEditing] = useState<EditTarget | null>(null);

  // Fixture/demo mode has no real session concept -- it always demonstrates the enabled state,
  // same as the Hardware tab.
  const isSessionMode = USE_FIXTURES || auth.data?.mode === 'session';

  const actionFor: ActionFor = (label, privilege, target) => {
    const disabledReason = !isSessionMode
      ? 'Read-only: signed in with a service token'
      : permissions.data?.can(privilege) !== true
        ? `You don't have ${privilege} on this guest`
        : undefined;
    return <EditHardwareButton label={label} disabledReason={disabledReason} onClick={() => setEditing(target)} />;
  };

  if (isLoading) {
    return <Skeleton className="h-64" data-testid="options-tab" />;
  }
  if (isError) {
    return <EmptyState message={`Could not load configuration: ${errorMessage(error)}`} />;
  }
  if (!config) {
    return <EmptyState message="No configuration available." />;
  }

  const rows = type === 'qemu' ? qemuRows(config, actionFor) : lxcRows(config, actionFor);
  const pendingKeys = (pending.data ?? []).filter(isPendingEntry).map((entry) => entry.key);
  const closeDialog = (open: boolean) => {
    if (!open) setEditing(null);
  };

  return (
    <div data-testid="options-tab">
      <PendingBanner keys={pendingKeys} />
      <div className="rounded-lg border border-border">
        <Table>
          <TableBody>
            {rows.map((row) => {
              const isPending = row.keys?.some((k) => pendingKeys.includes(k)) ?? false;
              return (
                <TableRow key={row.label}>
                  <TableCell className="w-56 shrink-0 align-top text-muted-foreground">{row.label}</TableCell>
                  <TableCell className="align-top">
                    <div className="flex items-start justify-between gap-2">
                      <div className="flex min-w-0 flex-wrap items-center gap-2">
                        <div className="min-w-0" data-testid="options-value">
                          {row.value}
                        </div>
                        {isPending && (
                          <Badge variant="outline" data-testid="options-pending-badge">
                            pending
                          </Badge>
                        )}
                      </div>
                      {row.action}
                    </div>
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </div>

      {editing?.kind === 'rename' && (
        <RenameGuestDialog
          open
          onOpenChange={closeDialog}
          node={node}
          type={type}
          vmid={vmid}
          currentName={(type === 'qemu' ? config.name : config.hostname) ?? ''}
        />
      )}
      {editing?.kind === 'option' && (
        <EditOptionDialog
          open
          onOpenChange={closeDialog}
          node={node}
          type={type}
          vmid={vmid}
          field={OPTION_FIELDS[editing.field]}
          config={config}
        />
      )}
    </div>
  );
};

export default OptionsTab;
