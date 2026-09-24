import { useMemo, useState } from 'react';
import { ArrowDown, ArrowUp, CircleAlert, CircleCheck, Loader2 } from 'lucide-react';

import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { EmptyState } from '@/components/EmptyState';
import { formatDateTime, formatDuration } from '@/lib/format';
import { taskStatusState } from '@/lib/status';
import type { PveTask } from '@/api/types';

type SortKey = 'starttime' | 'type' | 'node' | 'user' | 'duration';

export function TaskStatusIcon({ status }: { status: string | undefined }) {
  const state = taskStatusState(status);
  if (state === 'running') {
    return <Loader2 className="size-3.5 animate-spin text-status-migrating motion-reduce:animate-none" />;
  }
  if (state === 'error') return <CircleAlert className="size-3.5 text-status-error" />;
  return <CircleCheck className="size-3.5 text-status-running" />;
}

function taskDuration(task: PveTask): number {
  return (task.endtime ?? Math.floor(Date.now() / 1000)) - task.starttime;
}

function compare(a: PveTask, b: PveTask, sortKey: SortKey): number {
  if (sortKey === 'starttime') return a.starttime - b.starttime;
  if (sortKey === 'duration') return taskDuration(a) - taskDuration(b);
  return String(a[sortKey]).localeCompare(String(b[sortKey]));
}

interface SortHeadProps {
  label: string;
  sortKeyName: SortKey;
  activeKey: SortKey;
  dir: 'asc' | 'desc';
  onToggle: (key: SortKey) => void;
}

function SortHead({ label, sortKeyName, activeKey, dir, onToggle }: SortHeadProps) {
  const active = activeKey === sortKeyName;
  return (
    <TableHead>
      <button type="button" onClick={() => onToggle(sortKeyName)} className="flex items-center gap-1 hover:text-foreground">
        {label}
        {active && (dir === 'asc' ? <ArrowUp className="size-3" /> : <ArrowDown className="size-3" />)}
      </button>
    </TableHead>
  );
}

export interface TasksTableProps {
  tasks: PveTask[];
  /** Message shown in place of the table when `tasks` is empty. */
  emptyMessage?: string;
  /** When provided, rows become clickable (used to open the task-log Sheet). */
  onSelectTask?: (task: PveTask) => void;
}

/**
 * The sortable tasks table shared by `/tasks` and the node/VM Tasks tabs. Sort state is local
 * to each mount (callers pass an already-filtered `tasks` list; node/VM tabs filter by
 * node/vmid before rendering this).
 */
export function TasksTable({ tasks, emptyMessage = 'No tasks.', onSelectTask }: TasksTableProps) {
  const [sortKey, setSortKey] = useState<SortKey>('starttime');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc');

  const sorted = useMemo(() => {
    const copy = [...tasks];
    copy.sort((a, b) => {
      const diff = compare(a, b, sortKey);
      return sortDir === 'asc' ? diff : -diff;
    });
    return copy;
  }, [tasks, sortKey, sortDir]);

  function toggleSort(key: SortKey) {
    if (key === sortKey) {
      setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortKey(key);
      setSortDir('desc');
    }
  }

  if (sorted.length === 0) {
    return <EmptyState message={emptyMessage} />;
  }

  return (
    <div className="rounded-lg border border-border">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead className="w-6"></TableHead>
            <SortHead label="Node" sortKeyName="node" activeKey={sortKey} dir={sortDir} onToggle={toggleSort} />
            <SortHead label="Type" sortKeyName="type" activeKey={sortKey} dir={sortDir} onToggle={toggleSort} />
            <TableHead>ID</TableHead>
            <SortHead label="User" sortKeyName="user" activeKey={sortKey} dir={sortDir} onToggle={toggleSort} />
            <SortHead label="Start" sortKeyName="starttime" activeKey={sortKey} dir={sortDir} onToggle={toggleSort} />
            <SortHead label="Duration" sortKeyName="duration" activeKey={sortKey} dir={sortDir} onToggle={toggleSort} />
            <TableHead>Status</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {sorted.map((task) => (
            <TableRow
              key={task.upid}
              onClick={onSelectTask ? () => onSelectTask(task) : undefined}
              className={onSelectTask ? 'cursor-pointer' : undefined}
            >
              <TableCell>
                <TaskStatusIcon status={task.status} />
              </TableCell>
              <TableCell data-testid="table-cell">{task.node}</TableCell>
              <TableCell>{task.type}</TableCell>
              <TableCell className="font-numeric">{task.id}</TableCell>
              <TableCell>{task.user}</TableCell>
              <TableCell className="font-numeric">{formatDateTime(task.starttime)}</TableCell>
              <TableCell className="text-right font-numeric">{formatDuration(taskDuration(task))}</TableCell>
              <TableCell className="max-w-xs truncate" title={task.status}>
                {task.status}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
