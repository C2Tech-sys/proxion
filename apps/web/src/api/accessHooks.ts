import { useMemo } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';

import { USE_FIXTURES } from '@/api/client';
import {
  FIXTURE_ACCESS_SELF,
  changePassword,
  createGroup,
  createToken,
  createUser,
  deleteGroup,
  deleteToken,
  deleteUser,
  getAcl,
  getGroups,
  getPoolIds,
  getRealms,
  getRoles,
  getUsers,
  setAcl,
  updateGroup,
  updateToken,
  updateUser,
  type AclBody,
  type ChangePasswordBody,
  type CreateTokenBody,
  type CreateUserBody,
  type UpdateTokenBody,
  type UpdateUserBody,
} from '@/api/access';
import { useAuthMe, useClusterResources } from '@/api/hooks';

/** Query keys, exported so tests and dialogs can invalidate precisely. */
export const ACCESS_USERS_KEY = ['access', 'users'] as const;
export const ACCESS_GROUPS_KEY = ['access', 'groups'] as const;
export const ACCESS_ROLES_KEY = ['access', 'roles'] as const;
export const ACCESS_ACL_KEY = ['access', 'acl'] as const;
export const ACCESS_REALMS_KEY = ['access', 'realms'] as const;
export const ACCESS_POOLS_KEY = ['access', 'pools'] as const;

// --- reads --------------------------------------------------------------------------------------

export function useAccessUsers() {
  return useQuery({ queryKey: ACCESS_USERS_KEY, queryFn: getUsers, staleTime: 15_000 });
}
export function useAccessGroups() {
  return useQuery({ queryKey: ACCESS_GROUPS_KEY, queryFn: getGroups, staleTime: 15_000 });
}
export function useAccessRoles() {
  return useQuery({ queryKey: ACCESS_ROLES_KEY, queryFn: getRoles, staleTime: 5 * 60_000 });
}
export function useAccessAcl() {
  return useQuery({ queryKey: ACCESS_ACL_KEY, queryFn: getAcl, staleTime: 15_000 });
}
export function useAccessRealms() {
  return useQuery({ queryKey: ACCESS_REALMS_KEY, queryFn: getRealms, staleTime: 5 * 60_000 });
}

/**
 * The userid the signed-in session belongs to (`name@realm`), or `undefined` when there is no
 * personal account behind the identity (the shared service token). Fixture mode pretends to be
 * `FIXTURE_ACCESS_SELF` so the demo can show the self-service password change.
 */
export function useCurrentUserid(): string | undefined {
  const { data: auth } = useAuthMe();
  if (USE_FIXTURES) return FIXTURE_ACCESS_SELF;
  return auth?.mode === 'session' ? auth.username : undefined;
}

/** Whether writes are possible at all: a real session (or the demo). Token mode is read-only. */
export function useAccessSessionMode(): boolean {
  const { data: auth } = useAuthMe();
  return USE_FIXTURES || auth?.mode === 'session';
}

/**
 * ACL path suggestions for the "Add permission" dialog: the fixed roots plus one entry per node,
 * guest, storage and pool the cluster has. Free text is still accepted -- this only feeds a
 * `<datalist>`.
 */
export function useAccessPathSuggestions(): string[] {
  const resources = useClusterResources();
  const pools = useQuery({ queryKey: ACCESS_POOLS_KEY, queryFn: getPoolIds, staleTime: 60_000 });
  return useMemo(() => {
    const paths = new Set<string>(['/', '/access', '/access/groups', '/access/realm/pam', '/access/realm/pve', '/nodes', '/pool', '/storage', '/vms']);
    for (const r of resources.data ?? []) {
      if (r.type === 'node') paths.add(`/nodes/${r.node}`);
      else if ((r.type === 'qemu' || r.type === 'lxc') && r.vmid !== undefined) paths.add(`/vms/${r.vmid}`);
      else if (r.type === 'storage' && r.storage) paths.add(`/storage/${r.storage}`);
    }
    for (const p of pools.data ?? []) paths.add(`/pool/${p}`);
    return [...paths].sort();
  }, [resources.data, pools.data]);
}

// --- writes (toast on success; the dialog shows the server's message inline on error) ------------

export function useCreateUser() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: CreateUserBody) => createUser(body),
    onSuccess: (_result, body) => {
      toast.success(`User ${body.userid} created`);
      void queryClient.invalidateQueries({ queryKey: ACCESS_USERS_KEY });
    },
  });
}

export function useUpdateUser() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (vars: { userid: string; body: UpdateUserBody }) => updateUser(vars.userid, vars.body),
    onSuccess: (_result, vars) => {
      toast.success(`User ${vars.userid} saved`);
      void queryClient.invalidateQueries({ queryKey: ACCESS_USERS_KEY });
    },
  });
}

export function useDeleteUser() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (userid: string) => deleteUser(userid),
    onSuccess: (_result, userid) => {
      toast.success(`User ${userid} deleted`);
      void queryClient.invalidateQueries({ queryKey: ACCESS_USERS_KEY });
      void queryClient.invalidateQueries({ queryKey: ACCESS_ACL_KEY });
    },
  });
}

export function useChangePassword() {
  return useMutation({
    mutationFn: (body: ChangePasswordBody) => changePassword(body),
    onSuccess: (_result, body) => {
      toast.success(`Password changed for ${body.userid}`);
    },
  });
}

export function useCreateGroup() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: { groupid: string; comment?: string }) => createGroup(body),
    onSuccess: (_result, body) => {
      toast.success(`Group ${body.groupid} created`);
      void queryClient.invalidateQueries({ queryKey: ACCESS_GROUPS_KEY });
    },
  });
}

export function useUpdateGroup() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (vars: { groupid: string; comment: string }) => updateGroup(vars.groupid, { comment: vars.comment }),
    onSuccess: (_result, vars) => {
      toast.success(`Group ${vars.groupid} saved`);
      void queryClient.invalidateQueries({ queryKey: ACCESS_GROUPS_KEY });
    },
  });
}

export function useDeleteGroup() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (groupid: string) => deleteGroup(groupid),
    onSuccess: (_result, groupid) => {
      toast.success(`Group ${groupid} deleted`);
      void queryClient.invalidateQueries({ queryKey: ACCESS_GROUPS_KEY });
      void queryClient.invalidateQueries({ queryKey: ACCESS_USERS_KEY });
      void queryClient.invalidateQueries({ queryKey: ACCESS_ACL_KEY });
    },
  });
}

export function useSetAcl() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: AclBody) => setAcl(body),
    onSuccess: (_result, body) => {
      toast.success(body.remove ? `Permission on ${body.path} removed` : `Permission on ${body.path} added`);
      void queryClient.invalidateQueries({ queryKey: ACCESS_ACL_KEY });
    },
  });
}

/**
 * Resolves with the token's secret; the caller shows it once and must not keep it anywhere else.
 * `gcTime: 0` drops the mutation result (and with it the secret) from react-query's mutation cache
 * as soon as the dialog that made the call unmounts.
 */
export function useCreateToken() {
  const queryClient = useQueryClient();
  return useMutation({
    gcTime: 0,
    mutationFn: (vars: { userid: string; body: CreateTokenBody }) => createToken(vars.userid, vars.body),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ACCESS_USERS_KEY });
    },
  });
}

export function useUpdateToken() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (vars: { userid: string; tokenid: string; body: UpdateTokenBody }) =>
      updateToken(vars.userid, vars.tokenid, vars.body),
    onSuccess: (_result, vars) => {
      toast.success(`Token ${vars.userid}!${vars.tokenid} saved`);
      void queryClient.invalidateQueries({ queryKey: ACCESS_USERS_KEY });
    },
  });
}

export function useDeleteToken() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (vars: { userid: string; tokenid: string }) => deleteToken(vars.userid, vars.tokenid),
    onSuccess: (_result, vars) => {
      toast.success(`Token ${vars.userid}!${vars.tokenid} deleted`);
      void queryClient.invalidateQueries({ queryKey: ACCESS_USERS_KEY });
      void queryClient.invalidateQueries({ queryKey: ACCESS_ACL_KEY });
    },
  });
}
