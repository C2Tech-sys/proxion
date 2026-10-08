import { useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';

import {
  addClusterRule,
  addIpsetEntry,
  createAlias,
  deleteAlias,
  deleteClusterRule,
  deleteIpset,
  deleteIpsetEntry,
  deleteSecurityGroup,
  getClusterAliases,
  getClusterGroups,
  getClusterIpsets,
  getClusterOptions,
  getClusterRefs,
  getClusterRules,
  getGroupRules,
  getIpsetEntries,
  saveIpset,
  saveSecurityGroup,
  updateAlias,
  updateClusterOptions,
  updateClusterRule,
  updateIpsetEntry,
  CLUSTER_FIREWALL_TARGET,
  type AliasCreate,
  type AliasUpdate,
  type ClusterOptionsPatch,
  type ClusterRuleScope,
  type FirewallTarget,
  type IpsetEntryCreate,
  type IpsetEntryUpdate,
  type IpsetSave,
  type SecurityGroupSave,
} from '@/api/clusterFirewall';
import type { FirewallRuleBody, FirewallRulePatch } from '@/api/firewall';

/** Every datacenter-firewall query lives under this prefix: PVE keeps the whole datacenter firewall
 * in one config file with one digest, so any write re-reads all of it. */
const ROOT = 'cluster-firewall';

export const clusterRulesKey = (scope: ClusterRuleScope) =>
  scope.kind === 'cluster' ? ([ROOT, 'rules'] as const) : ([ROOT, 'group-rules', scope.group] as const);
export const clusterOptionsKey = [ROOT, 'options'] as const;
export const clusterGroupsKey = [ROOT, 'groups'] as const;
export const clusterAliasesKey = [ROOT, 'aliases'] as const;
export const clusterIpsetsKey = [ROOT, 'ipsets'] as const;
export const clusterIpsetEntriesKey = (name: string) => [ROOT, 'ipset-entries', name] as const;
export const clusterRefsKey = [ROOT, 'refs'] as const;

/** A guest's aliases, IP sets and refs live under their own prefix (one per guest), so a guest and
 * the datacenter -- or two guests -- never share a cache entry and a write refreshes only its own. */
const GUEST_ROOT = 'guest-firewall-refs';

function targetRoot(target: FirewallTarget) {
  return target.kind === 'guest'
    ? ([GUEST_ROOT, target.node, target.type, target.vmid] as const)
    : ([ROOT] as const);
}

export const aliasesKey = (target: FirewallTarget) => [...targetRoot(target), 'aliases'] as const;
export const ipsetsKey = (target: FirewallTarget) => [...targetRoot(target), 'ipsets'] as const;
export const ipsetEntriesKey = (name: string, target: FirewallTarget) =>
  [...targetRoot(target), 'ipset-entries', name] as const;
export const refsKey = (target: FirewallTarget) => [...targetRoot(target), 'refs'] as const;

/** Re-reads everything of the firewall `target` addresses: a guest's own queries, or (the datacenter,
 * and a security group's scope) all of the datacenter firewall. */
function invalidateTarget(queryClient: QueryClient, target: FirewallTarget): Promise<unknown> {
  return target.kind === 'guest'
    ? queryClient.invalidateQueries({ queryKey: targetRoot(target) })
    : invalidateAll(queryClient);
}

/** The optional trailing `target` argument of the alias / IP set functions: passed only for a guest,
 * so a datacenter call keeps exactly the arguments it always had. */
const targetArgs = (target: FirewallTarget): [] | [FirewallTarget] => (target.kind === 'guest' ? [target] : []);

function invalidateAll(queryClient: QueryClient, alsoGroupPicker = false): Promise<unknown> {
  return Promise.all([
    queryClient.invalidateQueries({ queryKey: [ROOT] }),
    ...(alsoGroupPicker ? [queryClient.invalidateQueries({ queryKey: ['firewall-security-groups'] })] : []),
  ]);
}

// --- reads ------------------------------------------------------------------------------------

/** The datacenter's rules (`scope.kind === 'cluster'`) or one security group's. */
export function useClusterRules(scope: ClusterRuleScope) {
  return useQuery({
    queryKey: clusterRulesKey(scope),
    queryFn: () => (scope.kind === 'cluster' ? getClusterRules() : getGroupRules(scope.group)),
  });
}

export function useClusterOptions() {
  return useQuery({ queryKey: clusterOptionsKey, queryFn: getClusterOptions });
}

export function useClusterGroups() {
  return useQuery({ queryKey: clusterGroupsKey, queryFn: getClusterGroups });
}

/** The aliases of the datacenter firewall, or of one guest's when `target` is a guest. */
export function useClusterAliases(target: FirewallTarget = CLUSTER_FIREWALL_TARGET) {
  return useQuery({ queryKey: aliasesKey(target), queryFn: () => getClusterAliases(...targetArgs(target)) });
}

export function useClusterIpsets(target: FirewallTarget = CLUSTER_FIREWALL_TARGET) {
  return useQuery({ queryKey: ipsetsKey(target), queryFn: () => getClusterIpsets(...targetArgs(target)) });
}

export function useIpsetEntries(name: string | undefined, target: FirewallTarget = CLUSTER_FIREWALL_TARGET) {
  return useQuery({
    queryKey: ipsetEntriesKey(name ?? '', target),
    queryFn: () => getIpsetEntries(name ?? '', ...targetArgs(target)),
    enabled: name !== undefined,
  });
}

/** Aliases and IP sets for the rule dialog's source / destination pickers (a guest's include the
 * inherited datacenter ones); a failure just means no suggestions. */
export function useClusterRefs(enabled = true, target: FirewallTarget = CLUSTER_FIREWALL_TARGET) {
  return useQuery({
    queryKey: refsKey(target),
    queryFn: () => getClusterRefs(...targetArgs(target)),
    enabled,
    staleTime: 60 * 1000,
    retry: false,
  });
}

// --- rules ------------------------------------------------------------------------------------

export interface AddClusterRuleVars {
  scope: ClusterRuleScope;
  body: FirewallRuleBody;
}
export interface UpdateClusterRuleVars {
  scope: ClusterRuleScope;
  pos: number;
  patch: FirewallRulePatch;
  /** What the success toast says; defaults to "Firewall rule updated". */
  successMessage?: string;
}
export interface DeleteClusterRuleVars {
  scope: ClusterRuleScope;
  pos: number;
  digest?: string | undefined;
}

/** On success: a toast and a re-read; on error the dialog shows the message inline (no toast here). */
export function useAddClusterRule() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (vars: AddClusterRuleVars) => addClusterRule(vars.scope, vars.body),
    onSuccess: async () => {
      toast.success('Firewall rule added');
      await invalidateAll(queryClient);
    },
  });
}

export function useUpdateClusterRule() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (vars: UpdateClusterRuleVars) => updateClusterRule(vars.scope, vars.pos, vars.patch),
    onSuccess: async (_result, vars) => {
      toast.success(vars.successMessage ?? 'Firewall rule updated');
      await invalidateAll(queryClient);
    },
  });
}

export function useDeleteClusterRule() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (vars: DeleteClusterRuleVars) => deleteClusterRule(vars.scope, vars.pos, vars.digest),
    onSuccess: async () => {
      toast.success('Firewall rule removed');
      await invalidateAll(queryClient);
    },
  });
}

// --- options ----------------------------------------------------------------------------------

export interface UpdateClusterOptionsVars {
  patch: ClusterOptionsPatch;
  /** What the success toast says; defaults to "Firewall options saved". */
  successMessage?: string;
}

export function useUpdateClusterOptions() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (vars: UpdateClusterOptionsVars) => updateClusterOptions(vars.patch),
    onSuccess: async (_result, vars) => {
      toast.success(vars.successMessage ?? 'Firewall options saved');
      await invalidateAll(queryClient);
    },
  });
}

// --- security groups --------------------------------------------------------------------------

export function useSaveSecurityGroup() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (vars: SecurityGroupSave) => saveSecurityGroup(vars),
    onSuccess: async (_result, vars) => {
      toast.success(vars.rename !== undefined ? 'Security group saved' : 'Security group created');
      await invalidateAll(queryClient, true);
    },
  });
}

export function useDeleteSecurityGroup() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (group: string) => deleteSecurityGroup(group),
    onSuccess: async () => {
      toast.success('Security group removed');
      await invalidateAll(queryClient, true);
    },
  });
}

// --- aliases ----------------------------------------------------------------------------------

export function useCreateAlias(target: FirewallTarget = CLUSTER_FIREWALL_TARGET) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (vars: AliasCreate) => createAlias(vars, ...targetArgs(target)),
    onSuccess: async () => {
      toast.success('Alias added');
      await invalidateTarget(queryClient, target);
    },
  });
}

export function useUpdateAlias(target: FirewallTarget = CLUSTER_FIREWALL_TARGET) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (vars: AliasUpdate) => updateAlias(vars, ...targetArgs(target)),
    onSuccess: async () => {
      toast.success('Alias saved');
      await invalidateTarget(queryClient, target);
    },
  });
}

export function useDeleteAlias(target: FirewallTarget = CLUSTER_FIREWALL_TARGET) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (vars: { name: string; digest?: string | undefined }) =>
      target.kind === 'guest' ? deleteAlias(vars.name, vars.digest, target) : deleteAlias(vars.name, vars.digest),
    onSuccess: async () => {
      toast.success('Alias removed');
      await invalidateTarget(queryClient, target);
    },
  });
}

// --- IP sets ----------------------------------------------------------------------------------

export function useSaveIpset(target: FirewallTarget = CLUSTER_FIREWALL_TARGET) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (vars: IpsetSave) => saveIpset(vars, ...targetArgs(target)),
    onSuccess: async (_result, vars) => {
      toast.success(vars.rename !== undefined ? 'IP set saved' : 'IP set created');
      await invalidateTarget(queryClient, target);
    },
  });
}

export function useDeleteIpset(target: FirewallTarget = CLUSTER_FIREWALL_TARGET) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (vars: { name: string; force: boolean }) =>
      target.kind === 'guest' ? deleteIpset(vars.name, vars.force, target) : deleteIpset(vars.name, vars.force),
    onSuccess: async () => {
      toast.success('IP set removed');
      await invalidateTarget(queryClient, target);
    },
  });
}

export function useAddIpsetEntry(target: FirewallTarget = CLUSTER_FIREWALL_TARGET) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (vars: IpsetEntryCreate) => addIpsetEntry(vars, ...targetArgs(target)),
    onSuccess: async () => {
      toast.success('IP set entry added');
      await invalidateTarget(queryClient, target);
    },
  });
}

export function useUpdateIpsetEntry(target: FirewallTarget = CLUSTER_FIREWALL_TARGET) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (vars: IpsetEntryUpdate) => updateIpsetEntry(vars, ...targetArgs(target)),
    onSuccess: async () => {
      toast.success('IP set entry saved');
      await invalidateTarget(queryClient, target);
    },
  });
}

export function useDeleteIpsetEntry(target: FirewallTarget = CLUSTER_FIREWALL_TARGET) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (vars: { name: string; cidr: string; digest?: string | undefined }) =>
      target.kind === 'guest'
        ? deleteIpsetEntry(vars.name, vars.cidr, vars.digest, target)
        : deleteIpsetEntry(vars.name, vars.cidr, vars.digest),
    onSuccess: async () => {
      toast.success('IP set entry removed');
      await invalidateTarget(queryClient, target);
    },
  });
}
