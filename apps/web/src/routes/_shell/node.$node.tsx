import { createFileRoute, Link } from '@tanstack/react-router';

import { Breadcrumbs } from '@/components/Breadcrumbs';
import { EmptyState } from '@/components/EmptyState';
import { StatusDot } from '@/components/StatusDot';
import { TabStrip } from '@/components/TabStrip';
import { Tabs, TabsContent } from '@/components/ui/tabs';
import { useNodeStatus } from '@/api/hooks';
import { isNotFoundError } from '@/api/errors';
import { formatUptime } from '@/lib/format';
import { cn } from '@/lib/utils';
import { isNodeRrdTimeframe, type NodeRrdTimeframe } from '@/lib/rrd';
import { NODE_TAB_ORDER, NODE_TAB_REGISTRY, isNodeTab, type NodeTab } from '@/pages/node/tabs';

export const Route = createFileRoute('/_shell/node/$node')({
  // `range` is optional in the schema so navigations from elsewhere (e.g. the inventory tree,
  // the command palette) that only set `tab` keep type-checking; MonitorTab defaults it to
  // 'hour' when reading, same as validateSearch does here when parsing the URL.
  validateSearch: (
    search: Record<string, unknown>,
  ): { tab: NodeTab; range?: NodeRrdTimeframe } => ({
    tab: isNodeTab(search.tab) ? search.tab : 'summary',
    // Absent when the URL has none: the Monitor tab then applies the user's default-range
    // preference (Preferences page) and everything else reads `range ?? 'hour'`.
    ...(isNodeRrdTimeframe(search.range) ? { range: search.range } : {}),
  }),
  component: NodePage,
});

const TAB_DEFS = NODE_TAB_ORDER.map((value) => ({ value, label: NODE_TAB_REGISTRY[value].label }));

function NodePage() {
  const { node } = Route.useParams();
  const { tab } = Route.useSearch();
  const navigate = Route.useNavigate();
  const { data: status, error } = useNodeStatus(node);

  function setTab(next: string) {
    // Merge onto the previous search (rather than replacing it outright) so `?range=` -- and
    // any other search param a future tab adds -- survives a plain tab switch.
    void navigate({
      search: (prev) => ({ ...prev, tab: isNodeTab(next) ? next : 'summary' }),
      replace: true,
    });
  }

  // Fix-wave 3, F5: a node that doesn't exist gets ONLY the not-found empty state. Previously
  // the header rendered unconditionally, asserting a green "online" StatusDot and a heading for
  // a node the API had just said does not exist.
  if (isNotFoundError(error)) {
    return (
      <div className="p-4">
        <EmptyState
          message={`Node "${node}" was not found.`}
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
    // `flex-1 min-h-0` links this into the shell's height chain (see _shell.tsx) so the tab
    // body below gets a definite height instead of growing to content -- required for the
    // Shell tab's `h-full` terminal to mean anything, and for the other tabs to scroll
    // internally (one scrollbar, in the tab body) instead of the whole page scrolling.
    <div className="flex h-full min-h-0 flex-1 flex-col">
      {/* Same two-row shape as ObjectHeader.tsx (T10b, finding 2): title + type label on the
          title row, uptime as metadata on its own 13px line below. */}
      <div className="flex flex-col gap-1 border-b border-border px-4 py-2.5">
        <Breadcrumbs items={[{ label: 'Datacenter', to: 'home' }, { label: node }]} />
        <div className="flex items-center gap-2">
          <StatusDot status="online" />
          <h1 className="min-w-0 truncate font-display text-[26px] leading-tight font-light tracking-[var(--font-display-tracking)]">
            {node}
          </h1>
          <span className="shrink-0 text-xs text-muted-foreground">Node</span>
        </div>
        {status && (
          <div className="flex items-center gap-2 text-[13px] text-muted-foreground">
            <span className="font-numeric">up {formatUptime(status.uptime)}</span>
          </div>
        )}
      </div>

      <Tabs value={tab} onValueChange={setTab} className="min-h-0 flex-1 px-4 pt-2">
        <TabStrip tabs={TAB_DEFS} />
        {NODE_TAB_ORDER.map((value) => {
          const { component: TabComponent } = NODE_TAB_REGISTRY[value];
          return (
            <TabsContent
              key={value}
              value={value}
              className={cn(
                // `relative`: this is the scroll/clip container a chart's absolutely-positioned
                // sr-only fallback table should be contained by -- see TimeSeriesChart.tsx.
                'relative min-h-0 flex-1 overflow-y-auto pt-3',
                // The Shell tab is a full-bleed terminal surface that fills this box with
                // `h-full` (see console/layout.ts) -- the bottom `py-3` padding every other tab
                // gets would show up as dead space between it and the tasks drawer below.
                value === 'shell' ? 'pb-0' : 'pb-3',
              )}
            >
              <TabComponent node={node} />
            </TabsContent>
          );
        })}
      </Tabs>
    </div>
  );
}
