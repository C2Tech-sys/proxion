import { useMemo, type KeyboardEvent, type MouseEvent } from 'react';
import { getRouteApi, Link, useNavigate } from '@tanstack/react-router';
import { ArrowDown, ArrowUp, Columns3 } from 'lucide-react';

import { Breadcrumbs } from '@/components/Breadcrumbs';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { StatusDot } from '@/components/StatusDot';
import { TagChip } from '@/components/TagChip';
import { UsageBar } from '@/components/UsageBar';
import { EmptyState } from '@/components/EmptyState';
import { GuestContextMenu } from '@/components/actions/GuestContextMenu';
import { useClusterResources } from '@/api/hooks';
import { usePrefs, useUpdatePrefs } from '@/api/prefsHooks';
import { formatMemDetail, formatPercent, formatUptime } from '@/lib/format';
import { cn } from '@/lib/utils';
import {
  DEFAULT_GUESTS_SEARCH_STATE,
  GUEST_COLUMNS,
  GUEST_STATUS_FILTERS,
  GUEST_TYPE_FILTERS,
  guestNodeNames,
  hasReportedDiskUsage,
  resolveVisibleColumns,
  selectGuestRows,
  toGuestRows,
  toGuestsSearch,
  type GuestColumnId,
  type GuestRow,
  type GuestSortKey,
  type GuestStatusFilter,
  type GuestTypeFilter,
  type GuestsSearchState,
  type SortDir,
} from './guestList';

const routeApi = getRouteApi('/_shell/guests');

const STATUS_LABELS: Record<GuestStatusFilter, string> = {
  all: 'All',
  running: 'Running',
  stopped: 'Stopped',
  paused: 'Paused',
  template: 'Templates',
};

const TYPE_LABELS: Record<GuestTypeFilter, string> = {
  all: 'All',
  qemu: 'VMs',
  lxc: 'CTs',
};

/** A small pill-group filter -- three of these (status, type, node) sit next to the search box.
 *  Plain buttons (not the `Tabs` primitive, which owns a full panel/content contract this has no
 *  use for), each toggled by a click and reachable by Tab like any other button. */
function SegmentedControl<T extends string>({
  label,
  value,
  options,
  labelFor,
  onChange,
}: {
  label: string;
  value: T;
  options: readonly T[];
  labelFor: (value: T) => string;
  onChange: (value: T) => void;
}) {
  return (
    <div
      role="group"
      aria-label={label}
      className="inline-flex items-center gap-0.5 rounded-md border border-border p-0.5"
    >
      {options.map((option) => (
        <button
          key={option}
          type="button"
          aria-pressed={value === option}
          onClick={() => onChange(option)}
          className={cn(
            'rounded px-2 py-1 text-xs whitespace-nowrap outline-none focus-visible:bg-accent/20',
            value === option
              ? 'bg-accent/20 text-foreground'
              : 'text-muted-foreground hover:bg-accent/10 hover:text-foreground',
          )}
        >
          {labelFor(option)}
        </button>
      ))}
    </div>
  );
}

interface SortableHeadProps {
  label: string;
  sortKey: GuestSortKey;
  activeKey: GuestSortKey;
  dir: SortDir;
  onToggle: (key: GuestSortKey) => void;
  className?: string;
}

function SortableHead({ label, sortKey, activeKey, dir, onToggle, className }: SortableHeadProps) {
  const active = activeKey === sortKey;
  return (
    <TableHead className={className}>
      <button
        type="button"
        onClick={() => onToggle(sortKey)}
        className="flex items-center gap-1 outline-none hover:text-foreground"
      >
        {label}
        {active && (dir === 'asc' ? <ArrowUp className="size-3" /> : <ArrowDown className="size-3" />)}
      </button>
    </TableHead>
  );
}

/** One guest's row in the table -- a plain `<tr>` (not the styled `TableRow`, which isn't a
 *  forwardRef component and so can't be `GuestContextMenu`'s `asChild` trigger) carrying
 *  `TableRow`'s own classes by hand. Clicking anywhere in the row (or pressing Enter while it's
 *  focused) opens the guest's Summary tab, same as the inventory rail's guest rows; the name and
 *  node cells stop that click from bubbling so their own links navigate exactly once. */
function GuestTableRow({ row, visibleColumns }: { row: GuestRow; visibleColumns: Set<GuestColumnId> }) {
  const navigate = useNavigate();

  function open() {
    void navigate({
      to: '/vm/$node/$type/$vmid',
      params: { node: row.node, type: row.type, vmid: String(row.vmid) },
      search: { tab: 'summary' },
    });
  }

  function stop(event: MouseEvent) {
    event.stopPropagation();
  }

  function onKeyDown(event: KeyboardEvent<HTMLTableRowElement>) {
    if (event.key === 'Enter') {
      event.preventDefault();
      open();
    }
  }

  const memFraction = row.memMax > 0 ? row.memUsed / row.memMax : 0;
  const diskFraction = row.diskMax > 0 ? row.diskUsed / row.diskMax : 0;

  return (
    <GuestContextMenu guest={row}>
      <tr
        tabIndex={0}
        onClick={open}
        onKeyDown={onKeyDown}
        className="cursor-pointer border-b border-border outline-none transition-colors last:border-0 hover:bg-muted/40 focus-visible:bg-accent/10"
      >
        <TableCell onClick={stop}>
          <Link
            to="/vm/$node/$type/$vmid"
            params={{ node: row.node, type: row.type, vmid: String(row.vmid) }}
            search={{ tab: 'summary' }}
            className="flex min-w-0 items-center gap-2 outline-none hover:underline"
          >
            <StatusDot status={row.status} template={row.template} />
            <span className="min-w-0 truncate" title={row.name}>
              {row.name}
            </span>
          </Link>
        </TableCell>
        <TableCell className="text-right font-numeric">{row.vmid}</TableCell>
        {visibleColumns.has('type') && (
          <TableCell>
            <Badge variant="secondary" className="text-[10px]">
              {row.type === 'lxc' ? 'CT' : 'VM'}
            </Badge>
          </TableCell>
        )}
        <TableCell onClick={stop}>
          <Link
            to="/node/$node"
            params={{ node: row.node }}
            search={{ tab: 'summary' }}
            className="text-accent hover:underline"
          >
            {row.node}
          </Link>
        </TableCell>
        {visibleColumns.has('tags') && (
          <TableCell className="hidden md:table-cell">
            <div className="flex max-w-56 flex-wrap gap-1">
              {row.tags.map((tag) => (
                <TagChip key={tag} tag={tag} />
              ))}
            </div>
          </TableCell>
        )}
        {visibleColumns.has('cpu') && (
          <TableCell className="w-32">
            <UsageBar fraction={row.cpuFraction} label={formatPercent(row.cpuFraction)} />
          </TableCell>
        )}
        {visibleColumns.has('mem') && (
          <TableCell className="w-44">
            <UsageBar fraction={memFraction} label={formatMemDetail(row.memUsed, row.memMax)} />
          </TableCell>
        )}
        {visibleColumns.has('disk') && (
          <TableCell className="hidden w-44 lg:table-cell">
            {hasReportedDiskUsage(row) ? (
              <UsageBar fraction={diskFraction} label={formatMemDetail(row.diskUsed, row.diskMax)} />
            ) : (
              <span className="text-xs text-muted-foreground">—</span>
            )}
          </TableCell>
        )}
        {visibleColumns.has('uptime') && (
          <TableCell className="hidden text-right font-numeric lg:table-cell">
            {formatUptime(row.uptime)}
          </TableCell>
        )}
        {visibleColumns.has('ha') && (
          <TableCell>
            {row.hastate ?? <span className="text-xs text-muted-foreground">—</span>}
          </TableCell>
        )}
      </tr>
    </GuestContextMenu>
  );
}

/**
 * The vSphere-style "VMs and Templates" view (T25): every guest across the cluster, one flat,
 * sortable, filterable table, with URL-backed state (`validateSearch` on the `/guests` route)
 * so a search/filter/sort combination is shareable/bookmarkable. Row actions reuse the exact
 * same context menu as the inventory rail (`GuestContextMenu`).
 */
export function GuestsPage() {
  const search = routeApi.useSearch();
  const navigate = routeApi.useNavigate();
  const { data: resources, isLoading } = useClusterResources();
  const { data: prefs } = usePrefs();
  const updatePrefs = useUpdatePrefs();

  const state: GuestsSearchState = {
    q: search.q ?? DEFAULT_GUESTS_SEARCH_STATE.q,
    status: search.status ?? DEFAULT_GUESTS_SEARCH_STATE.status,
    type: search.type ?? DEFAULT_GUESTS_SEARCH_STATE.type,
    node: search.node ?? DEFAULT_GUESTS_SEARCH_STATE.node,
    sort: search.sort ?? DEFAULT_GUESTS_SEARCH_STATE.sort,
    dir: search.dir ?? DEFAULT_GUESTS_SEARCH_STATE.dir,
  };

  const allRows = useMemo(() => toGuestRows(resources ?? []), [resources]);
  const nodeNames = useMemo(() => guestNodeNames(allRows), [allRows]);
  const nodeOptions = useMemo(() => ['all', ...nodeNames] as const, [nodeNames]);
  const rows = useMemo(
    () =>
      selectGuestRows(
        allRows,
        { q: state.q, status: state.status, type: state.type, node: state.node },
        state.sort,
        state.dir,
      ),
    [allRows, state.q, state.status, state.type, state.node, state.sort, state.dir],
  );
  const runningShown = rows.filter((row) => row.status === 'running').length;
  const visibleColumns = resolveVisibleColumns(prefs?.guestList?.columns);

  function updateSearch(partial: Partial<GuestsSearchState>) {
    void navigate({ search: toGuestsSearch({ ...state, ...partial }), replace: true });
  }

  function toggleSort(key: GuestSortKey) {
    const nextDir: SortDir = state.sort === key ? (state.dir === 'asc' ? 'desc' : 'asc') : 'asc';
    updateSearch({ sort: key, dir: nextDir });
  }

  function toggleColumn(id: GuestColumnId, checked: boolean) {
    const next = new Set(visibleColumns);
    if (checked) next.add(id);
    else next.delete(id);
    const nextColumns = GUEST_COLUMNS.map((c) => c.id).filter((id_) => next.has(id_));
    updatePrefs.mutate({ guestList: { columns: nextColumns } });
  }

  return (
    <div className="flex flex-col gap-3 p-4">
      <div className="flex flex-col gap-1">
        <Breadcrumbs items={[{ label: 'Datacenter', to: 'home' }, { label: 'Guests' }]} />
        <h1 className="font-display text-[32px] leading-tight font-light tracking-[var(--font-display-tracking)]">
          Guests
        </h1>
        <p className="text-sm text-muted-foreground">
          {rows.length} of {allRows.length} shown · {runningShown} running
        </p>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Input
          value={state.q}
          onChange={(e) => updateSearch({ q: e.target.value })}
          placeholder="Search by name, VMID, tag or node"
          aria-label="Search guests"
          className="h-8 w-64 text-xs"
        />
        <SegmentedControl
          label="Status"
          value={state.status}
          options={GUEST_STATUS_FILTERS}
          labelFor={(v) => STATUS_LABELS[v]}
          onChange={(v) => updateSearch({ status: v })}
        />
        <SegmentedControl
          label="Type"
          value={state.type}
          options={GUEST_TYPE_FILTERS}
          labelFor={(v) => TYPE_LABELS[v]}
          onChange={(v) => updateSearch({ type: v })}
        />
        <SegmentedControl
          label="Node"
          value={state.node}
          options={nodeOptions}
          labelFor={(v) => (v === 'all' ? 'All nodes' : v)}
          onChange={(v) => updateSearch({ node: v })}
        />
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="outline" size="sm" className="ml-auto h-8 gap-1.5 text-xs">
              <Columns3 className="size-3.5" /> Columns
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            {GUEST_COLUMNS.map((column) => (
              <DropdownMenuCheckboxItem
                key={column.id}
                checked={visibleColumns.has(column.id)}
                onCheckedChange={(checked) => toggleColumn(column.id, checked === true)}
                onSelect={(e) => e.preventDefault()}
              >
                {column.label}
              </DropdownMenuCheckboxItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      {isLoading ? (
        <Skeleton className="h-96" />
      ) : rows.length === 0 ? (
        <EmptyState message="No guests match the current filters." />
      ) : (
        <div className="overflow-x-auto rounded-lg border border-border">
          <Table>
            <TableHeader>
              <TableRow>
                <SortableHead label="Name" sortKey="name" activeKey={state.sort} dir={state.dir} onToggle={toggleSort} />
                <SortableHead
                  label="VMID"
                  sortKey="vmid"
                  activeKey={state.sort}
                  dir={state.dir}
                  onToggle={toggleSort}
                  className="text-right"
                />
                {visibleColumns.has('type') && (
                  <SortableHead label="Type" sortKey="type" activeKey={state.sort} dir={state.dir} onToggle={toggleSort} />
                )}
                <SortableHead label="Node" sortKey="node" activeKey={state.sort} dir={state.dir} onToggle={toggleSort} />
                {visibleColumns.has('tags') && <TableHead className="hidden md:table-cell">Tags</TableHead>}
                {visibleColumns.has('cpu') && (
                  <SortableHead label="CPU" sortKey="cpu" activeKey={state.sort} dir={state.dir} onToggle={toggleSort} className="w-32" />
                )}
                {visibleColumns.has('mem') && (
                  <SortableHead
                    label="Memory"
                    sortKey="mem"
                    activeKey={state.sort}
                    dir={state.dir}
                    onToggle={toggleSort}
                    className="w-44"
                  />
                )}
                {visibleColumns.has('disk') && (
                  <SortableHead
                    label="Disk"
                    sortKey="disk"
                    activeKey={state.sort}
                    dir={state.dir}
                    onToggle={toggleSort}
                    className="hidden w-44 lg:table-cell"
                  />
                )}
                {visibleColumns.has('uptime') && (
                  <SortableHead
                    label="Uptime"
                    sortKey="uptime"
                    activeKey={state.sort}
                    dir={state.dir}
                    onToggle={toggleSort}
                    className="hidden text-right lg:table-cell"
                  />
                )}
                {visibleColumns.has('ha') && <TableHead>HA</TableHead>}
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((row) => (
                <GuestTableRow key={row.id} row={row} visibleColumns={visibleColumns} />
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  );
}
