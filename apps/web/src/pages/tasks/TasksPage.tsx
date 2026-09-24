import { useState } from 'react';

import { Breadcrumbs } from '@/components/Breadcrumbs';
import { TasksTable } from '@/components/TasksTable';
import { TaskLogSheet } from '@/components/TaskLogSheet';
import { EmptyState } from '@/components/EmptyState';
import { Skeleton } from '@/components/ui/skeleton';
import { useTasks } from '@/api/hooks';
import { errorMessage } from '@/api/errors';
import type { PveTask } from '@/api/types';

/** The full `/tasks` page: the sortable tasks table plus a task-log Sheet on row click. */
export function TasksPage() {
  const { data: tasks, isLoading, isError, error } = useTasks();
  const [selected, setSelected] = useState<PveTask | null>(null);

  return (
    <div className="flex flex-col gap-3 p-4">
      <div className="flex flex-col gap-1">
        <Breadcrumbs items={[{ label: 'Datacenter', to: 'home' }, { label: 'Tasks' }]} />
        <h1 className="font-display text-[32px] leading-tight font-light tracking-[var(--font-display-tracking)]">
          Tasks
        </h1>
      </div>
      {isLoading ? (
        <Skeleton className="h-96" />
      ) : isError ? (
        <EmptyState message={`Could not load tasks: ${errorMessage(error)}`} />
      ) : (
        <TasksTable tasks={tasks ?? []} emptyMessage="No tasks." onSelectTask={setSelected} />
      )}
      <TaskLogSheet task={selected} onOpenChange={(open) => !open && setSelected(null)} />
    </div>
  );
}
