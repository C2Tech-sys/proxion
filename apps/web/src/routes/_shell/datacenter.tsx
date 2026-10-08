import { createFileRoute } from '@tanstack/react-router';

import { DatacenterPage } from '@/pages/datacenter/DatacenterPage';
import { isDatacenterTab, type DatacenterTab } from '@/pages/datacenter/tabs';

export const Route = createFileRoute('/_shell/datacenter')({
  validateSearch: (search: Record<string, unknown>): { tab: DatacenterTab } => ({
    tab: isDatacenterTab(search.tab) ? search.tab : 'overview',
  }),
  component: DatacenterRoute,
});

function DatacenterRoute() {
  const { tab } = Route.useSearch();
  const navigate = Route.useNavigate();

  function setTab(next: string) {
    // Merge onto the previous search so any param a future tab adds survives a tab switch.
    void navigate({
      search: (prev) => ({ ...prev, tab: isDatacenterTab(next) ? next : 'overview' }),
      replace: true,
    });
  }

  return <DatacenterPage tab={tab} onTabChange={setTab} />;
}
