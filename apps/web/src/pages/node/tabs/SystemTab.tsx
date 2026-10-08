import { useState } from 'react';

import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { CertificatesPanel } from '@/components/nodesystem/CertificatesPanel';
import { DnsPanel } from '@/components/nodesystem/DnsPanel';
import { HostsPanel } from '@/components/nodesystem/HostsPanel';
import { OptionsPanel } from '@/components/nodesystem/OptionsPanel';
import { TimePanel } from '@/components/nodesystem/TimePanel';
import { useSystemGate } from '@/components/nodesystem/systemGate';
import type { NodeTabProps } from '@/pages/node/tabs';

const SUB_TABS = [
  { value: 'dns', label: 'DNS' },
  { value: 'time', label: 'Time' },
  { value: 'options', label: 'Options' },
  { value: 'hosts', label: 'Hosts' },
  { value: 'certificates', label: 'Certificates' },
] as const;
type SubTab = (typeof SUB_TABS)[number]['value'];

/**
 * Node -> System (T71): PVE's node System panels -- DNS, Time, Options and Hosts -- plus the
 * node's Certificates, as inner sub-tabs. Reads go through the read-only `/api/pve/*` proxy; writes
 * go through `/api/actions/node/:node/system/*`, and every write control is disabled in
 * service-token mode or without `Sys.Modify` on the node (the server enforces both regardless).
 * Uploading or removing a custom certificate restarts Proxmox's web proxy and sits behind a typed
 * confirmation.
 */
export function SystemTab({ node }: NodeTabProps) {
  const disabledReason = useSystemGate(node);
  const [sub, setSub] = useState<SubTab>('dns');

  return (
    <div data-testid="node-system-tab" className="flex flex-col gap-3">
      <h2 className="text-sm font-medium text-muted-foreground">System settings of {node}</h2>
      <Tabs value={sub} onValueChange={(v) => setSub(v as SubTab)}>
        <TabsList className="max-w-full overflow-x-auto">
          {SUB_TABS.map((t) => (
            <TabsTrigger key={t.value} value={t.value}>
              {t.label}
            </TabsTrigger>
          ))}
        </TabsList>
        <TabsContent value="dns">
          <DnsPanel node={node} disabledReason={disabledReason} />
        </TabsContent>
        <TabsContent value="time">
          <TimePanel node={node} disabledReason={disabledReason} />
        </TabsContent>
        <TabsContent value="options">
          <OptionsPanel node={node} disabledReason={disabledReason} />
        </TabsContent>
        <TabsContent value="hosts">
          <HostsPanel node={node} disabledReason={disabledReason} />
        </TabsContent>
        <TabsContent value="certificates">
          <CertificatesPanel node={node} disabledReason={disabledReason} />
        </TabsContent>
      </Tabs>
    </div>
  );
}

export default SystemTab;
