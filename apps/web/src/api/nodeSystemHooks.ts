import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';

import { GuestActionError } from '@/api/actions';
import {
  getNodeCertificates,
  getNodeDns,
  getNodeHosts,
  getNodeOptions,
  getNodeTime,
  removeNodeCertificate,
  saveNodeHosts,
  updateNodeDns,
  updateNodeOptions,
  updateNodeTime,
  uploadNodeCertificate,
  type RemoveCertificateBody,
  type SaveHostsBody,
  type UpdateDnsBody,
  type UpdateOptionsBody,
  type UpdateTimeBody,
  type UploadCertificateBody,
} from '@/api/nodeSystem';

type SystemPart = 'dns' | 'time' | 'options' | 'hosts' | 'certificates';

export const nodeSystemQueryKey = (node: string, part: SystemPart) => ['node-system', node, part] as const;

/** The server's message for a failed System write (dialogs show it inline). */
export function nodeSystemErrorMessage(error: unknown, fallback: string): string {
  return error instanceof GuestActionError ? error.message : fallback;
}

// Reads always refetch on mount: a stale digest next to a Save button would make PVE refuse the
// write, and the hosts editor re-reads the digest every time it opens.
const READ_OPTIONS = { staleTime: 0, retry: false, refetchOnMount: 'always' } as const;

export function useNodeDns(node: string) {
  return useQuery({
    queryKey: nodeSystemQueryKey(node, 'dns'),
    queryFn: () => getNodeDns(node),
    enabled: Boolean(node),
    ...READ_OPTIONS,
  });
}

export function useNodeTime(node: string) {
  return useQuery({
    queryKey: nodeSystemQueryKey(node, 'time'),
    queryFn: () => getNodeTime(node),
    enabled: Boolean(node),
    ...READ_OPTIONS,
  });
}

export function useNodeOptions(node: string) {
  return useQuery({
    queryKey: nodeSystemQueryKey(node, 'options'),
    queryFn: () => getNodeOptions(node),
    enabled: Boolean(node),
    ...READ_OPTIONS,
  });
}

export function useNodeHosts(node: string) {
  return useQuery({
    queryKey: nodeSystemQueryKey(node, 'hosts'),
    queryFn: () => getNodeHosts(node),
    enabled: Boolean(node),
    ...READ_OPTIONS,
  });
}

export function useNodeCertificates(node: string) {
  return useQuery({
    queryKey: nodeSystemQueryKey(node, 'certificates'),
    queryFn: () => getNodeCertificates(node),
    enabled: Boolean(node),
    ...READ_OPTIONS,
  });
}

/* Every mutation: toast + refetch on success; on error no toast -- the dialog shows the server's
 * message inline and stays open, same convention as the node network hooks. */

export function useUpdateNodeDns() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (vars: { node: string; body: UpdateDnsBody }) => updateNodeDns(vars.node, vars.body),
    onSuccess: (_result, vars) => {
      toast.success('DNS settings saved');
      void queryClient.invalidateQueries({ queryKey: nodeSystemQueryKey(vars.node, 'dns') });
    },
  });
}

export function useUpdateNodeTime() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (vars: { node: string; body: UpdateTimeBody }) => updateNodeTime(vars.node, vars.body),
    onSuccess: (_result, vars) => {
      toast.success(`Time zone set to ${vars.body.timezone}`);
      void queryClient.invalidateQueries({ queryKey: nodeSystemQueryKey(vars.node, 'time') });
    },
  });
}

export function useUpdateNodeOptions() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (vars: { node: string; body: UpdateOptionsBody }) => updateNodeOptions(vars.node, vars.body),
    onSuccess: (_result, vars) => {
      toast.success('Node options saved');
      void queryClient.invalidateQueries({ queryKey: nodeSystemQueryKey(vars.node, 'options') });
    },
  });
}

export function useSaveNodeHosts() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (vars: { node: string; body: SaveHostsBody }) => saveNodeHosts(vars.node, vars.body),
    onSuccess: (_result, vars) => {
      toast.success('Hosts file saved');
      void queryClient.invalidateQueries({ queryKey: nodeSystemQueryKey(vars.node, 'hosts') });
    },
  });
}

export function useUploadNodeCertificate() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (vars: { node: string; body: UploadCertificateBody }) => uploadNodeCertificate(vars.node, vars.body),
    onSuccess: (_result, vars) => {
      toast.success(
        vars.body.restart
          ? 'Custom certificate installed; the Proxmox web proxy is restarting'
          : 'Custom certificate installed; restart the Proxmox web proxy to use it',
      );
      void queryClient.invalidateQueries({ queryKey: nodeSystemQueryKey(vars.node, 'certificates') });
    },
  });
}

export function useRemoveNodeCertificate() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (vars: { node: string; body: RemoveCertificateBody }) => removeNodeCertificate(vars.node, vars.body),
    onSuccess: (_result, vars) => {
      toast.success('Custom certificate removed; Proxmox is back on its own certificate');
      void queryClient.invalidateQueries({ queryKey: nodeSystemQueryKey(vars.node, 'certificates') });
    },
  });
}
