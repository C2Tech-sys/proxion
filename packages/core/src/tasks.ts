/**
 * The minimal fields the incident/alert computations in this package need from a PVE task,
 * whether it came from `/cluster/tasks` (a short cluster-wide recent-task window) or
 * `/nodes/{node}/tasks` (a node's fuller task history). Structurally compatible with
 * `@proxion/pve-api`'s curated `ClusterTask` (and the apps' local re-exports of it) -- this
 * package stays dependency-free and never imports that type directly.
 */
export interface TaskLike {
  upid: string;
  node: string;
  type: string;
  /** The VMID (or node name, for a node-scoped task) this task acted on. May be empty for some
   * task types -- see `vmidOfTask`. */
  id: string;
  user: string;
  /** Unix epoch seconds, matching PVE's own task fields. */
  starttime: number;
  /** Unix epoch seconds. Absent while the task is still running. */
  endtime?: number;
  /** Absent while the task is still running; `'OK'` on success; anything else once ended is a
   * failure. */
  status?: string;
}

/**
 * The VMID a task acted on. Prefers the task's own `id` field; PVE sometimes leaves that empty,
 * so this falls back to parsing the UPID's 7th `:`-separated field (`UPID:node:pid:pstart:
 * starttime:type:id:user:`), which is always populated and, for a per-guest task like `vzdump`,
 * is also the VMID.
 */
export function vmidOfTask(task: TaskLike): string {
  if (task.id) return task.id;
  const parts = task.upid.split(':');
  return parts[6] ?? '';
}

/** Classifies a task's `status` field into running / ok / error, the same three states real PVE
 * task lists and our fixtures use: no `status` (or the literal string `"running"`, which our
 * fixtures use for a task in flight) means still running; `"OK"` means success; anything else
 * once the task has a `status` at all is a failure. */
export function taskFinalState(status: string | undefined): 'running' | 'ok' | 'error' {
  if (!status || status === 'running') return 'running';
  if (status === 'OK') return 'ok';
  return 'error';
}
