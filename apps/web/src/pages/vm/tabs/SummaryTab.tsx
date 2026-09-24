import { useState, type DragEvent, type ReactNode } from 'react';
import { Copy, GripVertical, HardDrive, Network, Pencil } from 'lucide-react';
import { toast } from 'sonner';

import { ArrangeablePanel } from '@/components/ArrangeablePanel';
import { KeyValueGrid } from '@/components/KeyValueGrid';
import { Gauge } from '@/components/Gauge';
import { Sparkline } from '@/components/Sparkline';
import { EmptyState } from '@/components/EmptyState';
import { ConsoleThumbnail } from '@/components/ConsoleThumbnail';
import { NotesEditor } from '@/components/NotesEditor';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { usePrefs, useUpdatePrefs } from '@/api/prefsHooks';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Link } from '@tanstack/react-router';
import {
  useAgentInterfaces,
  useAuthMe,

  useAlerts,
  useClusterResources,
  useNodeTasks,
  useRrd,
  useVmConfig,
  useVmStatus,
} from '@/api/hooks';
import { usePermissions } from '@/api/actionHooks';
import { USE_FIXTURES } from '@/api/client';
import { errorMessage } from '@/api/errors';
import {
  formatBytes,
  formatDateTime,
  formatDriveSize,
  formatDuration,
  formatMemDetail,
} from '@/lib/format';
import {
  getDrives,
  getNics,
  getRootfsDrive,
  osTypeLabel,
  type ParsedDrive,
} from '@/lib/pve-config';
import { vmSeries } from '@/lib/rrd';
import { cn } from '@/lib/utils';
import { moveId, normaliseOrder, reorderByDrop } from '@/pages/vm/summaryLayout';
import type { VmTabProps } from '@/pages/vm/tabs';
import type { GuestConfig } from '@/api/types';

function copy(value: string, label: string) {
  navigator.clipboard
    ?.writeText(value)
    .then(() => toast.success(`Copied ${label}`))
    .catch(() => toast.error(`Could not copy ${label}`));
}

/**
 * Short relative age for the Last backup panel's "Started" row, e.g. `"14h ago"` -- next to,
 * not in place of, the absolute `formatDateTime` value. Local to this tab (matching
 * `balloonLabel` below) rather than a shared `lib/format.ts` export: this ticket's write set
 * doesn't touch that file.
 */
function formatRelativeTime(unixSeconds: number, nowMs: number = Date.now()): string {
  if (!Number.isFinite(unixSeconds) || unixSeconds <= 0) return '-';
  const deltaSeconds = Math.max(0, Math.round(nowMs / 1000 - unixSeconds));
  if (deltaSeconds < 5) return 'just now';
  if (deltaSeconds < 60) return `${deltaSeconds}s ago`;
  const deltaMinutes = Math.round(deltaSeconds / 60);
  if (deltaMinutes < 60) return `${deltaMinutes}m ago`;
  const deltaHours = Math.round(deltaMinutes / 60);
  if (deltaHours < 24) return `${deltaHours}h ago`;
  const deltaDays = Math.round(deltaHours / 24);
  return `${deltaDays}d ago`;
}

/** `balloon` is MiB: `0` -> ballooning disabled, absent -> not configured, N -> N MiB min. */
function balloonLabel(config: GuestConfig): string {
  const balloon = config.balloon;
  if (balloon === undefined) return 'not configured';
  if (balloon === 0) return 'disabled';
  return `${balloon} MiB min`;
}

interface SummaryPanelContent {
  title: string;
  span: 1 | 2;
  action?: ReactNode;
  content: ReactNode;
}

type DropTarget = { id: string; position: 'before' | 'after' };

/** The VM/CT Summary tab: the panel grid that justifies the project (see design brief). T22
 *  ("Re-arrange tiles on Summary") lets a signed-in user drag (or keyboard-move) panels into a
 *  custom order, saved per guest type in their preferences -- see `pages/vm/summaryLayout.ts`
 *  for the panel registry and the pure reordering helpers used below. */
export function SummaryTab({ node, type, vmid }: VmTabProps) {
  const statusQuery = useVmStatus(node, type, vmid);
  const configQuery = useVmConfig(node, type, vmid);
  const { data: status } = statusQuery;
  const { data: config } = configQuery;
  const { data: agent, isError: agentError } = useAgentInterfaces(node, type, vmid);
  const { data: rrd, isLoading: rrdLoading } = useRrd(node, type, vmid, 'hour');
  const lastBackupQuery = useNodeTasks(node, { vmid, typefilter: 'vzdump', limit: 1, source: 'all' });
  const { data: resources } = useClusterResources();
  const { data: prefs } = usePrefs();
  const updatePrefs = useUpdatePrefs();
  const auth = useAuthMe();
  const permissions = usePermissions(vmid);
  const [isEditingNotes, setIsEditingNotes] = useState(false);
  const [arrangeMode, setArrangeMode] = useState(false);
  const [dragId, setDragId] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<DropTarget | null>(null);

  // Same session/fixture + privilege gate the power actions and rename use (ObjectHeader,
  // InventoryTree) -- see their own copies of this rule.
  const isSessionMode = USE_FIXTURES || auth.data?.mode === 'session';
  const hasConfigOptions = permissions.data?.can('VM.Config.Options') === true;
  const canEditNotes = isSessionMode && hasConfigOptions;
  const notesDisabledReason = !isSessionMode
    ? 'Read-only: signed in with a service token'
    : "You don't have VM.Config.Options on this guest";

  // The Last backup panel's backup-incident line (T23): at most one open/healed incident per
  // guest, so `.find` is enough -- see `@proxion/core`'s `computeAlerts`/`computeBackupIncidents`.
  const { data: alerts } = useAlerts();
  const backupAlert = (alerts ?? []).find(
    (a) => a.kind === 'backup' && a.node === node && a.vmid === String(vmid),
  );

  // Checked before the loading fallback below: a genuine failure (403, guest gone, proxy down,
  // ...) must never sit on the skeleton forever -- `status`/`config` stay `undefined` on error
  // too, so without this the skeleton branch alone would hang indefinitely instead of settling
  // on an error state.
  if (statusQuery.isError || configQuery.isError) {
    return (
      <EmptyState
        message={`Could not load this ${type === 'lxc' ? 'container' : 'VM'}: ${errorMessage(
          statusQuery.error ?? configQuery.error,
        )}`}
      />
    );
  }

  if (!status || !config) {
    return <Skeleton className="h-64" />;
  }

  // `getDrives`/`getRootfsDrive` (the richer Hardware-tab parsers) replace the old
  // `getDisks`/`getRootfs`, which had no notion of `media=cdrom` -- so a CD-ROM or cloud-init
  // drive (e.g. `ide2`/`ide3`) showed up in this Disks list as a plain disk with a `-` size.
  // Filtered the same way HardwareTab.tsx's `qemuRows` does: real disks only, no CD-ROM,
  // EFI disk, TPM state or cloud-init drive.
  const allDrives: ParsedDrive[] =
    type === 'qemu'
      ? getDrives(config)
      : [getRootfsDrive(config)].filter((d): d is ParsedDrive => d !== null);
  const disks = allDrives.filter(
    (d) =>
      d.media !== 'cdrom' &&
      d.bus !== 'efidisk' &&
      d.bus !== 'tpmstate' &&
      !d.volume.includes('cloudinit'),
  );
  const nics = getNics(config);

  // Sparkline data comes from the same RRD transform the Monitor tab charts use (real fixture
  // RRD, not synthetic): cpu/memory are converted back to 0..1 fractions for the Gauge, the
  // rest stay as raw bytes-per-second for the Sparkline/RateRow display below.
  const { cpu: cpuPanel, memory: memoryPanel, diskIo, network } = vmSeries(rrd ?? []);
  const cpuHistory = cpuPanel.series[0]?.values.map((v) => (v ?? 0) / 100) ?? [];
  const memUsed = memoryPanel.series[0]?.values ?? [];
  const memMax = memoryPanel.series[1]?.values ?? [];
  const memHistory = memUsed.map((used, i) => {
    const max = memMax[i];
    return used != null && max ? used / max : 0;
  });
  const diskReadHistory = diskIo.series[0]?.values.map((v) => v ?? 0) ?? [];
  const diskWriteHistory = diskIo.series[1]?.values.map((v) => v ?? 0) ?? [];
  const netInHistory = network.series[0]?.values.map((v) => v ?? 0) ?? [];
  const netOutHistory = network.series[1]?.values.map((v) => v ?? 0) ?? [];

  const lastBackup = lastBackupQuery.data?.[0];
  // Backup-capable storages for this node -- used by the Related panel's links below. (The
  // Backups tab's own per-storage volume listing isn't reused for a "Latest volume" row here:
  // that needs a `useQueries` fan-out over every one of these storages' content, same as
  // BackupsTab.tsx does, which is several extra round trips duplicating that tab's own logic,
  // not a single cheap query -- so this panel sticks to the node task index alone.)
  const backupStorages = (resources ?? []).filter(
    (r) => r.type === 'storage' && r.node === node && r.content?.includes('backup'),
  );

  // "Related" links to each distinct storage/bridge once -- a VM with two disks on the same
  // storage (or two NICs on the same bridge, as pve1/100 has) previously listed that storage
  // or bridge link once per disk/NIC instead of once per object.
  const relatedStorages = [...new Set(disks.map((d) => d.storage))];
  const relatedBridges = [
    ...new Set(nics.map((n) => n.bridge).filter((b): b is string => Boolean(b))),
  ];

  const notesAction =
    !isEditingNotes &&
    (canEditNotes ? (
      <button
        type="button"
        aria-label="Edit notes"
        onClick={() => setIsEditingNotes(true)}
        className="text-muted-foreground hover:text-foreground"
      >
        <Pencil className="size-3.5" />
      </button>
    ) : (
      <Tooltip>
        <TooltipTrigger asChild>
          <span tabIndex={0} className="inline-flex rounded-sm focus-visible:ring-[3px] focus-visible:ring-ring/50">
            <button
              type="button"
              disabled
              aria-disabled="true"
              aria-label="Edit notes"
              tabIndex={-1}
              className="pointer-events-none text-muted-foreground/50"
            >
              <Pencil className="size-3.5" />
            </button>
          </span>
        </TooltipTrigger>
        <TooltipContent>{notesDisabledReason}</TooltipContent>
      </Tooltip>
    ));

  // Every panel this tab can render, keyed by its `summaryLayout.ts` registry id. Console is
  // simply absent from the map (not merely hidden) when the `consoleThumbnails` preference is
  // off -- `id in panelsById` below is what makes it disappear from arrange mode too, exactly as
  // it disappeared from the fixed JSX sequence before T22.
  const panelsById: Record<string, SummaryPanelContent> = {
    guest: {
      title: 'Guest',
      span: 1,
      content: (
        <div className="flex flex-col gap-3">
          <KeyValueGrid
            rows={[
              { label: 'OS', value: osTypeLabel(config.ostype) },
              { label: 'Hostname', value: config.hostname ?? config.name ?? '-' },
              { label: 'Agent', value: agentError ? 'not running' : 'running' },
            ]}
          />
          <div>
            <div className="mb-1 text-xs text-muted-foreground">IP addresses</div>
            {agentError || !agent ? (
              <EmptyState message="Guest agent not reporting." />
            ) : (
              <ul className="flex flex-col gap-1">
                {agent.result
                  .flatMap((iface) => iface['ip-addresses'] ?? [])
                  .filter((ip) => ip['ip-address'] !== '127.0.0.1' && ip['ip-address'] !== '::1')
                  .map((ip) => (
                    <li
                      key={ip['ip-address']}
                      className="flex items-center justify-between gap-2 text-xs"
                    >
                      <span className="truncate" data-testid="guest-ip">
                        {ip['ip-address']}
                      </span>
                      <button
                        type="button"
                        aria-label={`Copy ${ip['ip-address']}`}
                        onClick={() => copy(ip['ip-address'], 'IP address')}
                        className="text-muted-foreground hover:text-foreground"
                      >
                        <Copy className="size-3" />
                      </button>
                    </li>
                  ))}
              </ul>
            )}
          </div>
        </div>
      ),
    },

    hardware: {
      title: 'Hardware',
      span: 1,
      content: (
        <div className="flex flex-col gap-3">
          <KeyValueGrid
            rows={[
              { label: 'Cores', value: config.cores ?? '-' },
              { label: 'Sockets', value: config.sockets ?? '-' },
              {
                label: 'Memory',
                value: config.memory ? formatBytes(Number(config.memory) * 1024 * 1024) : '-',
              },
              { label: 'Ballooning', value: balloonLabel(config) },
              { label: 'Boot order', value: config.boot ?? '-' },
              { label: 'Machine', value: config.machine ?? '-' },
              { label: 'BIOS', value: config.bios ?? '-' },
            ]}
          />
          <div>
            <div className="mb-1 flex items-center gap-1 text-xs text-muted-foreground">
              <HardDrive className="size-3" /> Disks
            </div>
            <ul className="flex flex-col gap-1 text-xs">
              {disks.length === 0 ? (
                <li className="text-muted-foreground">No disks.</li>
              ) : (
                disks.map((d) => (
                  <li key={d.key} className="flex items-center justify-between">
                    {/* Bus + storage target are identifiers, but sans not mono (T11) -- the
                        size gets tabular-nums since it's a right-aligned figure. */}
                    <span>
                      {d.bus} &middot; {d.storage}
                    </span>
                    <span className="font-numeric text-muted-foreground">{formatDriveSize(d.size)}</span>
                  </li>
                ))
              )}
            </ul>
          </div>
          <div>
            <div className="mb-1 flex items-center gap-1 text-xs text-muted-foreground">
              <Network className="size-3" /> Network interfaces
            </div>
            <ul className="flex flex-col gap-1 text-xs">
              {nics.length === 0 ? (
                <li className="text-muted-foreground">No NICs.</li>
              ) : (
                nics.map((n) => (
                  <li key={n.key} className="flex items-center justify-between">
                    <span>{n.bridge ?? n.name ?? n.key}</span>
                    <span className="text-muted-foreground" data-testid="summary-mac">
                      {n.mac ?? '-'}
                    </span>
                  </li>
                ))
              )}
            </ul>
          </div>
        </div>
      ),
    },

    resources: {
      title: 'Resources (last 1h)',
      span: 1,
      content: rrdLoading ? (
        <Skeleton className="h-40" />
      ) : (
        <div className="flex flex-col gap-3">
          <Gauge
            label="CPU"
            fraction={status.cpu ?? 0}
            detail={`${status.maxcpu ?? '-'} vCPU`}
            history={cpuHistory}
            historyMax={1}
          />
          <Gauge
            label="Memory"
            fraction={status.maxmem ? (status.mem ?? 0) / status.maxmem : 0}
            detail={formatMemDetail(status.mem ?? 0, status.maxmem ?? 0)}
            history={memHistory}
            historyMax={1}
          />
          <RateRow label="Disk I/O" readHistory={diskReadHistory} writeHistory={diskWriteHistory} />
          <RateRow
            label="Net I/O"
            readHistory={netInHistory}
            writeHistory={netOutHistory}
            readLabel="in"
            writeLabel="out"
          />
        </div>
      ),
    },

    notes: {
      title: 'Notes',
      span: 2,
      action: notesAction,
      content: isEditingNotes ? (
        <NotesEditor
          node={node}
          type={type}
          vmid={vmid}
          initialValue={config.description ?? ''}
          onDone={() => setIsEditingNotes(false)}
        />
      ) : config.description ? (
        <p className="whitespace-pre-wrap text-sm text-muted-foreground">{config.description}</p>
      ) : (
        <EmptyState message="No notes." />
      ),
    },

    related: {
      title: 'Related',
      span: 1,
      content: (
        <ul className="flex flex-col gap-1.5 text-sm">
          {relatedStorages.map((storage) => (
            <li key={storage}>
              <Link
                to="/node/$node"
                params={{ node }}
                search={{ tab: 'storage' }}
                className="text-accent hover:underline"
              >
                storage/{storage}
              </Link>
            </li>
          ))}
          {relatedBridges.map((bridge) => (
            <li key={bridge}>
              <Link
                to="/node/$node"
                params={{ node }}
                search={{ tab: 'summary' }}
                className="text-accent hover:underline"
              >
                bridge/{bridge}
              </Link>
            </li>
          ))}
          {backupStorages.length === 0 ? (
            <li className="text-muted-foreground">No backup storage configured.</li>
          ) : (
            backupStorages.map((s) => (
              <li key={s.id}>
                <Link
                  to="/node/$node"
                  params={{ node }}
                  search={{ tab: 'storage' }}
                  className="text-accent hover:underline"
                >
                  backups ({s.storage})
                </Link>
              </li>
            ))
          )}
        </ul>
      ),
    },

    snapshots: {
      title: 'Snapshots',
      span: 1,
      content: (
        <EmptyState
          message="0 snapshots."
          action={
            <Button variant="ghost" size="sm" disabled>
              Take snapshot
            </Button>
          }
        />
      ),
    },

    lastBackup: {
      title: 'Last backup',
      span: 1,
      content: lastBackupQuery.isLoading ? (
        <div className="flex flex-col gap-1.5">
          <Skeleton className="h-4 w-full" />
          <Skeleton className="h-4 w-full" />
          <Skeleton className="h-4 w-full" />
        </div>
      ) : lastBackupQuery.isError ? (
        <EmptyState
          message={`Could not load backup history: ${errorMessage(lastBackupQuery.error)}`}
        />
      ) : lastBackup ? (
        <div className="flex flex-col gap-2">
          <KeyValueGrid
            rows={[
              {
                label: 'Started',
                value: (
                  <div className="flex flex-col items-end leading-tight">
                    <span>{formatDateTime(lastBackup.starttime)}</span>
                    <span className="text-[11px] text-muted-foreground">
                      {formatRelativeTime(lastBackup.starttime)}
                    </span>
                  </div>
                ),
              },
              {
                label: 'Duration',
                value: lastBackup.endtime
                  ? formatDuration(lastBackup.endtime - lastBackup.starttime)
                  : 'running',
              },
              {
                label: 'Status',
                value: !lastBackup.endtime ? (
                  'running'
                ) : lastBackup.status === 'OK' ? (
                  'OK'
                ) : (
                  <span className="text-status-error">{lastBackup.status ?? '-'}</span>
                ),
              },
              { label: 'Run by', value: lastBackup.user },
            ]}
          />
          {backupAlert && (
            <p
              className={cn(
                'text-xs',
                backupAlert.severity === 'error' && 'text-status-error',
                backupAlert.severity === 'warning' && 'text-status-paused',
                backupAlert.severity === 'healed' && 'text-muted-foreground',
              )}
            >
              {backupAlert.severity === 'healed'
                ? `Previous attempt ${backupAlert.title.slice(backupAlert.title.indexOf('failed at'))}`
                : backupAlert.title}
              {backupAlert.severity === 'warning' && backupAlert.detail
                ? ` — ${backupAlert.detail}`
                : ''}
            </p>
          )}
        </div>
      ) : (
        <EmptyState message="No backup task in this node's history." />
      ),
    },
  };

  if (prefs?.consoleThumbnails !== false) {
    panelsById.console = {
      title: 'Console',
      span: 1,
      content: (
        <ConsoleThumbnail
          node={node}
          type={type}
          vmid={vmid}
          name={config.name ?? config.hostname ?? `${type}/${vmid}`}
          status={status.status}
          template={status.template === 1}
          size="lg"
          refreshIntervalMs={
            prefs?.thumbnailRefreshSeconds ? prefs.thumbnailRefreshSeconds * 1000 : undefined
          }
        />
      ),
    };
  }

  // The saved order (whatever shape it's in) normalised to today's panel set, then narrowed to
  // the panels actually present this render (only `console` can be absent -- see above).
  const fullOrder = normaliseOrder(prefs?.summaryLayout?.[type]);
  const visibleOrder = fullOrder.filter((id) => id in panelsById);

  /** Re-threads a reordered `visibleOrder` back into `fullOrder`'s coordinates, so a panel that's
   *  currently hidden (console, preference off) keeps its place instead of being dropped from
   *  what gets saved. */
  function applyVisibleOrder(nextVisible: string[]): string[] {
    const queue = [...nextVisible];
    return fullOrder.map((id) => (id in panelsById ? (queue.shift() as string) : id));
  }

  function persistVisibleOrder(nextVisible: string[]) {
    const nextLayout = { ...(prefs?.summaryLayout ?? {}), [type]: applyVisibleOrder(nextVisible) };
    updatePrefs.mutate({ summaryLayout: nextLayout });
  }

  function resetOrderForType() {
    const nextLayout = { ...(prefs?.summaryLayout ?? {}) };
    delete nextLayout[type];
    updatePrefs.mutate({ summaryLayout: nextLayout });
  }

  function handleMoveUp(id: string) {
    const idx = visibleOrder.indexOf(id);
    if (idx <= 0) return;
    persistVisibleOrder(moveId(visibleOrder, id, idx - 1));
  }

  function handleMoveDown(id: string) {
    const idx = visibleOrder.indexOf(id);
    if (idx === -1 || idx >= visibleOrder.length - 1) return;
    persistVisibleOrder(moveId(visibleOrder, id, idx + 1));
  }

  function handleDragStart(id: string) {
    return (event: DragEvent<HTMLDivElement>) => {
      setDragId(id);
      event.dataTransfer.effectAllowed = 'move';
      event.dataTransfer.setData('text/plain', id);
    };
  }

  function handleDragOver(id: string) {
    return (event: DragEvent<HTMLDivElement>) => {
      event.preventDefault();
      if (dragId === null || dragId === id) return;
      const rect = event.currentTarget.getBoundingClientRect();
      const before = event.clientY < rect.top + rect.height / 2;
      setDropTarget({ id, position: before ? 'before' : 'after' });
    };
  }

  function handleDrop(id: string) {
    return (event: DragEvent<HTMLDivElement>) => {
      event.preventDefault();
      const sourceId = dragId;
      const position = dropTarget && dropTarget.id === id ? dropTarget.position : 'after';
      setDragId(null);
      setDropTarget(null);
      if (sourceId && sourceId !== id) {
        persistVisibleOrder(reorderByDrop(visibleOrder, sourceId, id, position));
      }
    };
  }

  function handleDragEnd() {
    setDragId(null);
    setDropTarget(null);
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-end gap-2">
        {arrangeMode ? (
          <>
            <Button variant="ghost" size="sm" onClick={resetOrderForType}>
              Reset to default
            </Button>
            <Button variant="ghost" size="sm" onClick={() => setArrangeMode(false)}>
              Done
            </Button>
          </>
        ) : (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setArrangeMode(true)}
            disabled={prefs?.readOnly === true}
            title={prefs?.readOnly === true ? 'Read-only: signed in with a service token' : undefined}
          >
            <GripVertical className="size-3.5" aria-hidden="true" />
            Arrange
          </Button>
        )}
      </div>

      {/* Sparse (default) grid auto-flow, not `dense`: with a 2-column Notes panel in the mix,
          `dense` would pull later, narrower panels backward to fill the gap Notes leaves --
          visually reordering the grid relative to the order the user just chose by dragging.
          Sparse keeps "the order I arranged" and "the order on screen" the same list, read
          left-to-right/top-to-bottom, at the cost of an occasional empty cell when Notes doesn't
          land on a row boundary -- confirmed against the T22 screenshots. */}
      <div className="grid grid-cols-1 gap-3 lg:grid-cols-3">
        {visibleOrder.map((id, index) => {
          const panel = panelsById[id]!;
          return (
            <ArrangeablePanel
              key={id}
              title={panel.title}
              className={panel.span === 2 ? 'lg:col-span-2' : undefined}
              action={panel.action}
              arrangeMode={arrangeMode}
              onMoveUp={() => handleMoveUp(id)}
              onMoveDown={() => handleMoveDown(id)}
              canMoveUp={index > 0}
              canMoveDown={index < visibleOrder.length - 1}
              onDragStart={handleDragStart(id)}
              onDragOver={handleDragOver(id)}
              onDrop={handleDrop(id)}
              onDragEnd={handleDragEnd}
              isDragging={dragId === id}
              dropIndicator={dropTarget?.id === id ? dropTarget.position : null}
            >
              {panel.content}
            </ArrangeablePanel>
          );
        })}
      </div>
    </div>
  );
}

function RateRow({
  label,
  readHistory,
  writeHistory,
  readLabel = 'read',
  writeLabel = 'write',
}: {
  label: string;
  readHistory: number[];
  writeHistory: number[];
  readLabel?: string;
  writeLabel?: string;
}) {
  const lastRead = readHistory[readHistory.length - 1] ?? 0;
  const lastWrite = writeHistory[writeHistory.length - 1] ?? 0;
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-baseline justify-between text-xs text-muted-foreground">
        <span>{label}</span>
        <span className="font-numeric">
          {readLabel} {formatBytes(lastRead)}/s &middot; {writeLabel} {formatBytes(lastWrite)}/s
        </span>
      </div>
      <div className="flex gap-2">
        <Sparkline values={readHistory} width={90} height={18} colorVar="--status-running" />
        <Sparkline values={writeHistory} width={90} height={18} colorVar="--status-migrating" />
      </div>
    </div>
  );
}
