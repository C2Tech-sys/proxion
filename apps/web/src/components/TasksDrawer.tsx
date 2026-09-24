import { useState } from 'react';
import { ChevronUp, CircleAlert, CircleCheck, Loader2 } from 'lucide-react';

import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { EmptyState } from '@/components/EmptyState';
import { TaskLogSheet } from '@/components/TaskLogSheet';
import { useTasks } from '@/api/hooks';
import { useUiStore } from '@/store/ui';
import { formatDateTime, formatDuration } from '@/lib/format';
import { taskStatusState } from '@/lib/status';
import { cn } from '@/lib/utils';
import type { PveTask } from '@/api/types';

function TaskStatusIcon({ status }: { status: string | undefined }) {
  const state = taskStatusState(status);
  if (state === 'running')
    return (
      <Loader2 className="size-3.5 animate-spin text-status-migrating motion-reduce:animate-none" />
    );
  if (state === 'error') return <CircleAlert className="size-3.5 text-status-error" />;
  return <CircleCheck className="size-3.5 text-status-running" />;
}

export function TasksDrawer() {
  const open = useUiStore((s) => s.tasksDrawerOpen);
  const setOpen = useUiStore((s) => s.setTasksDrawerOpen);
  const { data: tasks, isLoading } = useTasks();
  const [selected, setSelected] = useState<PveTask | null>(null);

  const latest = tasks?.[0];
  const total = tasks?.length ?? 0;

  return (
    <div className="flex shrink-0 flex-col border-t border-border bg-card">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        className="flex h-8 w-full items-center gap-2 px-3 text-left text-xs outline-none hover:bg-accent/10 focus-visible:bg-accent/10"
      >
        <span className="font-medium text-muted-foreground">Recent Tasks</span>
        {latest ? (
          <span className="flex min-w-0 items-center gap-1.5 truncate">
            <TaskStatusIcon status={latest.status} />
            <span className="truncate">
              {latest.type} &middot; {latest.id}
            </span>
          </span>
        ) : (
          <span className="text-muted-foreground">No tasks yet</span>
        )}
        <span className="text-muted-foreground">({total})</span>
        <span className="flex-1" />
        <ChevronUp
          className={cn(
            'size-3.5 text-muted-foreground transition-transform',
            open && 'rotate-180',
          )}
        />
      </button>

      {open && (
        <div className="h-60 border-t border-border">
          <div className="h-full overflow-y-auto">
            {isLoading ? (
              <div className="p-3 text-xs text-muted-foreground">Loading tasks&hellip;</div>
            ) : !tasks || tasks.length === 0 ? (
              <EmptyState message="No recent tasks." />
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-6"></TableHead>
                    <TableHead>Node</TableHead>
                    <TableHead>Type</TableHead>
                    <TableHead>ID</TableHead>
                    <TableHead>User</TableHead>
                    <TableHead>Start</TableHead>
                    <TableHead className="text-right">Duration</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {tasks.map((task) => (
                    <TableRow
                      key={task.upid}
                      tabIndex={0}
                      className="cursor-pointer"
                      onClick={() => setSelected(task)}
                    >
                      <TableCell>
                        <TaskStatusIcon status={task.status} />
                      </TableCell>
                      <TableCell>{task.node}</TableCell>
                      <TableCell>{task.type}</TableCell>
                      <TableCell className="font-numeric">{task.id}</TableCell>
                      <TableCell>{task.user}</TableCell>
                      <TableCell className="font-numeric">{formatDateTime(task.starttime)}</TableCell>
                      <TableCell className="text-right font-numeric">
                        {task.endtime ? formatDuration(task.endtime - task.starttime) : 'running'}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </div>
        </div>
      )}
      <TaskLogSheet task={selected} onOpenChange={(nextOpen) => !nextOpen && setSelected(null)} />
    </div>
  );
}
