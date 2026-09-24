import { useState } from 'react';

import { TasksTable } from '@/components/TasksTable';
import { TaskLogSheet } from '@/components/TaskLogSheet';
import { EmptyState } from '@/components/EmptyState';
import { Skeleton } from '@/components/ui/skeleton';
import { useNodeTasks } from '@/api/hooks';
import { errorMessage } from '@/api/errors';
import type { PveTask } from '@/api/types';
import type { VmTabProps } from '@/pages/vm/tabs';

/** How many of the node's own task-history rows to pull for this guest (see T17). */
const TASKS_LIMIT = 200;

/**
 * Tasks scoped to this VM/CT, from the node's own task index/history (`GET
 * /nodes/{node}/tasks?vmid=...`) rather than the cluster's short recent-task list `useTasks()`
 * reads -- that list only ever holds a few hours of cluster-wide history, so a guest's older
 * tasks (nightly backups, days-old start/stop cycles, ...) never showed up here before.
 */
export function TasksTab({ node, vmid }: VmTabProps) {
  const { data: tasks, isLoading, isError, error } = useNodeTasks(node, {
    vmid,
    limit: TASKS_LIMIT,
    source: 'all',
  });
  const [selected, setSelected] = useState<PveTask | null>(null);
  const rows = tasks ?? [];

  if (isLoading) {
    return <Skeleton className="h-64" />;
  }

  if (isError) {
    return <EmptyState message={`Could not load tasks: ${errorMessage(error)}`} />;
  }

  return (
    <div className="flex flex-col gap-3">
      <TasksTable tasks={rows} emptyMessage="No tasks for this guest." onSelectTask={setSelected} />
      {rows.length === TASKS_LIMIT && (
        <p className="px-1 text-xs text-muted-foreground">
          Showing the node&apos;s last {TASKS_LIMIT} tasks.
        </p>
      )}
      <TaskLogSheet task={selected} onOpenChange={(open) => !open && setSelected(null)} />
    </div>
  );
}
