import { useMemo, useState, type ComponentType } from 'react';
import { ArrowDown, ArrowUp, Pencil, Plus, Trash2 } from 'lucide-react';
import { toast } from 'sonner';

import { EmptyState } from '@/components/EmptyState';
import { Panel } from '@/components/Panel';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Skeleton } from '@/components/ui/skeleton';
import { Tabs, TabsContent } from '@/components/ui/tabs';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { TabStrip } from '@/components/TabStrip';
import { AliasesPanel } from '@/components/clusterfirewall/AliasesPanel';
import { IpSetsPanel } from '@/components/clusterfirewall/IpSetsPanel';
import { DeleteRuleDialog } from '@/components/firewall/DeleteRuleDialog';
import { EditRuleDialog } from '@/components/firewall/EditRuleDialog';
import { FirewallOptionsCard } from '@/components/firewall/FirewallOptionsCard';
import { useAuthMe, useVmConfig } from '@/api/hooks';
import { usePermissions } from '@/api/actionHooks';
import { USE_FIXTURES } from '@/api/client';
import { errorMessage } from '@/api/errors';
import { hardwareErrorMessage } from '@/api/hardwareHooks';
import { useFirewallOptions, useFirewallRules, useUpdateFirewallRule } from '@/api/firewallHooks';
import type { FirewallRule, FirewallRuleType } from '@/api/firewall';
import type { FirewallTarget } from '@/api/clusterFirewall';
import { cn } from '@/lib/utils';
import type { VmTabProps } from '@/pages/vm/tabs';

const FIREWALL_PRIVILEGE = 'VM.Config.Network';

const SUB_TABS = [
  { value: 'rules', label: 'Rules' },
  { value: 'aliases', label: 'Aliases' },
  { value: 'ipsets', label: 'IP Sets' },
] as const;

type SubTab = (typeof SUB_TABS)[number]['value'];

type DialogTarget =
  | { kind: 'add'; initialType: FirewallRuleType }
  | { kind: 'edit'; rule: FirewallRule }
  | { kind: 'delete'; rule: FirewallRule };

/** `net0`, `net1`, ... in numeric order. */
function netKeysOf(config: Record<string, unknown> | undefined): string[] {
  return Object.keys(config ?? {})
    .filter((key) => /^net\d+$/.test(key))
    .sort((a, b) => Number(a.slice(3)) - Number(b.slice(3)));
}

function Cell({ value }: { value: string | undefined }) {
  return value ? <>{value}</> : <span className="text-muted-foreground">-</span>;
}

function RuleActionButton({
  label,
  icon,
  disabledReason,
  disabled,
  onClick,
  destructive,
}: {
  label: string;
  icon: ComponentType<{ className?: string }>;
  disabledReason: string | undefined;
  /** An extra reason to disable (first/last row, a save in flight) without a tooltip. */
  disabled?: boolean;
  onClick: () => void;
  destructive?: boolean;
}) {
  const Icon = icon;
  const locked = disabledReason !== undefined;
  return (
    <Button
      variant="ghost"
      size="icon"
      className={cn('size-7 shrink-0', destructive && !locked && 'text-destructive hover:text-destructive')}
      aria-label={label}
      title={locked ? disabledReason : label}
      disabled={locked || disabled}
      onClick={onClick}
    >
      <Icon className="size-3.5" />
    </Button>
  );
}

interface RulesSectionProps {
  node: string;
  type: 'qemu' | 'lxc';
  vmid: number;
  /** When set, every control is disabled and this is its tooltip. */
  disabledReason: string | undefined;
}

/** The firewall options as one card and the rule list as a table, with add / edit / delete /
 * enable-disable / reorder. */
function RulesSection({ node, type, vmid, disabledReason }: RulesSectionProps) {
  const config = useVmConfig(node, type, vmid);
  const rules = useFirewallRules(node, type, vmid);
  const options = useFirewallOptions(node, type, vmid);
  const update = useUpdateFirewallRule();
  const [dialog, setDialog] = useState<DialogTarget | null>(null);
  const locked = disabledReason !== undefined;

  const list = rules.data ?? [];
  const digest = list[0]?.digest;
  const netKeys = netKeysOf(config.data as Record<string, unknown> | undefined);

  function patchRule(rule: FirewallRule, patch: { enable?: boolean; moveto?: number }, successMessage: string) {
    update.mutate(
      {
        node,
        type,
        vmid,
        pos: rule.pos,
        patch: { ...patch, ...(digest !== undefined ? { digest } : {}) },
        successMessage,
      },
      { onError: (error) => toast.error(hardwareErrorMessage(error, 'The firewall rule could not be changed.')) },
    );
  }

  const ruleActions = (
    <div className="flex items-center gap-2">
      <Button
        variant="outline"
        size="sm"
        disabled={locked}
        aria-disabled={locked || undefined}
        title={disabledReason}
        onClick={() => setDialog({ kind: 'add', initialType: 'in' })}
      >
        <Plus className="size-3.5" />
        Add rule
      </Button>
      <Button
        variant="outline"
        size="sm"
        disabled={locked}
        aria-disabled={locked || undefined}
        title={disabledReason}
        onClick={() => setDialog({ kind: 'add', initialType: 'group' })}
      >
        <Plus className="size-3.5" />
        Add security group
      </Button>
    </div>
  );

  return (
    <>
      {options.isLoading ? (
        <Skeleton className="mb-4 h-40 w-full" />
      ) : options.isError ? (
        <Panel title="Options" className="mb-4">
          <EmptyState message={`Could not load the firewall options: ${errorMessage(options.error)}`} />
        </Panel>
      ) : options.data ? (
        <FirewallOptionsCard
          node={node}
          type={type}
          vmid={vmid}
          options={options.data}
          disabledReason={disabledReason}
        />
      ) : null}

      <Panel title="Rules" action={ruleActions}>
        {rules.isLoading ? (
          <Skeleton className="h-32 w-full" />
        ) : rules.isError ? (
          <EmptyState message={`Could not load the firewall rules: ${errorMessage(rules.error)}`} />
        ) : list.length === 0 ? (
          <EmptyState message="No firewall rules." />
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-8">
                  <span className="sr-only">Enabled</span>
                </TableHead>
                <TableHead>Type</TableHead>
                <TableHead>Action</TableHead>
                <TableHead>Macro</TableHead>
                <TableHead>Protocol</TableHead>
                <TableHead>Source</TableHead>
                <TableHead>Destination</TableHead>
                <TableHead>S.Port</TableHead>
                <TableHead>D.Port</TableHead>
                <TableHead>Interface</TableHead>
                <TableHead>Log</TableHead>
                <TableHead>Comment</TableHead>
                <TableHead>
                  <span className="sr-only">Actions</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {list.map((rule, index) => {
                const enabled = rule.enable !== 0;
                return (
                  <TableRow key={rule.pos} data-testid={`firewall-rule-${rule.pos}`} className={cn(!enabled && 'text-muted-foreground')}>
                    <TableCell>
                      <Checkbox
                        aria-label={`Enable rule ${rule.pos}`}
                        checked={enabled}
                        disabled={locked || update.isPending}
                        title={disabledReason}
                        onCheckedChange={(checked) =>
                          patchRule(
                            rule,
                            { enable: checked === true },
                            checked === true ? 'Firewall rule enabled' : 'Firewall rule disabled',
                          )
                        }
                      />
                    </TableCell>
                    <TableCell>{rule.type}</TableCell>
                    <TableCell>{rule.action}</TableCell>
                    <TableCell>
                      <Cell value={rule.macro} />
                    </TableCell>
                    <TableCell>
                      <Cell value={rule.proto} />
                    </TableCell>
                    <TableCell>
                      <Cell value={rule.source} />
                    </TableCell>
                    <TableCell>
                      <Cell value={rule.dest} />
                    </TableCell>
                    <TableCell>
                      <Cell value={rule.sport} />
                    </TableCell>
                    <TableCell>
                      <Cell value={rule.dport} />
                    </TableCell>
                    <TableCell>
                      <Cell value={rule.iface} />
                    </TableCell>
                    <TableCell>
                      <Cell value={rule.log} />
                    </TableCell>
                    <TableCell className="max-w-[16rem] truncate" title={rule.comment}>
                      <Cell value={rule.comment} />
                    </TableCell>
                    <TableCell>
                      <div className="flex items-center justify-end">
                        <RuleActionButton
                          label={`Move rule ${rule.pos} up`}
                          icon={ArrowUp}
                          disabledReason={disabledReason}
                          disabled={index === 0 || update.isPending}
                          onClick={() => patchRule(rule, { moveto: rule.pos - 1 }, 'Firewall rule moved')}
                        />
                        <RuleActionButton
                          label={`Move rule ${rule.pos} down`}
                          icon={ArrowDown}
                          disabledReason={disabledReason}
                          disabled={index === list.length - 1 || update.isPending}
                          onClick={() => patchRule(rule, { moveto: rule.pos + 1 }, 'Firewall rule moved')}
                        />
                        <RuleActionButton
                          label={`Edit rule ${rule.pos}`}
                          icon={Pencil}
                          disabledReason={disabledReason}
                          onClick={() => setDialog({ kind: 'edit', rule })}
                        />
                        <RuleActionButton
                          label={`Delete rule ${rule.pos}`}
                          icon={Trash2}
                          destructive
                          disabledReason={disabledReason}
                          onClick={() => setDialog({ kind: 'delete', rule })}
                        />
                      </div>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        )}
      </Panel>

      {dialog?.kind === 'add' && (
        <EditRuleDialog
          open
          onOpenChange={(open) => !open && setDialog(null)}
          node={node}
          type={type}
          vmid={vmid}
          initialType={dialog.initialType}
          ruleCount={list.length}
          netKeys={netKeys}
          digest={digest}
        />
      )}
      {dialog?.kind === 'edit' && (
        <EditRuleDialog
          open
          onOpenChange={(open) => !open && setDialog(null)}
          node={node}
          type={type}
          vmid={vmid}
          rule={dialog.rule}
          ruleCount={list.length}
          netKeys={netKeys}
          digest={digest}
        />
      )}
      {dialog?.kind === 'delete' && (
        <DeleteRuleDialog
          open
          onOpenChange={(open) => !open && setDialog(null)}
          node={node}
          type={type}
          vmid={vmid}
          rule={dialog.rule}
          digest={digest}
        />
      )}
    </>
  );
}

/**
 * The guest's firewall (PVE's per-guest Firewall panel) as three sub-tabs: Rules (the firewall
 * options and the rule list), Aliases and IP Sets. Reads go through the read-only `/api/pve/*`
 * proxy; every change goes through the allow-listed `/api/actions/guest/.../firewall/*` routes,
 * which need a signed-in session and `VM.Config.Network` on the guest (that is what pve-firewall
 * checks) -- the controls are gated on the same two conditions, a disabled one carrying the reason as
 * its tooltip. The aliases and IP sets are the datacenter firewall's panels pointed at this guest.
 * The firewall log and the datacenter/node firewall are not part of this tab.
 *
 * Edits, deletes, moves and option changes forward the digest of the last read, so editing a
 * firewall someone else just changed is rejected by PVE rather than silently overwriting their
 * rules (adding a rule appends and needs no digest).
 */
export function FirewallTab({ node, type, vmid }: VmTabProps) {
  const auth = useAuthMe();
  const permissions = usePermissions(vmid);
  const [sub, setSub] = useState<SubTab>('rules');
  const target = useMemo<FirewallTarget>(() => ({ kind: 'guest', node, type, vmid }), [node, type, vmid]);

  // Fixture/demo mode has no real session concept -- it always demonstrates the enabled state,
  // same as the Hardware tab.
  const isSessionMode = USE_FIXTURES || auth.data?.mode === 'session';
  const disabledReason = !isSessionMode
    ? 'Read-only: signed in with a service token'
    : permissions.data?.can(FIREWALL_PRIVILEGE) !== true
      ? `You don't have ${FIREWALL_PRIVILEGE} on this guest`
      : undefined;

  return (
    <div data-testid="firewall-tab">
      <Tabs value={sub} onValueChange={(next) => setSub(next as SubTab)}>
        <TabStrip tabs={[...SUB_TABS]} />
        <TabsContent value="rules">
          <RulesSection node={node} type={type} vmid={vmid} disabledReason={disabledReason} />
        </TabsContent>
        <TabsContent value="aliases">
          <AliasesPanel target={target} disabledReason={disabledReason} />
        </TabsContent>
        <TabsContent value="ipsets">
          <IpSetsPanel target={target} disabledReason={disabledReason} />
        </TabsContent>
      </Tabs>
    </div>
  );
}

export default FirewallTab;
