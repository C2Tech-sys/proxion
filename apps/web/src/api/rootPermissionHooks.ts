import { useQuery } from '@tanstack/react-query';

import { USE_FIXTURES } from '@/api/client';
import type { GuestPermissions } from '@/api/actionHooks';

const ALL_PRIVILEGES: GuestPermissions = { can: () => true };

/** Real PVE nests the result under the requested path (`{ "/": { "Sys.Modify": 1 } }`); falls back
 *  to a flat map in case that ever changes (mirrors the server's own handling). */
function scopedPermissions(envelopeData: unknown, path: string): Record<string, unknown> {
  if (!envelopeData || typeof envelopeData !== 'object') return {};
  const record = envelopeData as Record<string, unknown>;
  const scoped = record[path];
  if (scoped && typeof scoped === 'object') return scoped as Record<string, unknown>;
  return record;
}

/**
 * The caller's PVE permissions at the root path (`GET /access/permissions?path=/`, through the
 * read-only `/api/pve/*` proxy) -- same shape and rationale as `usePermissions`/`useNodePermissions`
 * in `actionHooks.ts`, scoped to `/` for the settings that need `Sys.Modify` there (the
 * notification settings, T64). Fixture mode never makes the request -- the demo reports every
 * privilege as granted. Gating only: the server enforces the privilege on every write regardless.
 */
export function useRootPermissions() {
  return useQuery({
    queryKey: ['root-permissions'],
    queryFn: async (): Promise<GuestPermissions> => {
      const res = await fetch(`/api/pve/access/permissions?path=${encodeURIComponent('/')}`);
      if (!res.ok) throw new Error(`Failed to load permissions for /: ${res.status}`);
      const envelope = (await res.json()) as { data?: unknown };
      const scoped = scopedPermissions(envelope.data, '/');
      return { can: (privilege: string) => Boolean(scoped[privilege]) };
    },
    enabled: !USE_FIXTURES,
    staleTime: 5 * 60 * 1000,
    ...(USE_FIXTURES ? { initialData: ALL_PRIVILEGES } : {}),
  });
}
