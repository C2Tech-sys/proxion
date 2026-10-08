import { useQuery } from '@tanstack/react-query';

import { USE_FIXTURES } from '@/api/client';
import type { GuestPermissions } from '@/api/actionHooks';

const ALL_PRIVILEGES: GuestPermissions = { can: () => true };

/** Real PVE nests the result under the requested path (`{ "/storage": { "Datastore.Allocate": 1 } }`);
 *  falls back to a flat map in case that ever changes (mirrors the server's own handling). */
function scopedPermissions(envelopeData: unknown, path: string): Record<string, unknown> {
  if (!envelopeData || typeof envelopeData !== 'object') return {};
  const record = envelopeData as Record<string, unknown>;
  const scoped = record[path];
  if (scoped && typeof scoped === 'object') return scoped as Record<string, unknown>;
  return record;
}

/**
 * The caller's PVE permissions on one ACL path (`GET /access/permissions?path=`, through the
 * read-only `/api/pve/*` proxy) -- the same shape and rationale as `usePermissions` /
 * `useNodePermissions` / `useRootPermissions`, for the Datacenter Storage and Pools tabs:
 * `/storage` or `/storage/<id>` (`Datastore.Allocate`) and `/pool` or `/pool/<id>`
 * (`Pool.Allocate`). Fixture mode never makes the request -- the demo reports every privilege as
 * granted. Gating only: the server enforces the privilege on every write regardless.
 */
export function usePathPermissions(path: string) {
  return useQuery({
    queryKey: ['path-permissions', path],
    queryFn: async (): Promise<GuestPermissions> => {
      const res = await fetch(`/api/pve/access/permissions?path=${encodeURIComponent(path)}`);
      if (!res.ok) throw new Error(`Failed to load permissions for ${path}: ${res.status}`);
      const envelope = (await res.json()) as { data?: unknown };
      const scoped = scopedPermissions(envelope.data, path);
      return { can: (privilege: string) => Boolean(scoped[privilege]) };
    },
    enabled: !USE_FIXTURES && Boolean(path),
    staleTime: 5 * 60 * 1000,
    ...(USE_FIXTURES ? { initialData: ALL_PRIVILEGES } : {}),
  });
}
