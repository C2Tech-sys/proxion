import { useState, type ComponentType, type ReactNode } from 'react';
import { Loader2, RefreshCw } from 'lucide-react';

import { Table, TableBody, TableCell, TableRow } from '@/components/ui/table';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/EmptyState';
import { Skeleton } from '@/components/ui/skeleton';
import { EditHardwareButton } from '@/components/hardware/EditHardwareButton';
import { CloudInitPendingBanner } from '@/components/cloudinit/CloudInitPendingBanner';
import { CloudInitSettingDialog, type CloudInitSettingKind } from '@/components/cloudinit/CloudInitSettingDialog';
import { EditIpConfigDialog } from '@/components/cloudinit/EditIpConfigDialog';
import { useAuthMe, useVmConfig } from '@/api/hooks';
import { usePermissions } from '@/api/actionHooks';
import { useCloudInitPending, useRegenerateCloudInit } from '@/api/cloudInitHooks';
import { isCloudInitPending } from '@/api/cloudInit';
import { USE_FIXTURES } from '@/api/client';
import { errorMessage } from '@/api/errors';
import { decodeSshKeys, describeIpConfig, getNetSpecs, hasCloudInitDrive } from '@/lib/pve-config';
import type { VmTabProps } from '@/pages/vm/tabs';

const CLOUDINIT_PRIVILEGE = 'VM.Config.Cloudinit';

/** How many SSH keys the row lists before collapsing the rest into "+N more". */
const MAX_KEY_LINES = 3;

interface Row {
  label: string;
  value: ReactNode;
  /** The PVE config keys this row shows, so a pending change to one of them can badge the row. */
  keys: string[];
  /** The row's edit affordance (pencil). */
  action: ReactNode;
}

/** What an open edit dialog is editing. */
type EditTarget = { kind: CloudInitSettingKind } | { kind: 'ipconfig'; slot: string };

/** One public key, shortened for the row: `ssh-ed25519 AAAAC3NzaC1l…9GKJl admin@lab`. The full
 * key stays available as the tooltip. */
function shortKey(key: string): string {
  const [type = '', data = '', ...comment] = key.split(' ');
  const shortData = data.length > 24 ? `${data.slice(0, 12)}…${data.slice(-6)}` : data;
  return [type, shortData, comment.join(' ')].filter(Boolean).join(' ');
}

function sshKeysValue(keys: string[]): ReactNode {
  if (keys.length === 0) return <span className="text-muted-foreground">Not set</span>;
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-xs text-muted-foreground" data-testid="cloudinit-key-count">
        {keys.length} {keys.length === 1 ? 'key' : 'keys'}
      </span>
      {keys.slice(0, MAX_KEY_LINES).map((key, i) => (
        <span key={i} className="break-all font-mono text-xs" title={key}>
          {shortKey(key)}
        </span>
      ))}
      {keys.length > MAX_KEY_LINES && (
        <span className="text-xs text-muted-foreground">+{keys.length - MAX_KEY_LINES} more</span>
      )}
    </div>
  );
}

function plain(value: unknown, fallback: string): ReactNode {
  return typeof value === 'string' && value !== '' ? (
    value
  ) : (
    <span className="text-muted-foreground">{fallback}</span>
  );
}

/**
 * The VM Cloud-Init tab, modelled on PVE's own Cloud-Init panel (qemu only): user, password, DNS
 * domain and servers, SSH public keys, package upgrade, type and one IP config row per network
 * device, each with an edit pencil, plus a "Regenerate image" button. Derived from `useVmConfig`;
 * a guest with no cloud-init drive gets an empty state instead (adding the drive is a Hardware tab
 * job). While PVE holds cloud-init changes back until the image is regenerated, a banner lists them
 * and the affected rows are badged "pending".
 *
 * Every control is gated on session mode and `VM.Config.Cloudinit`; the server enforces both
 * independently. The password is never displayed -- only whether one is set.
 */
export const CloudInitTab: ComponentType<VmTabProps> = ({ node, vmid }) => {
  const { data: config, isLoading, isError, error } = useVmConfig(node, 'qemu', vmid);
  const auth = useAuthMe();
  const permissions = usePermissions(vmid);
  const cloudInit = useCloudInitPending(node, vmid);
  const regenerate = useRegenerateCloudInit();
  const [editing, setEditing] = useState<EditTarget | null>(null);

  // Fixture/demo mode has no real session concept -- it always demonstrates the enabled state.
  const isSessionMode = USE_FIXTURES || auth.data?.mode === 'session';
  const disabledReason = !isSessionMode
    ? 'Read-only: signed in with a service token'
    : permissions.data?.can(CLOUDINIT_PRIVILEGE) !== true
      ? `You don't have ${CLOUDINIT_PRIVILEGE} on this guest`
      : undefined;

  if (isLoading) {
    return (
      <div data-testid="cloudinit-tab">
        <Skeleton className="h-64" />
      </div>
    );
  }
  if (isError) {
    return (
      <div data-testid="cloudinit-tab">
        <EmptyState message={`Could not load configuration: ${errorMessage(error)}`} />
      </div>
    );
  }
  if (!config) {
    return (
      <div data-testid="cloudinit-tab">
        <EmptyState message="No configuration available." />
      </div>
    );
  }
  if (!hasCloudInitDrive(config)) {
    return (
      <div data-testid="cloudinit-tab">
        <EmptyState message="No Cloud-Init drive. Add one on the Hardware tab." />
      </div>
    );
  }

  const pencil = (label: string, target: EditTarget): ReactNode => (
    <EditHardwareButton label={label} disabledReason={disabledReason} onClick={() => setEditing(target)} />
  );

  const upgradeOn = config.ciupgrade === undefined || String(config.ciupgrade) !== '0';
  const sshKeys = decodeSshKeys(config.sshkeys);

  const rows: Row[] = [
    {
      label: 'User',
      value: plain(config.ciuser, 'Not set'),
      keys: ['ciuser'],
      action: pencil('user', { kind: 'user' }),
    },
    {
      label: 'Password',
      value: config.cipassword !== undefined ? (
        <span data-testid="cloudinit-password">••••••</span>
      ) : (
        <span className="text-muted-foreground" data-testid="cloudinit-password">
          Not set
        </span>
      ),
      keys: ['cipassword'],
      action: pencil('password', { kind: 'password' }),
    },
    {
      label: 'DNS domain',
      value: plain(config.searchdomain, 'Use host settings'),
      keys: ['searchdomain'],
      action: pencil('DNS domain', { kind: 'searchdomain' }),
    },
    {
      label: 'DNS servers',
      value: plain(config.nameserver, 'Use host settings'),
      keys: ['nameserver'],
      action: pencil('DNS servers', { kind: 'nameserver' }),
    },
    {
      label: 'SSH public keys',
      value: sshKeysValue(sshKeys),
      keys: ['sshkeys'],
      action: pencil('SSH public keys', { kind: 'sshKeys' }),
    },
    {
      label: 'Upgrade packages',
      value: upgradeOn ? 'Yes' : 'No',
      keys: ['ciupgrade'],
      action: pencil('upgrade packages', { kind: 'upgrade' }),
    },
    {
      label: 'Type',
      value: plain(config.citype, 'Default'),
      keys: ['citype'],
      action: pencil('type', { kind: 'type' }),
    },
  ];
  for (const net of getNetSpecs(config)) {
    const ipKey = `ipconfig${net.index}`;
    const described = describeIpConfig(config[ipKey]);
    rows.push({
      label: `IP Config (${net.key})`,
      value:
        described === 'Not configured' ? <span className="text-muted-foreground">{described}</span> : described,
      keys: [ipKey],
      action: pencil(`IP config ${net.key}`, { kind: 'ipconfig', slot: net.key }),
    });
  }

  const pendingKeys = (cloudInit.data ?? []).filter(isCloudInitPending).map((entry) => entry.key);
  const closeDialog = (open: boolean) => {
    if (!open) setEditing(null);
  };

  return (
    <div data-testid="cloudinit-tab">
      <CloudInitPendingBanner keys={pendingKeys} />
      <div className="mb-3 flex items-center justify-between gap-3">
        <p className="text-sm text-muted-foreground">
          Settings cloud-init applies to the guest from its Cloud-Init drive.
        </p>
        <Button
          variant="outline"
          size="sm"
          className="shrink-0"
          disabled={disabledReason !== undefined || regenerate.isPending}
          aria-disabled={disabledReason !== undefined || undefined}
          title={disabledReason}
          onClick={() => regenerate.mutate({ node, vmid })}
        >
          {regenerate.isPending ? <Loader2 className="size-3.5 animate-spin" /> : <RefreshCw className="size-3.5" />}
          Regenerate image
        </Button>
      </div>

      <div className="rounded-lg border border-border">
        <Table>
          <TableBody>
            {rows.map((row) => {
              const isPending = row.keys.some((k) => pendingKeys.includes(k));
              return (
                <TableRow key={row.label}>
                  <TableCell className="w-56 shrink-0 align-top text-muted-foreground">{row.label}</TableCell>
                  <TableCell className="align-top">
                    <div className="flex items-start justify-between gap-2">
                      <div className="flex min-w-0 flex-wrap items-center gap-2">
                        <div className="min-w-0">{row.value}</div>
                        {isPending && (
                          <Badge variant="outline" data-testid="cloudinit-pending-badge">
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

      {editing !== null && editing.kind !== 'ipconfig' && (
        <CloudInitSettingDialog
          open
          onOpenChange={closeDialog}
          node={node}
          vmid={vmid}
          kind={editing.kind}
          config={config}
        />
      )}
      {editing?.kind === 'ipconfig' && (
        <EditIpConfigDialog
          open
          onOpenChange={closeDialog}
          node={node}
          vmid={vmid}
          slot={editing.slot}
          current={
            typeof config[`ipconfig${editing.slot.slice(3)}`] === 'string'
              ? String(config[`ipconfig${editing.slot.slice(3)}`])
              : undefined
          }
        />
      )}
    </div>
  );
};

export default CloudInitTab;
