import { useState } from 'react';
import { ArrowDown, ArrowUp, Pencil, Plus, Trash2 } from 'lucide-react';
import { toast } from 'sonner';

import { EmptyState } from '@/components/EmptyState';
import { Panel } from '@/components/Panel';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { DeleteRuleDialog } from '@/components/firewall/DeleteRuleDialog';
import { EditRuleDialog } from '@/components/firewall/EditRuleDialog';
import { Cell, RowButton } from '@/components/clusterfirewall/shared';
import { errorMessage } from '@/api/errors';
import { hardwareErrorMessage } from '@/api/hardwareHooks';
import { useClusterRules, useUpdateClusterRule } from '@/api/clusterFirewallHooks';
import type { ClusterRuleScope } from '@/api/clusterFirewall';
import type { FirewallRule, FirewallRuleType } from '@/api/firewall';
import { cn } from '@/lib/utils';

type DialogTarget =
  | { kind: 'add'; initialType: FirewallRuleType }
  | { kind: 'edit'; rule: FirewallRule }
  | { kind: 'delete'; rule: FirewallRule };

export interface ClusterRulesPanelProps {
  /** The datacenter's own rule list, or one security group's. */
  scope: ClusterRuleScope;
  title: string;
  /** When set, every control is disabled and this is its tooltip. */
  disabledReason: string | undefined;
}

/**
 * A datacenter-level rule list (PVE's Datacenter -> Firewall rules, or the rules inside one security
 * group): the table with add / edit / delete / enable-disable / reorder. Reads through the
 * read-only proxy, writes through `/api/actions/datacenter/firewall/*`; edits, deletes and moves
 * forward the digest of the last read so a concurrent change is rejected rather than overwritten.
 * The rule dialogs are the guest firewall's, pointed at this scope.
 */
export function ClusterRulesPanel({ scope, title, disabledReason }: ClusterRulesPanelProps) {
  const rules = useClusterRules(scope);
  const update = useUpdateClusterRule();
  const [dialog, setDialog] = useState<DialogTarget | null>(null);
  const locked = disabledReason !== undefined;
  const prefix = scope.kind === 'cluster' ? 'dc-fw' : 'dc-fw-group';

  const list = rules.data ?? [];
  const digest = list[0]?.digest;

  function patchRule(rule: FirewallRule, patch: { enable?: boolean; moveto?: number }, successMessage: string) {
    update.mutate(
      {
        scope,
        pos: rule.pos,
        patch: { ...patch, ...(digest !== undefined ? { digest } : {}) },
        successMessage,
      },
      { onError: (error) => toast.error(hardwareErrorMessage(error, 'The firewall rule could not be changed.')) },
    );
  }

  const actions = (
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
      {scope.kind === 'cluster' && (
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
      )}
    </div>
  );

  return (
    <div data-testid={`${prefix}-rules`}>
      <Panel title={title} action={actions}>
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
                  <TableRow key={rule.pos} data-testid={`${prefix}-rule-${rule.pos}`} className={cn(!enabled && 'text-muted-foreground')}>
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
                      <Cell value={rule.log} />
                    </TableCell>
                    <TableCell className="max-w-[16rem] truncate" title={rule.comment}>
                      <Cell value={rule.comment} />
                    </TableCell>
                    <TableCell>
                      <div className="flex items-center justify-end">
                        <RowButton
                          label={`Move rule ${rule.pos} up`}
                          icon={ArrowUp}
                          disabledReason={disabledReason}
                          disabled={index === 0 || update.isPending}
                          onClick={() => patchRule(rule, { moveto: rule.pos - 1 }, 'Firewall rule moved')}
                        />
                        <RowButton
                          label={`Move rule ${rule.pos} down`}
                          icon={ArrowDown}
                          disabledReason={disabledReason}
                          disabled={index === list.length - 1 || update.isPending}
                          onClick={() => patchRule(rule, { moveto: rule.pos + 1 }, 'Firewall rule moved')}
                        />
                        <RowButton
                          label={`Edit rule ${rule.pos}`}
                          icon={Pencil}
                          disabledReason={disabledReason}
                          onClick={() => setDialog({ kind: 'edit', rule })}
                        />
                        <RowButton
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
          target={scope}
          initialType={dialog.initialType}
          ruleCount={list.length}
          digest={digest}
        />
      )}
      {dialog?.kind === 'edit' && (
        <EditRuleDialog
          open
          onOpenChange={(open) => !open && setDialog(null)}
          target={scope}
          rule={dialog.rule}
          ruleCount={list.length}
          digest={digest}
        />
      )}
      {dialog?.kind === 'delete' && (
        <DeleteRuleDialog
          open
          onOpenChange={(open) => !open && setDialog(null)}
          target={scope}
          rule={dialog.rule}
          digest={digest}
        />
      )}
    </div>
  );
}
