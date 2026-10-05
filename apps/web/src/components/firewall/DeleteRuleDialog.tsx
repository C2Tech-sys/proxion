import { Loader2 } from 'lucide-react';

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { hardwareErrorMessage } from '@/api/hardwareHooks';
import { useDeleteFirewallRule } from '@/api/firewallHooks';
import type { FirewallRule } from '@/api/firewall';
import type { GuestType } from '@/api/types';

export interface DeleteRuleDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  node: string;
  type: GuestType;
  vmid: number;
  rule: FirewallRule;
  /** The digest of the last rules read, forwarded so a concurrent change is rejected. */
  digest?: string | undefined;
}

/** A one-line summary of the rule for the confirmation text. */
function describeRule(rule: FirewallRule): string {
  const parts = [rule.type, rule.action];
  if (rule.macro) parts.push(rule.macro);
  if (rule.proto) parts.push(rule.proto);
  if (rule.dport) parts.push(`port ${rule.dport}`);
  return parts.join(' ');
}

/**
 * Small confirmation for removing one firewall rule: an `AlertDialog` with a destructive confirm.
 * No typed confirmation -- the rule can be added back -- but the guest's traffic is filtered
 * differently as soon as it is gone. A server error stays inline and the dialog stays open.
 *
 * Mount it fresh per open (the Firewall tab renders it conditionally).
 */
export function DeleteRuleDialog({ open, onOpenChange, node, type, vmid, rule, digest }: DeleteRuleDialogProps) {
  const mutation = useDeleteFirewallRule();

  function confirm() {
    if (mutation.isPending) return;
    mutation.mutate({ node, type, vmid, pos: rule.pos, digest }, { onSuccess: () => onOpenChange(false) });
  }

  return (
    <AlertDialog
      open={open}
      onOpenChange={(next) => {
        if (!next && mutation.isPending) return;
        onOpenChange(next);
      }}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete firewall rule {rule.pos}?</AlertDialogTitle>
          <AlertDialogDescription>
            {describeRule(rule)}. Traffic it matched is handled by the rules below it or the policy.
          </AlertDialogDescription>
        </AlertDialogHeader>

        {mutation.isError && (
          <p role="alert" className="text-xs text-status-error">
            {hardwareErrorMessage(mutation.error, 'The firewall rule could not be deleted.')}
          </p>
        )}

        <AlertDialogFooter>
          <AlertDialogCancel disabled={mutation.isPending}>Cancel</AlertDialogCancel>
          <AlertDialogAction
            variant="destructive"
            disabled={mutation.isPending}
            onClick={(event) => {
              // Radix closes an AlertDialogAction on click by default; wait for the request to be
              // accepted instead (and stay open on an error), same convention as the other
              // destructive dialogs.
              event.preventDefault();
              confirm();
            }}
          >
            {mutation.isPending && <Loader2 className="size-4 animate-spin" />}
            Delete rule
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
