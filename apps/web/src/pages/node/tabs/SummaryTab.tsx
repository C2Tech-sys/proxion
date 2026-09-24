import { Link } from '@tanstack/react-router';

import { Panel } from '@/components/Panel';
import { KeyValueGrid } from '@/components/KeyValueGrid';
import { UsageBar } from '@/components/UsageBar';
import { EmptyState } from '@/components/EmptyState';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { useNodeNetwork, useNodeServices, useNodeStatus } from '@/api/hooks';
import { isNotFoundError, errorMessage } from '@/api/errors';
import { formatMemDetail, formatUptime } from '@/lib/format';
import type { NodeTabProps } from '@/pages/node/tabs';
import type { NodeService } from '@/api/types';

const SERVICE_STATE_VARIANT: Record<string, 'default' | 'secondary' | 'destructive'> = {
  running: 'default',
  failed: 'destructive',
};

function ServiceChip({ service }: { service: NodeService }) {
  const variant = SERVICE_STATE_VARIANT[service.state] ?? 'secondary';
  return (
    <div className="flex items-center justify-between gap-2 text-sm">
      <span className="truncate text-[13px]" title={service.desc}>
        {service.name}
      </span>
      <Badge variant={variant} className="capitalize">
        {service.state}
      </Badge>
    </div>
  );
}

/** The node Summary tab: system/CPU/memory/root-fs/network/services panel grid. */
export function SummaryTab({ node }: NodeTabProps) {
  const query = useNodeStatus(node);
  const networkQuery = useNodeNetwork(node);
  const servicesQuery = useNodeServices(node);

  if (query.isLoading) {
    return <Skeleton className="h-40" />;
  }

  if (query.isError) {
    if (isNotFoundError(query.error)) {
      return (
        <EmptyState
          message={`Node "${node}" was not found.`}
          action={
            <Link to="/" className="text-accent hover:underline">
              Back to dashboard
            </Link>
          }
            />
      );
    }
    return (
      <EmptyState
        message={`Could not load node status: ${errorMessage(query.error)}`}
        action={
          <Button variant="outline" size="sm" onClick={() => void query.refetch()}>
            Retry
          </Button>
        }
            />
    );
  }

  const status = query.data;
  if (!status) {
    return <Skeleton className="h-40" />;
  }

  const { cpuinfo, memory, swap, rootfs, loadavg } = status;
  const threads =
    cpuinfo.sockets && cpuinfo.cores && cpuinfo.cpus % (cpuinfo.sockets * cpuinfo.cores) === 0
      ? cpuinfo.cpus / (cpuinfo.sockets * cpuinfo.cores)
      : undefined;
  const bootInfo = status['boot-info'];

  return (
    <div className="grid grid-cols-1 gap-3 lg:grid-cols-3">
      <Panel title="System">
        <KeyValueGrid
          rows={[
            { label: 'PVE version', value: status.pveversion ?? '-' },
            { label: 'Kernel', value: status.kversion ?? '-' },
            { label: 'Uptime', value: formatUptime(status.uptime) },
            { label: 'Load average (1m)', value: loadavg[0] },
            { label: 'Load average (5m)', value: loadavg[1] },
            { label: 'Load average (15m)', value: loadavg[2] },
            ...(bootInfo
              ? [
                  { label: 'Boot mode', value: bootInfo.mode === 'efi' ? 'EFI' : 'Legacy BIOS' },
                  { label: 'Secure boot', value: bootInfo.secureboot ? 'Enabled' : 'Disabled' },
                ]
              : []),
          ]}
            />
      </Panel>

      <Panel title="CPU">
        <KeyValueGrid
          rows={[
            { label: 'Model', value: cpuinfo.model ?? '-' },
            { label: 'Sockets', value: cpuinfo.sockets ?? '-' },
            { label: 'Cores', value: cpuinfo.cores ?? '-' },
            { label: 'Threads', value: threads ?? '-' },
            { label: 'Total vCPU', value: cpuinfo.cpus },
          ]}
        />
        <div className="mt-3">
          <UsageBar fraction={status.cpu} label={`${(status.cpu * 100).toFixed(0)}%`} />
        </div>
      </Panel>

      <Panel title="Memory">
        <div className="flex flex-col gap-3">
          <div>
            <div className="mb-1 text-xs text-muted-foreground">Used</div>
            <UsageBar fraction={memory.used / memory.total} label={formatMemDetail(memory.used, memory.total)} />
          </div>
          {swap && (
            <div>
              <div className="mb-1 text-xs text-muted-foreground">Swap</div>
              <UsageBar fraction={swap.total ? swap.used / swap.total : 0} label={formatMemDetail(swap.used, swap.total)} />
            </div>
          )}
        </div>
      </Panel>

      <Panel title="Root filesystem">
        {rootfs ? (
          <UsageBar
            fraction={rootfs.total ? rootfs.used / rootfs.total : 0}
            label={formatMemDetail(rootfs.used, rootfs.total)}
          />
        ) : (
          <EmptyState message="No root filesystem data." />
        )}
      </Panel>

      <Panel title="Network" className="lg:col-span-2">
        {networkQuery.isLoading ? (
          <Skeleton className="h-24" />
        ) : networkQuery.isError ? (
          <EmptyState message={`Could not load network interfaces: ${errorMessage(networkQuery.error)}`} />
        ) : !networkQuery.data || networkQuery.data.length === 0 ? (
          <EmptyState message="No configured interfaces." />
        ) : (
          <div className="flex flex-col gap-2">
            {networkQuery.data
              .filter((iface) => iface.type === 'bridge' || iface.type === 'bond')
              .map((iface) => (
                <div key={iface.iface} className="flex items-center justify-between gap-3 border-b border-border pb-1.5 last:border-0 last:pb-0">
                  <div className="flex min-w-0 flex-col">
                    <span className="text-[13px]">{iface.iface}</span>
                    <span className="truncate text-xs text-muted-foreground">
                      {iface.bridge_ports ? `ports: ${iface.bridge_ports}` : iface.comments ?? iface.type}
                    </span>
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    {/* A CIDR is an identifier, but sans not mono (T11) -- same treatment as a
                        configuration method word like "manual". */}
                    {iface.cidr ? (
                      <span className="text-xs text-muted-foreground">{iface.cidr}</span>
                    ) : (
                      <span className="text-xs text-muted-foreground">{iface.method ?? '-'}</span>
                    )}
                    <Badge variant={iface.active ? 'default' : 'secondary'}>{iface.active ? 'active' : 'inactive'}</Badge>
                  </div>
                </div>
              ))}
          </div>
        )}
      </Panel>

      <Panel title="Services">
        {servicesQuery.isLoading ? (
          <Skeleton className="h-32" />
        ) : servicesQuery.isError ? (
          <EmptyState message={`Could not load services: ${errorMessage(servicesQuery.error)}`} />
        ) : !servicesQuery.data || servicesQuery.data.length === 0 ? (
          <EmptyState message="No service data." />
        ) : (
          <div className="flex flex-col gap-1.5">
            {servicesQuery.data.map((service) => (
              <ServiceChip key={service.service} service={service} />
            ))}
          </div>
        )}
      </Panel>
    </div>
  );
}
