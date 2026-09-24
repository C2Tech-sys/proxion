import { createFileRoute, notFound, Link } from '@tanstack/react-router';

import { ObjectHeader } from '@/components/ObjectHeader';
import { TabStrip } from '@/components/TabStrip';
import { EmptyState } from '@/components/EmptyState';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Tabs, TabsContent } from '@/components/ui/tabs';
import { useVmConfig, useVmStatus } from '@/api/hooks';
import { isNotFoundError, errorMessage } from '@/api/errors';
import { parseTags } from '@/lib/format';
import { cn } from '@/lib/utils';
import { isVmRrdTimeframe, type VmRrdTimeframe } from '@/lib/rrd';
import { VM_TAB_ORDER, VM_TAB_REGISTRY, isVmTab, type VmTab } from '@/pages/vm/tabs';
import type { GuestType } from '@/api/types';

export const Route = createFileRoute('/_shell/vm/$node/$type/$vmid')({
  // `range` is optional in the schema so navigations from elsewhere (e.g. the inventory tree,
  // the command palette) that only set `tab` keep type-checking; MonitorTab defaults it to
  // 'hour' when reading, same as validateSearch does here when parsing the URL.
  validateSearch: (search: Record<string, unknown>): { tab: VmTab; range?: VmRrdTimeframe } => ({
    tab: isVmTab(search.tab) ? search.tab : 'summary',
    // Absent when the URL has none: the Monitor tab then applies the user's default-range
    // preference (Preferences page) and everything else reads `range ?? 'hour'`.
    ...(isVmRrdTimeframe(search.range) ? { range: search.range } : {}),
  }),
  beforeLoad: ({ params }) => {
    if (params.type !== 'qemu' && params.type !== 'lxc') {
      throw notFound();
    }
  },
  component: VmPage,
});

const TAB_DEFS = VM_TAB_ORDER.map((value) => ({ value, label: VM_TAB_REGISTRY[value].label }));

function VmPage() {
  const { node, type, vmid } = Route.useParams();
  const { tab } = Route.useSearch();
  const navigate = Route.useNavigate();
  const guestType = type as GuestType;
  const numericVmid = Number(vmid);

  function setTab(next: string) {
    // Merge onto the previous search (rather than replacing it outright) so `?range=` -- and
    // any other search param a future tab adds -- survives a plain tab switch.
    void navigate({
      search: (prev) => ({ ...prev, tab: isVmTab(next) ? next : 'summary' }),
      replace: true,
    });
  }

  const statusQuery = useVmStatus(node, guestType, numericVmid);
  const configQuery = useVmConfig(node, guestType, numericVmid);

  if (statusQuery.isLoading || configQuery.isLoading) {
    return (
      <div className="flex flex-col gap-3 p-4">
        <Skeleton className="h-8 w-64" />
        <Skeleton className="h-64" />
      </div>
    );
  }

  const queryError = statusQuery.error ?? configQuery.error;
  if (statusQuery.isError || configQuery.isError) {
    if (isNotFoundError(queryError)) {
      return (
        <div className="p-4">
          <EmptyState
            message={`${guestType === 'lxc' ? 'Container' : 'VM'} ${numericVmid} was not found on "${node}".`}
            action={
              <Link to="/" className="text-accent hover:underline">
                Back to dashboard
              </Link>
            }
          />
        </div>
      );
    }
    return (
      <div className="p-4">
        <EmptyState
          message={`Could not load this object: ${errorMessage(queryError)}`}
          action={
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                void statusQuery.refetch();
                void configQuery.refetch();
              }}
            >
              Retry
            </Button>
          }
        />
      </div>
    );
  }

  const status = statusQuery.data;
  const config = configQuery.data;
  if (!status || !config) {
    // Shouldn't normally happen (covered by isLoading/isError above), but keeps types honest.
    return (
      <div className="flex flex-col gap-3 p-4">
        <Skeleton className="h-8 w-64" />
        <Skeleton className="h-64" />
      </div>
    );
  }

  const tags = parseTags(status.tags);
  const guestName = status.name ?? config.name ?? `VM ${numericVmid}`;

  return (
    // `flex-1 min-h-0` links this into the shell's height chain (see _shell.tsx) so the tab
    // body below gets a definite height instead of growing to content -- required for a
    // console/terminal tab's `h-full` to mean anything, and for the other tabs to scroll
    // internally (one scrollbar, in the tab body) instead of the whole page scrolling.
    <div className="flex h-full min-h-0 flex-1 flex-col">
      <ObjectHeader
        breadcrumb={[
          { label: 'Datacenter', to: 'home' },
          { label: node, to: 'node', node },
          { label: guestName },
        ]}
        name={guestName}
        vmid={numericVmid}
        status={status.status}
        template={status.template === 1}
        node={node}
        type={guestType}
        uptime={status.uptime}
        tags={tags}
      />

      <Tabs value={tab} onValueChange={setTab} className="min-h-0 flex-1 px-4 pt-2">
        <TabStrip tabs={TAB_DEFS} />
        {VM_TAB_ORDER.map((value) => {
          const { component: TabComponent } = VM_TAB_REGISTRY[value];
          return (
            <TabsContent
              key={value}
              value={value}
              className={cn(
                // `relative`: this is the scroll/clip container a chart's absolutely-positioned
                // sr-only fallback table should be contained by -- see TimeSeriesChart.tsx.
                'relative min-h-0 flex-1 overflow-y-auto pt-3',
                // The Console tab is a full-bleed terminal/VNC surface that fills this box with
                // `h-full` (see console/layout.ts) -- the bottom `py-3` padding every other tab
                // gets would show up as dead space between it and the tasks drawer below.
                value === 'console' ? 'pb-0' : 'pb-3',
              )}
            >
              <TabComponent node={node} type={guestType} vmid={numericVmid} />
            </TabsContent>
          );
        })}
      </Tabs>
    </div>
  );
}
