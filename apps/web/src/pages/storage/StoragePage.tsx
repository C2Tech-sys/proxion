import { useMemo } from 'react';
import { getRouteApi, Link } from '@tanstack/react-router';

import { ObjectHeader } from '@/components/ObjectHeader';
import { Panel } from '@/components/Panel';
import { KeyValueGrid } from '@/components/KeyValueGrid';
import { UsageBar } from '@/components/UsageBar';
import { TagChip } from '@/components/TagChip';
import { EmptyState } from '@/components/EmptyState';
import { Skeleton } from '@/components/ui/skeleton';
import { StorageContentBrowser } from '@/components/storage/StorageContentBrowser';
import { useClusterResources } from '@/api/hooks';
import { errorMessage } from '@/api/errors';
import { formatBytes, formatPercent } from '@/lib/format';
import { DEFAULT_STORAGE_BROWSER_STATE, toStorageSearch, type StorageBrowserState } from '@/lib/storageList';

const routeApi = getRouteApi('/_shell/storage/$node/$storage');

/**
 * The vSphere-style storage object page (T28): a summary strip (status, type, shared/enabled,
 * content types, usage) plus the shared content browser, for one storage on one node. Storage is
 * deliberately node-scoped -- a shared storage's content listing is per node in real PVE, so
 * there is no cluster-wide storage page, only this one reached from whichever node it's open on.
 */
export function StoragePage() {
  const { node, storage } = routeApi.useParams();
  const search = routeApi.useSearch();
  const navigate = routeApi.useNavigate();
  const { data: resources, isLoading, isError, error } = useClusterResources();

  const state: StorageBrowserState = {
    type: search.type ?? DEFAULT_STORAGE_BROWSER_STATE.type,
    q: search.q ?? DEFAULT_STORAGE_BROWSER_STATE.q,
    sort: search.sort ?? DEFAULT_STORAGE_BROWSER_STATE.sort,
    dir: search.dir ?? DEFAULT_STORAGE_BROWSER_STATE.dir,
  };

  function updateState(partial: Partial<StorageBrowserState>) {
    void navigate({ search: toStorageSearch({ ...state, ...partial }), replace: true });
  }

  const resource = useMemo(
    () => (resources ?? []).find((r) => r.type === 'storage' && r.node === node && r.storage === storage),
    [resources, node, storage],
  );

  // Real PVE: a storage marked `shared` is configured identically on every node that can reach
  // it, so the same storage name shows up as a separate `/cluster/resources` row per node -- this
  // is just that fact surfaced as a note, not a fetch of its own.
  const otherNodes = useMemo(() => {
    if (!resource || resource.shared !== 1) return [];
    return [
      ...new Set(
        (resources ?? [])
          .filter((r) => r.type === 'storage' && r.storage === storage && r.node !== node)
          .map((r) => r.node),
      ),
    ];
  }, [resources, node, storage, resource]);

  if (isLoading) {
    return (
      <div className="flex flex-col gap-3 p-4">
        <Skeleton className="h-8 w-64" />
        <Skeleton className="h-40" />
      </div>
    );
  }

  if (isError) {
    return (
      <div className="p-4">
        <EmptyState message={`Could not load storage: ${errorMessage(error)}`} />
      </div>
    );
  }

  if (!resource) {
    return (
      <div className="p-4">
        <EmptyState
          message={`Storage "${storage}" was not found on "${node}".`}
          action={
            <Link
              to="/node/$node"
              params={{ node }}
              search={{ tab: 'storage' }}
              className="text-accent hover:underline"
            >
              Back to node
            </Link>
          }
        />
      </div>
    );
  }

  const used = resource.disk ?? 0;
  const total = resource.maxdisk ?? 0;
  const avail = Math.max(0, total - used);
  const fraction = total ? used / total : 0;
  const contentTypes = (resource.content ?? '').split(',').filter(Boolean);
  // Cluster resources only ever report `status: 'available' | 'unknown'` for a storage (real PVE
  // has no separate "enabled" flag at this level) -- "active" reads directly off that.
  const isActive = resource.status === 'available';

  return (
    <div className="flex h-full min-h-0 flex-1 flex-col">
      <ObjectHeader
        breadcrumb={[
          { label: 'Datacenter', to: 'home' },
          { label: node, to: 'node', node },
          { label: storage },
        ]}
        name={storage}
        status={resource.status}
        node={node}
      />

      <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-4">
        {otherNodes.length > 0 && (
          <p className="text-xs text-muted-foreground">
            Shared storage: also visible from {otherNodes.join(', ')}
          </p>
        )}

        <Panel title="Summary">
          <div className="flex flex-col gap-3">
            <KeyValueGrid
              rows={[
                { label: 'Type', value: resource.plugintype ?? '-' },
                { label: 'Status', value: isActive ? 'Active' : 'Inactive' },
                { label: 'Shared', value: resource.shared === 1 ? 'Yes' : 'No' },
                { label: 'Used', value: formatBytes(used) },
                { label: 'Total', value: formatBytes(total) },
                { label: 'Available', value: formatBytes(avail) },
              ]}
            />
            <UsageBar fraction={fraction} label={`${formatBytes(used)} / ${formatBytes(total)} (${formatPercent(fraction)})`} />
            <div className="flex flex-col gap-1">
              <span className="text-xs font-medium tracking-[0.08em] text-muted-foreground uppercase">Content types</span>
              <div className="flex flex-wrap gap-1">
                {contentTypes.length === 0 ? (
                  <span className="text-xs text-muted-foreground">None configured.</span>
                ) : (
                  contentTypes.map((c) => <TagChip key={c} tag={c} />)
                )}
              </div>
            </div>
          </div>
        </Panel>

        <Panel title="Content" className="min-h-0 flex-1">
          <StorageContentBrowser node={node} storage={storage} mode="page" state={state} onStateChange={updateState} />
        </Panel>
      </div>
    </div>
  );
}
