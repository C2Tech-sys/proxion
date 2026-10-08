import { useState } from 'react';

import { EmptyState } from '@/components/EmptyState';
import { Panel } from '@/components/Panel';
import { Skeleton } from '@/components/ui/skeleton';
import { Tabs, TabsContent } from '@/components/ui/tabs';
import { TabStrip } from '@/components/TabStrip';
import { AliasesPanel } from '@/components/clusterfirewall/AliasesPanel';
import { ClusterOptionsCard } from '@/components/clusterfirewall/ClusterOptionsCard';
import { ClusterRulesPanel } from '@/components/clusterfirewall/ClusterRulesPanel';
import { IpSetsPanel } from '@/components/clusterfirewall/IpSetsPanel';
import { SecurityGroupsPanel } from '@/components/clusterfirewall/SecurityGroupsPanel';
import { useClusterFirewallGate } from '@/components/clusterfirewall/helpers';
import { errorMessage } from '@/api/errors';
import { useClusterOptions } from '@/api/clusterFirewallHooks';

const SUB_TABS = [
  { value: 'rules', label: 'Rules' },
  { value: 'options', label: 'Options' },
  { value: 'groups', label: 'Security Groups' },
  { value: 'aliases', label: 'Aliases' },
  { value: 'ipsets', label: 'IP Sets' },
] as const;

type SubTab = (typeof SUB_TABS)[number]['value'];

function OptionsSection({ disabledReason }: { disabledReason: string | undefined }) {
  const options = useClusterOptions();
  if (options.isLoading) return <Skeleton className="h-40 w-full" />;
  if (options.isError) {
    return (
      <Panel title="Options">
        <EmptyState message={`Could not load the firewall options: ${errorMessage(options.error)}`} />
      </Panel>
    );
  }
  if (!options.data) return null;
  // Re-seat the form whenever the options are re-read (the digest changes on every write).
  return <ClusterOptionsCard key={options.data.digest ?? 'options'} options={options.data} disabledReason={disabledReason} />;
}

/**
 * PVE's Datacenter -> Firewall: the cluster-wide rules, the firewall options, security groups,
 * aliases and IP sets as inner sub-tabs. Reads go through the read-only `/api/pve/cluster/firewall/*`
 * proxy; every change goes through the allow-listed `/api/actions/datacenter/firewall/*` routes,
 * which need a signed-in session and `Sys.Modify` on `/` -- the controls are gated on the same two
 * conditions, a disabled one carrying the reason as its tooltip. Switching the datacenter firewall
 * on asks for a typed confirmation first (it can lock the operator out of every node).
 */
export function ClusterFirewallTab() {
  const [sub, setSub] = useState<SubTab>('rules');
  const { disabledReason } = useClusterFirewallGate();

  return (
    <div data-testid="dc-firewall-tab">
      <Tabs value={sub} onValueChange={(next) => setSub(next as SubTab)}>
        <TabStrip tabs={[...SUB_TABS]} />
        <TabsContent value="rules">
          <ClusterRulesPanel scope={{ kind: 'cluster' }} title="Rules" disabledReason={disabledReason} />
        </TabsContent>
        <TabsContent value="options">
          <OptionsSection disabledReason={disabledReason} />
        </TabsContent>
        <TabsContent value="groups">
          <SecurityGroupsPanel disabledReason={disabledReason} />
        </TabsContent>
        <TabsContent value="aliases">
          <AliasesPanel disabledReason={disabledReason} />
        </TabsContent>
        <TabsContent value="ipsets">
          <IpSetsPanel disabledReason={disabledReason} />
        </TabsContent>
      </Tabs>
    </div>
  );
}

export default ClusterFirewallTab;
