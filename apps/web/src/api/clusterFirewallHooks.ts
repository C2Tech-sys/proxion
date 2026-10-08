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
  type AliasCreate,
  type AliasUpdate,
  type ClusterOptionsPatch,
  type ClusterRuleScope,
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

export function useClusterAliases() {
  return useQuery({ queryKey: clusterAliasesKey, queryFn: getClusterAliases });
}

export function useClusterIpsets() {
  return useQuery({ queryKey: clusterIpsetsKey, queryFn: getClusterIpsets });
}

export function useIpsetEntries(name: string | undefined) {
  return useQuery({
    queryKey: clusterIpsetEntriesKey(name ?? ''),
    queryFn: () => getIpsetEntries(name ?? ''),
    enabled: name !== undefined,
  });
}

/** Aliases and IP sets for the rule dialog's source / destination pickers; a failure just means no suggestions. */
export function useClusterRefs(enabled = true) {
  return useQuery({ queryKey: clusterRefsKey, queryFn: getClusterRefs, enabled, staleTime: 60 * 1000, retry: false });
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

export function useCreateAlias() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (vars: AliasCreate) => createAlias(vars),
    onSuccess: async () => {
      toast.success('Alias added');
      await invalidateAll(queryClient);
    },
  });
}

export function useUpdateAlias() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (vars: AliasUpdate) => updateAlias(vars),
    onSuccess: async () => {
      toast.success('Alias saved');
      await invalidateAll(queryClient);
    },
  });
}

export function useDeleteAlias() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (vars: { name: string; digest?: string | undefined }) => deleteAlias(vars.name, vars.digest),
    onSuccess: async () => {
      toast.success('Alias removed');
      await invalidateAll(queryClient);
    },
  });
}

// --- IP sets ----------------------------------------------------------------------------------

export function useSaveIpset() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (vars: IpsetSave) => saveIpset(vars),
    onSuccess: async (_result, vars) => {
      toast.success(vars.rename !== undefined ? 'IP set saved' : 'IP set created');
      await invalidateAll(queryClient);
    },
  });
}

export function useDeleteIpset() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (vars: { name: string; force: boolean }) => deleteIpset(vars.name, vars.force),
    onSuccess: async () => {
      toast.success('IP set removed');
      await invalidateAll(queryClient);
    },
  });
}

export function useAddIpsetEntry() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (vars: IpsetEntryCreate) => addIpsetEntry(vars),
    onSuccess: async () => {
      toast.success('IP set entry added');
      await invalidateAll(queryClient);
    },
  });
}

export function useUpdateIpsetEntry() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (vars: IpsetEntryUpdate) => updateIpsetEntry(vars),
    onSuccess: async () => {
      toast.success('IP set entry saved');
      await invalidateAll(queryClient);
    },
  });
}

export function useDeleteIpsetEntry() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (vars: { name: string; cidr: string; digest?: string | undefined }) =>
      deleteIpsetEntry(vars.name, vars.cidr, vars.digest),
    onSuccess: async () => {
      toast.success('IP set entry removed');
      await invalidateAll(queryClient);
    },
  });
}
