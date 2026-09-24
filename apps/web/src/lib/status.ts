export type ObjectStatus =
  | 'running'
  | 'stopped'
  | 'paused'
  | 'suspended'
  | 'error'
  | 'unknown'
  | 'template'
  | 'migrating';

/** Semantic status token used by StatusDot / badges. Maps to `--status-*` CSS vars. */
export type StatusColor = 'running' | 'stopped' | 'paused' | 'error' | 'template' | 'migrating';

/**
 * Maps a raw PVE/resource status string (plus whether the guest is a template) to the
 * semantic status color token defined in the design brief: running=emerald, stopped=zinc,
 * paused/suspended=amber, error/unknown=red, template=violet, migrating=sky.
 */
export function statusToColor(status: string | undefined, isTemplate?: boolean): StatusColor {
  if (isTemplate) return 'template';
  switch (status) {
    case 'running':
    case 'online':
    case 'available':
      return 'running';
    case 'stopped':
    case 'offline':
      return 'stopped';
    case 'paused':
    case 'suspended':
      return 'paused';
    case 'migrating':
      return 'migrating';
    case undefined:
      return 'error';
    default:
      return status.startsWith('ERROR') ? 'error' : 'error';
  }
}

/**
 * Classifies a `/cluster/tasks` status string into running / ok / error.
 * PVE omits `status` entirely while a task is in flight; our fixtures use the literal
 * string "running" for the same case, so both are treated as still running.
 */
export function taskStatusState(status: string | undefined): 'running' | 'ok' | 'error' {
  if (!status || status === 'running') return 'running';
  if (status === 'OK') return 'ok';
  return 'error';
}
