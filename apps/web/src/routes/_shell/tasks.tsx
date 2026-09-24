import { createFileRoute } from '@tanstack/react-router';

import { TasksPage } from '@/pages/tasks/TasksPage';

export const Route = createFileRoute('/_shell/tasks')({
  component: TasksPage,
});
