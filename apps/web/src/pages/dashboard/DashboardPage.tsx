import { useState } from 'react';
import { useQueries } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { Box, Container, HardDrive, RefreshCw, Server } from 'lucide-react';

import { Breadcrumbs } from '@/components/Breadcrumbs';
import { Panel } from '@/components/Panel';
import { UsageBar } from '@/components/UsageBar';
import { ConsoleThumbnail } from '@/components/ConsoleThumbnail';
import { AlertsStrip } from '@/components/AlertsStrip';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Skeleton } from '@/components/ui/skeleton';
import { EmptyState } from '@/components/EmptyState';
import { TaskStatusIcon } from '@/components/TasksTable';
import { useClusterResources, useTasks } from '@/api/hooks';
import { usePrefs } from '@/api/prefsHooks';
import { api } from '@/api/client';
import { computeClusterTotals, recentTasks, topConsumersByCpu, topConsumersByMemory } from '@/lib/dashboard';
import { formatBytes, formatDateTime, formatDuration, formatPercent, formatUptime } from '@/lib/format';
import { APP_NAME } from '@/lib/app';
import type { ClusterResource, PveTask } from '@/api/types';

function taskDuration(task: PveTask): number {
  return (task.endtime ?? Math.floor(Date.now() / 1000)) - task.starttime;
}

function StatBody({ icon: Icon, primary, secondary }: { icon: typeof Server; primary: string; secondary: string }) {
  return (
    <div className="flex items-center gap-3">
      <Icon className="size-5 text-muted-foreground" />
      <div>
        <div
          data-testid="stat-value"
          className="font-display text-[28px] leading-none font-light tracking-[var(--font-display-tracking)] font-numeric"
        >
          {primary}
        </div>
        <div className="text-xs text-muted-foreground">{secondary}</div>
      </div>
    </div>
  );
}

function NodesPanel({ resources }: { resources: ClusterResource[] }) {
  const nodeRows = resources.filter((r) => r.type === 'node');
  const nodeNames = nodeRows.map((r) => r.node);
  const statusResults = useQueries({
    queries: nodeNames.map((n) => ({
      queryKey: ['node-status', n],
      queryFn: () => api.getNodeStatus(n),
    })),
  });

  if (nodeRows.length === 0) {
    return <EmptyState message="No nodes." />;
  }

  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Node</TableHead>
          <TableHead>Status</TableHead>
          <TableHead className="w-32">CPU</TableHead>
          <TableHead className="w-32">Memory</TableHead>
          <TableHead className="text-right">Storage used</TableHead>
          <TableHead className="text-right">Uptime</TableHead>
          <TableHead>Version</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {nodeRows.map((n, i) => {
          const status = statusResults[i]?.data;
          const cpuFraction = n.cpu ?? 0;
          const memFraction = n.maxmem ? (n.mem ?? 0) / n.maxmem : 0;
          const storageUsed = resources
            .filter((r) => r.type === 'storage' && r.node === n.node)
            .reduce((sum, r) => sum + (r.disk ?? 0), 0);
          return (
            <TableRow key={n.id}>
              <TableCell>
                <Link
                  to="/node/$node"
                  params={{ node: n.node }}
                  search={{ tab: 'summary' }}
                  className="text-accent hover:underline"
                >
                  {n.node}
                </Link>
              </TableCell>
              <TableCell>
                <Badge variant={n.status === 'online' ? 'default' : 'destructive'}>{n.status}</Badge>
              </TableCell>
              <TableCell>
                <UsageBar fraction={cpuFraction} label={formatPercent(cpuFraction)} />
              </TableCell>
              <TableCell>
                <UsageBar fraction={memFraction} label={formatPercent(memFraction)} />
              </TableCell>
              <TableCell className="text-right font-numeric">{formatBytes(storageUsed)}</TableCell>
              <TableCell className="text-right font-numeric">{n.uptime ? formatUptime(n.uptime) : '-'}</TableCell>
              <TableCell className="max-w-56 truncate text-xs text-muted-foreground" title={status?.kversion}>
                {status ? `${status.pveversion ?? '-'} · ${status.kversion ?? '-'}` : <Skeleton className="h-4 w-32" />}
              </TableCell>
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
}

function ConsumerTable({ title, rows }: { title: string; rows: ReturnType<typeof topConsumersByCpu> }) {
  return (
    <div className="flex flex-col gap-1.5">
      <div className="text-xs font-medium tracking-[0.08em] text-muted-foreground uppercase">{title}</div>
      {rows.length === 0 ? (
        <EmptyState message="No running guests." />
      ) : (
        <ul className="flex flex-col gap-1.5">
          {rows.map((row) => (
            <li key={row.id} className="flex items-center gap-2 text-sm">
              <Link
                to="/vm/$node/$type/$vmid"
                params={{ node: row.node, type: row.type, vmid: String(row.vmid) }}
                search={{ tab: 'summary' }}
                className="min-w-0 flex-1 truncate text-accent hover:underline"
              >
                {row.name}
              </Link>
              <UsageBar fraction={row.fraction} label={formatPercent(row.fraction)} />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function StoragePanel({ resources }: { resources: ClusterResource[] }) {
  const storages = resources.filter((r) => r.type === 'storage');
  if (storages.length === 0) return <EmptyState message="No storages." />;
  return (
    <ul className="flex flex-col gap-2.5">
      {storages.map((s) => {
        const used = s.disk ?? 0;
        const total = s.maxdisk ?? 0;
        const contentTypes = (s.content ?? '').split(',').filter(Boolean);
        return (
          <li key={s.id} className="flex flex-col gap-1">
            <div className="flex items-center justify-between gap-2">
              {/* The storage id is an identifier, but sans not mono (T11) -- same face as the
                  "(node)" suffix. */}
              <span className="truncate text-[13px]">
                <span>{s.storage}</span>{' '}
                <span className="text-muted-foreground">({s.node})</span>
              </span>
              <span className="shrink-0 text-xs text-muted-foreground">{s.plugintype}</span>
            </div>
            <div className="flex flex-wrap gap-1">
              {contentTypes.map((c) => (
                <Badge key={c} variant="secondary" className="text-[10px]">
                  {c}
                </Badge>
              ))}
            </div>
            <UsageBar fraction={total ? used / total : 0} label={`${formatBytes(used)} / ${formatBytes(total)}`} />
          </li>
        );
      })}
    </ul>
  );
}

function isRunningNonTemplateGuest(
  r: ClusterResource,
): r is ClusterResource & { type: 'qemu' | 'lxc'; vmid: number } {
  return (r.type === 'qemu' || r.type === 'lxc') && r.status === 'running' && r.template !== 1;
}

/**
 * Live-ish console screenshots for every running guest, sorted by name. Deliberately kept out
 * of the two-column grid below (`lg:col-span-2` on every other panel there) so it spans the
 * full width at 4-5 tiles per row instead of being squeezed into half the page. Hidden entirely
 * -- no empty state, no placeholder -- when nothing is running.
 */
export function ConsolesPanel({ resources }: { resources: ClusterResource[] }) {
  const [refreshToken, setRefreshToken] = useState(0);
  // `consoleThumbnails: false` -- the user turned previews off in Preferences -- hides this
  // whole panel, same as "nothing running" does; `thumbnailRefreshSeconds` (30/60/120/300s)
  // overrides each tile's default background refresh interval.
  const { data: prefs } = usePrefs();
  const runningGuests = resources
    .filter(isRunningNonTemplateGuest)
    .sort((a, b) => (a.name ?? '').localeCompare(b.name ?? ''));

  if (runningGuests.length === 0 || prefs?.consoleThumbnails === false) return null;

  return (
    <Panel
      title={`Consoles (${runningGuests.length})`}
      action={
        <Button
          variant="ghost"
          size="sm"
          className="h-6 gap-1.5 px-2 text-xs"
          onClick={() => setRefreshToken((n) => n + 1)}
        >
          <RefreshCw className="size-3.5" />
          Refresh all
        </Button>
      }
    >
      <div className="grid grid-cols-[repeat(auto-fill,minmax(240px,1fr))] gap-3">
        {runningGuests.map((g) => (
          <ConsoleThumbnail
            key={g.id}
            node={g.node}
            type={g.type}
            vmid={g.vmid}
            name={g.name ?? `${g.type}/${g.vmid}`}
            status={g.status}
            template={g.template === 1}
            refreshToken={refreshToken}
            refreshIntervalMs={
              prefs?.thumbnailRefreshSeconds ? prefs.thumbnailRefreshSeconds * 1000 : undefined
            }
          />
        ))}
      </div>
    </Panel>
  );
}

function RecentTasksPanel({ tasks }: { tasks: PveTask[] }) {
  const recent = recentTasks(tasks, 8);
  if (recent.length === 0) return <EmptyState message="No tasks yet." />;
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead className="w-6"></TableHead>
          <TableHead>Type</TableHead>
          <TableHead>ID</TableHead>
          <TableHead>User</TableHead>
          <TableHead>Started</TableHead>
          <TableHead className="text-right">Duration</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {recent.map((t) => (
          <TableRow key={t.upid}>
            <TableCell>
              <TaskStatusIcon status={t.status} />
            </TableCell>
            <TableCell>{t.type}</TableCell>
            <TableCell className="font-numeric">{t.id}</TableCell>
            <TableCell>{t.user}</TableCell>
            <TableCell className="font-numeric">{formatDateTime(t.starttime)}</TableCell>
            <TableCell className="text-right font-numeric">{formatDuration(taskDuration(t))}</TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

/** Dashboard body: cluster overview built entirely from fixtures -- no charts (Monitor owns those). */
export function DashboardPage() {
  const { data: resources, isLoading: resourcesLoading } = useClusterResources();
  const { data: tasks, isLoading: tasksLoading } = useTasks();
  const totals = resources ? computeClusterTotals(resources) : null;

  const isLoading = resourcesLoading || tasksLoading;

  return (
    <div className="flex flex-col gap-4 p-4">
      <div className="flex flex-col gap-1">
        <Breadcrumbs items={[{ label: 'Datacenter' }]} />
        <h1 className="font-display text-[32px] leading-tight font-light tracking-[var(--font-display-tracking)]">
          {APP_NAME} Dashboard
        </h1>
        <p className="text-sm text-muted-foreground">Cluster overview across the lab.</p>
      </div>

      <AlertsStrip />

      {isLoading || !totals ? (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="h-28" />
          ))}
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Panel title="Nodes">
            <StatBody icon={Server} primary={`${totals.nodesOnline} / ${totals.nodesTotal}`} secondary="online" />
          </Panel>
          <Link to="/guests" search={{ type: 'qemu' }} className="block outline-none">
            <Panel title="Virtual machines" className="transition-colors hover:border-accent/40">
              <StatBody icon={Box} primary={`${totals.vmsRunning}`} secondary={`running · ${totals.vmsStopped} stopped`} />
            </Panel>
          </Link>
          <Link to="/guests" search={{ type: 'lxc' }} className="block outline-none">
            <Panel title="Containers" className="transition-colors hover:border-accent/40">
              <StatBody icon={Container} primary={`${totals.ctsRunning}`} secondary={`running · ${totals.ctsStopped} stopped`} />
            </Panel>
          </Link>
          <Panel title="Storage">
            <StatBody
              icon={HardDrive}
              primary={formatBytes(totals.storageUsed)}
              secondary={`of ${formatBytes(totals.storageTotal)} (${formatPercent(totals.storageTotal ? totals.storageUsed / totals.storageTotal : 0)})`}
            />
          </Panel>
        </div>
      )}

      {!isLoading && resources && <ConsolesPanel resources={resources} />}

      {isLoading || !resources || !tasks ? (
        <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
          <Skeleton className="h-64 lg:col-span-2" />
          <Skeleton className="h-48" />
          <Skeleton className="h-48" />
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
          <Panel title="Cluster nodes" className="lg:col-span-2">
            <NodesPanel resources={resources} />
          </Panel>

          <Panel title="Top consumers">
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <ConsumerTable title="By CPU" rows={topConsumersByCpu(resources, 5)} />
              <ConsumerTable title="By memory" rows={topConsumersByMemory(resources, 5)} />
            </div>
          </Panel>

          <Panel title="Storage">
            <StoragePanel resources={resources} />
          </Panel>

          <Panel
            title="Recent tasks"
            className="lg:col-span-2"
            action={
              <Link to="/tasks" className="text-xs text-accent hover:underline">
                View all
              </Link>
            }
          >
            <RecentTasksPanel tasks={tasks} />
          </Panel>
        </div>
      )}
    </div>
  );
}
