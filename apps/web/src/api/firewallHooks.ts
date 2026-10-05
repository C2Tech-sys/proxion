import { useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';

import {
  addFirewallRule,
  deleteFirewallRule,
  getFirewallOptions,
  getFirewallRules,
  getMacros,
  getSecurityGroups,
  updateFirewallOptions,
  updateFirewallRule,
  type FirewallOptionsPatch,
  type FirewallRuleBody,
  type FirewallRulePatch,
} from '@/api/firewall';
import type { GuestType } from '@/api/types';

interface GuestVars {
  node: string;
  type: GuestType;
  vmid: number;
}

export interface AddFirewallRuleVars extends GuestVars {
  body: FirewallRuleBody;
}

export interface UpdateFirewallRuleVars extends GuestVars {
  /** The rule's current position. */
  pos: number;
  patch: FirewallRulePatch;
  /** What the success toast says; defaults to "Firewall rule updated". */
  successMessage?: string;
}

export interface DeleteFirewallRuleVars extends GuestVars {
  pos: number;
  digest?: string | undefined;
}

export interface UpdateFirewallOptionsVars extends GuestVars {
  patch: FirewallOptionsPatch;
}

export const firewallRulesKey = (node: string, type: GuestType, vmid: number) =>
  ['firewall-rules', node, type, vmid] as const;
export const firewallOptionsKey = (node: string, type: GuestType, vmid: number) =>
  ['firewall-options', node, type, vmid] as const;

/** Both firewall reads share one digest, so a write re-reads both. */
function invalidateFirewall(queryClient: QueryClient, { node, type, vmid }: GuestVars): Promise<unknown> {
  return Promise.all([
    queryClient.invalidateQueries({ queryKey: firewallRulesKey(node, type, vmid) }),
    queryClient.invalidateQueries({ queryKey: firewallOptionsKey(node, type, vmid) }),
  ]);
}

/** The guest's firewall rules, in evaluation order. */
export function useFirewallRules(node: string, type: GuestType, vmid: number) {
  return useQuery({
    queryKey: firewallRulesKey(node, type, vmid),
    queryFn: () => getFirewallRules(node, type, vmid),
    enabled: Boolean(node && type && vmid),
  });
}

/** The guest's firewall options. */
export function useFirewallOptions(node: string, type: GuestType, vmid: number) {
  return useQuery({
    queryKey: firewallOptionsKey(node, type, vmid),
    queryFn: () => getFirewallOptions(node, type, vmid),
    enabled: Boolean(node && type && vmid),
  });
}

/** The cluster's security groups for the group-rule picker. Near-static; a failure falls back to a
 * free-text field in the dialog rather than waiting on retries. */
export function useSecurityGroups(enabled = true) {
  return useQuery({
    queryKey: ['firewall-security-groups'],
    queryFn: getSecurityGroups,
    enabled,
    staleTime: 5 * 60 * 1000,
    retry: false,
  });
}

/** The firewall macros for the rule dialog's macro picker. Same caching/fallback as the groups. */
export function useFirewallMacros(enabled = true) {
  return useQuery({
    queryKey: ['firewall-macros'],
    queryFn: getMacros,
    enabled,
    staleTime: 30 * 60 * 1000,
    retry: false,
  });
}

/**
 * Adds one rule (`src/api/firewall.ts`). On success: a "Firewall rule added" toast and a re-read of
 * the guest's rules and options. On error: no toast here; the dialog shows the server's message
 * inline and stays open, same convention as `useUpsertNic`.
 */
export function useAddFirewallRule() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (vars: AddFirewallRuleVars) => addFirewallRule(vars.node, vars.type, vars.vmid, vars.body),
    onSuccess: async (_result, vars) => {
      toast.success('Firewall rule added');
      await invalidateFirewall(queryClient, vars);
    },
  });
}

/** Edits, toggles or moves one rule. Same toast/invalidation convention as `useAddFirewallRule`. */
export function useUpdateFirewallRule() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (vars: UpdateFirewallRuleVars) =>
      updateFirewallRule(vars.node, vars.type, vars.vmid, vars.pos, vars.patch),
    onSuccess: async (_result, vars) => {
      toast.success(vars.successMessage ?? 'Firewall rule updated');
      await invalidateFirewall(queryClient, vars);
    },
  });
}

/** Removes one rule. Same toast/invalidation convention as `useAddFirewallRule`. */
export function useDeleteFirewallRule() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (vars: DeleteFirewallRuleVars) =>
      deleteFirewallRule(vars.node, vars.type, vars.vmid, vars.pos, vars.digest),
    onSuccess: async (_result, vars) => {
      toast.success('Firewall rule removed');
      await invalidateFirewall(queryClient, vars);
    },
  });
}

/** Saves firewall options. Same toast/invalidation convention as `useAddFirewallRule`. */
export function useUpdateFirewallOptions() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (vars: UpdateFirewallOptionsVars) =>
      updateFirewallOptions(vars.node, vars.type, vars.vmid, vars.patch),
    onSuccess: async (_result, vars) => {
      toast.success('Firewall options saved');
      await invalidateFirewall(queryClient, vars);
    },
  });
}
