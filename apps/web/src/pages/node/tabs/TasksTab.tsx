import { useState } from 'react';

import { TasksTable } from '@/components/TasksTable';
import { TaskLogSheet } from '@/components/TaskLogSheet';
import { EmptyState } from '@/components/EmptyState';
import { Skeleton } from '@/components/ui/skeleton';
import { useNodeTasks } from '@/api/hooks';
import { errorMessage } from '@/api/errors';
import type { PveTask } from '@/api/types';
import type { NodeTabProps } from '@/pages/node/tabs';

/** How many of the node's own task-history rows to pull (see T17). */
const TASKS_LIMIT = 200;

/**
 * Tasks scoped to this node, from its own task index/history (`GET /nodes/{node}/tasks`) rather
 * than the cluster's short recent-task list `useTasks()` reads -- that list only ever holds a
 * few hours of cluster-wide history, so most of a node's real task history never showed up here
 * before.
 */
export function TasksTab({ node }: NodeTabProps) {
  const { data: tasks, isLoading, isError, error } = useNodeTasks(node, {
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
      <TasksTable tasks={rows} emptyMessage="No tasks on this node." onSelectTask={setSelected} />
      {rows.length === TASKS_LIMIT && (
        <p className="px-1 text-xs text-muted-foreground">
          Showing the node&apos;s last {TASKS_LIMIT} tasks.
        </p>
      )}
      <TaskLogSheet task={selected} onOpenChange={(open) => !open && setSelected(null)} />
    </div>
  );
}
