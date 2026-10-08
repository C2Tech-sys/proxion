import { useMemo, useState } from 'react';
import { ChevronDown, Trash2 } from 'lucide-react';

import { EmptyState } from '@/components/EmptyState';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { EditHardwareButton } from '@/components/hardware/EditHardwareButton';
import { NetIfaceDialog } from '@/components/nodenetwork/NetIfaceDialog';
import { NET_KIND_LABEL, type NetCreateKind, type NetIfaceDialogMode } from '@/components/nodenetwork/netKinds';
import { ApplyNetworkDialog, DeleteNetIfaceDialog } from '@/components/nodenetwork/NetConfirmDialogs';
import { PendingChangesBanner } from '@/components/nodenetwork/PendingChangesBanner';
import { useAuthMe } from '@/api/hooks';
import { useNodePermissions } from '@/api/actionHooks';
import { USE_FIXTURES } from '@/api/client';
import { errorMessage } from '@/api/errors';
import { useNodeNetworkConfig } from '@/api/nodeNetworkHooks';
import { sortNodeNetIfaces, type NodeNetIface, type NodeNetType } from '@/api/nodeNetwork';
import type { NodeTabProps } from '@/pages/node/tabs';

const TYPE_LABEL: Record<NodeNetType, string> = {
  eth: 'Network Device',
  bridge: 'Linux Bridge',
  bond: 'Linux Bond',
  vlan: 'Linux VLAN',
  alias: 'IP Alias',
  other: 'Other',
};

/** The types this editor can edit; an alias or an OVS/SDN interface is shown read-only. */
const EDITABLE: readonly NodeNetType[] = ['eth', 'bridge', 'bond', 'vlan'];
/** The types that can be deleted (a physical interface cannot). */
const DELETABLE: readonly NodeNetType[] = ['bridge', 'bond', 'vlan'];

const NETWORK_PRIVILEGE = 'Sys.Modify';

function yesNo(value: boolean): string {
  return value ? 'Yes' : 'No';
}

function DeleteIfaceButton({
  iface,
  disabledReason,
  onClick,
}: {
  iface: string;
  disabledReason?: string | undefined;
  onClick: () => void;
}) {
  const name = `Delete ${iface}`;
  if (disabledReason !== undefined) {
    return (
      <Button
        variant="ghost"
        size="icon"
        className="size-7 shrink-0"
        disabled
        aria-disabled="true"
        aria-label={name}
        title={disabledReason}
      >
        <Trash2 className="size-3.5" />
      </Button>
    );
  }
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className="size-7 shrink-0 text-destructive hover:text-destructive"
          aria-label={name}
          onClick={onClick}
        >
          <Trash2 className="size-3.5" />
        </Button>
      </TooltipTrigger>
      <TooltipContent>{name}</TooltipContent>
    </Tooltip>
  );
}

/**
 * Node -> Network (T69): PVE's System -> Network panel. Lists the node's interfaces, creates /
 * edits / deletes bridges, bonds and VLANs, edits a physical interface's addressing, and shows the
 * staged ("pending") changes with Apply / Revert. Every edit is only staged by PVE; Apply is the
 * step that touches the live network, so it asks for a typed confirmation that spells out the
 * lock-out risk. Writes are gated on a signed-in session and `Sys.Modify` on the node (the server
 * enforces both independently).
 */
export function NetworkTab({ node }: NodeTabProps) {
  const network = useNodeNetworkConfig(node);
  const auth = useAuthMe();
  const permissions = useNodePermissions(node);
  const [dialog, setDialog] = useState<NetIfaceDialogMode | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [applying, setApplying] = useState(false);

  const ifaces = useMemo(() => sortNodeNetIfaces(network.data?.ifaces ?? []), [network.data]);

  // Fixture/demo mode has no real session concept -- it always demonstrates the enabled state.
  const isSessionMode = USE_FIXTURES || auth.data?.mode === 'session';
  const hasPrivilege = permissions.data?.can(NETWORK_PRIVILEGE) === true;
  const disabledReason = !isSessionMode
    ? 'Read-only: signed in with a service token'
    : !hasPrivilege
      ? `You don't have ${NETWORK_PRIVILEGE} on this node`
      : undefined;
  const canWrite = disabledReason === undefined;

  return (
    <div data-testid="node-network-tab" className="flex flex-col gap-3">
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-sm font-medium text-muted-foreground">Network interfaces on {node}</h2>
        {canWrite ? (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" size="sm" className="gap-1.5 text-xs">
                Create <ChevronDown className="size-3.5" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              {(['bridge', 'bond', 'vlan'] as const).map((kind: NetCreateKind) => (
                <DropdownMenuItem key={kind} onSelect={() => setDialog({ kind: 'create', type: kind })}>
                  {NET_KIND_LABEL[kind]}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        ) : (
          <Button
            variant="outline"
            size="sm"
            className="gap-1.5 text-xs"
            disabled
            aria-disabled="true"
            title={disabledReason}
          >
            Create <ChevronDown className="size-3.5" />
          </Button>
        )}
      </div>

      {network.data && (
        <PendingChangesBanner
          node={node}
          changes={network.data.changes}
          disabledReason={disabledReason}
          onApply={() => setApplying(true)}
        />
      )}

      {network.isLoading ? (
        <Skeleton className="h-64" />
      ) : network.isError ? (
        <EmptyState message={`Could not load the network configuration: ${errorMessage(network.error)}`} />
      ) : ifaces.length === 0 ? (
        <EmptyState message="No network interfaces on this node." />
      ) : (
        <div className="overflow-x-auto rounded-lg border border-border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>Type</TableHead>
                <TableHead>Active</TableHead>
                <TableHead>Autostart</TableHead>
                <TableHead>VLAN aware</TableHead>
                <TableHead>Ports/Slaves</TableHead>
                <TableHead>Bond mode</TableHead>
                <TableHead>CIDR</TableHead>
                <TableHead>Gateway</TableHead>
                <TableHead>IPv6 CIDR</TableHead>
                <TableHead>MTU</TableHead>
                <TableHead>Comment</TableHead>
                <TableHead className="w-20">
                  <span className="sr-only">Actions</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {ifaces.map((row: NodeNetIface) => (
                <TableRow key={row.iface} data-testid={`node-network-row-${row.iface}`}>
                  <TableCell className="font-medium">{row.iface}</TableCell>
                  <TableCell>{TYPE_LABEL[row.type]}</TableCell>
                  <TableCell>{yesNo(row.active)}</TableCell>
                  <TableCell>{yesNo(row.autostart)}</TableCell>
                  <TableCell>{row.type === 'bridge' ? yesNo(row.vlanAware) : ''}</TableCell>
                  <TableCell>{row.bridgePorts ?? row.slaves ?? ''}</TableCell>
                  <TableCell>{row.bondMode ?? ''}</TableCell>
                  <TableCell>{row.cidr ?? ''}</TableCell>
                  <TableCell>{row.gateway ?? ''}</TableCell>
                  <TableCell>{row.cidr6 ?? ''}</TableCell>
                  <TableCell>{row.mtu ?? ''}</TableCell>
                  <TableCell className="max-w-48 truncate" title={row.comments}>
                    {row.comments ?? ''}
                  </TableCell>
                  <TableCell>
                    <div className="flex items-center justify-end gap-0.5">
                      {EDITABLE.includes(row.type) && (
                        <EditHardwareButton
                          label={row.iface}
                          disabledReason={disabledReason}
                          onClick={() => setDialog({ kind: 'edit', iface: row })}
                        />
                      )}
                      {DELETABLE.includes(row.type) && (
                        <DeleteIfaceButton
                          iface={row.iface}
                          disabledReason={disabledReason}
                          onClick={() => setDeleting(row.iface)}
                        />
                      )}
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}

      {dialog !== null && (
        <NetIfaceDialog
          key={dialog.kind === 'edit' ? `edit:${dialog.iface.iface}` : `create:${dialog.type}`}
          open
          onOpenChange={(open) => {
            if (!open) setDialog(null);
          }}
          node={node}
          ifaces={network.data?.ifaces ?? []}
          mode={dialog}
        />
      )}
      {deleting !== null && (
        <DeleteNetIfaceDialog
          key={deleting}
          open
          onOpenChange={(open) => {
            if (!open) setDeleting(null);
          }}
          node={node}
          iface={deleting}
        />
      )}
      {applying && (
        <ApplyNetworkDialog
          open
          onOpenChange={(open) => {
            if (!open) setApplying(false);
          }}
          node={node}
        />
      )}
    </div>
  );
}

export default NetworkTab;
