import { TabStrip } from '@/components/TabStrip';
import { Tabs, TabsContent } from '@/components/ui/tabs';
import { cn } from '@/lib/utils';
import {
  DATACENTER_TAB_ORDER,
  DATACENTER_TAB_REGISTRY,
  type DatacenterTab,
} from '@/pages/datacenter/tabs';

const TAB_DEFS = DATACENTER_TAB_ORDER.map((value) => ({
  value,
  label: DATACENTER_TAB_REGISTRY[value].label,
}));

export interface DatacenterPageProps {
  tab: DatacenterTab;
  onTabChange: (next: string) => void;
}

/** The Datacenter object page: the cluster-wide tab strip. The route (`routes/_shell/
 *  datacenter.tsx`) owns the `?tab=` search param and passes it in, the same split the VM and
 *  node pages use between route and tabs. */
export function DatacenterPage({ tab, onTabChange }: DatacenterPageProps) {
  return (
    // `flex-1 min-h-0` links this into the shell's height chain (see _shell.tsx), so the tab
    // body gets a definite height and scrolls internally rather than the whole page scrolling.
    <div className="flex h-full min-h-0 flex-1 flex-col">
      <Tabs value={tab} onValueChange={onTabChange} className="min-h-0 flex-1 px-4 pt-2">
        <TabStrip tabs={TAB_DEFS} />
        {DATACENTER_TAB_ORDER.map((value) => {
          const { component: TabComponent } = DATACENTER_TAB_REGISTRY[value];
          return (
            <TabsContent
              key={value}
              value={value}
              className={cn(
                'relative min-h-0 flex-1 overflow-y-auto pt-3 pb-3',
                // The Overview tab is the dashboard, which carries its own `p-4` page padding;
                // cancel this strip's side gutter so it is not doubled.
                value === 'overview' && '-mx-4',
              )}
            >
              <TabComponent />
            </TabsContent>
          );
        })}
      </Tabs>
    </div>
  );
}

export default DatacenterPage;
