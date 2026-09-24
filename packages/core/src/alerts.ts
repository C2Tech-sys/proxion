import {
  type BackupIncident,
  DEFAULT_HARD_ATTEMPTS,
  DEFAULT_HEAL_WINDOW_MS,
  DEFAULT_LOOKBACK_MS,
  computeBackupIncidents,
} from './backupIncidents.js';
import { type TaskLike, taskFinalState } from './tasks.js';

/** Default storage-full alert threshold: 85%, matching today's dashboard behaviour. */
export const DEFAULT_STORAGE_THRESHOLD = 0.85;

/**
 * The minimal fields this package needs from a `/cluster/resources` row -- structurally
 * compatible with the apps' local `ClusterResource` types (which carry many more optional
 * fields), never imported directly so this package stays dependency-free.
 */
export interface ResourceLike {
  id?: string | undefined;
  type?: string | undefined;
  node?: string | undefined;
  vmid?: number | undefined;
  name?: string | undefined;
  disk?: number | undefined;
  maxdisk?: number | undefined;
  storage?: string | undefined;
}

export type AlertKind = 'backup' | 'task' | 'storage';
export type AlertSeverity = 'error' | 'warning' | 'healed';

export interface Alert {
  id: string;
  kind: AlertKind;
  severity: AlertSeverity;
  title: string;
  /** Secondary line, e.g. a backup incident's retry window countdown. */
  detail?: string;
  /** Unix epoch seconds this alert is timestamped at (failure/heal/storage-sample time). */
  at: number;
  node?: string;
  vmid?: string;
  /** Present on `kind: 'backup'` alerts -- the incident this alert renders. */
  incident?: BackupIncident;
}

export interface ComputeAlertsOptions {
  lookbackMs?: number;
  healWindowMs?: number;
  hardAttempts?: number;
  /** How long a healed backup incident keeps showing (grouped, collapsed) after healing.
   * Defaults to `healWindowMs`. */
  healedVisibilityMs?: number;
  /** Fraction (0..1) of a storage's capacity above which it's flagged. Default `0.85`. */
  storageThreshold?: number;
}

export interface ComputeAlertsInput {
  resources: ResourceLike[];
  tasks: TaskLike[];
  /** "Now", as Unix epoch **milliseconds**. Defaults to `Date.now()`. See
   * `computeBackupIncidents`'s doc comment for why this package's "now" is in milliseconds while
   * every task timestamp is in seconds. */
  now?: number;
  options?: ComputeAlertsOptions;
}

function toMs(unixSeconds: number): number {
  return unixSeconds * 1000;
}

/** `"HH:MM"`, 24h, formatted in UTC. Deterministic across a server (typically UTC already) and a
 * browser in any timezone -- the same incident renders identical text everywhere it's computed,
 * which matters since `computeAlerts` runs both server-side (`/api/state`) and client-side
 * (fixture mode). */
function formatTime(unixSeconds: number): string {
  const d = new Date(toMs(unixSeconds));
  const hh = String(d.getUTCHours()).padStart(2, '0');
  const mm = String(d.getUTCMinutes()).padStart(2, '0');
  return `${hh}:${mm}`;
}

function guestLabel(resources: ResourceLike[], node: string, vmid: string): string {
  const match = resources.find(
    (r) =>
      (r.type === 'qemu' || r.type === 'lxc') && r.node === node && String(r.vmid ?? '') === vmid,
  );
  return match?.name ? `${match.name} (${vmid})` : `VM ${vmid}`;
}

function backupAlert(
  incident: BackupIncident,
  resources: ResourceLike[],
  hardAttempts: number,
  healWindowMs: number,
): Alert {
  const label = guestLabel(resources, incident.node, incident.vmid);
  const base = { id: incident.id, kind: 'backup' as const, node: incident.node, vmid: incident.vmid, incident };

  if (incident.state === 'healed') {
    return {
      ...base,
      severity: 'healed',
      title: `Backup of ${label} failed at ${formatTime(incident.lastFailedAt)} · healed by retry at ${formatTime(incident.healedAt!)}`,
      at: incident.healedAt!,
    };
  }

  if (incident.state === 'hard') {
    const healWindowHours = healWindowMs / (60 * 60 * 1000);
    const title =
      incident.attempts.length >= hardAttempts
        ? `Backup of ${label} failed ${incident.attempts.length} times tonight`
        : `Backup of ${label} failed at ${formatTime(incident.lastFailedAt)} — no successful retry within ${healWindowHours} h`;
    return { ...base, severity: 'error', title, at: incident.lastFailedAt };
  }

  const retrying = incident.runningUpid !== undefined;
  return {
    ...base,
    severity: 'warning',
    title: retrying
      ? `Backup of ${label} failed at ${formatTime(incident.lastFailedAt)} — retry in progress`
      : `Backup of ${label} failed at ${formatTime(incident.lastFailedAt)} — waiting for a retry`,
    detail: retrying
      ? 'retry running · heals when it completes'
      : `retry pending · window until ${formatTime(incident.windowEndsAt)}`,
    at: incident.lastFailedAt,
  };
}

const severityRank: Record<AlertSeverity, number> = { error: 0, warning: 1, healed: 2 };

/** Errors first, then warnings, then healed (most recently healed first); stable otherwise. */
function sortAlerts(alerts: Alert[]): Alert[] {
  return [...alerts].sort((a, b) => {
    const rankDiff = severityRank[a.severity] - severityRank[b.severity];
    if (rankDiff !== 0) return rankDiff;
    if (a.severity === 'healed') return b.at - a.at;
    return 0;
  });
}

/**
 * The dashboard alerts strip's full contents: backup incidents (vzdump task history, grouped and
 * retroactively healed by `computeBackupIncidents` -- see its doc comment for the rule), any
 * other task that ended in error within the look-back window (today's behaviour, unchanged), and
 * any storage over `storageThreshold` full (today's behaviour, unchanged).
 */
export function computeAlerts({ resources, tasks, now = Date.now(), options }: ComputeAlertsInput): Alert[] {
  const lookbackMs = options?.lookbackMs ?? DEFAULT_LOOKBACK_MS;
  const healWindowMs = options?.healWindowMs ?? DEFAULT_HEAL_WINDOW_MS;
  const hardAttempts = options?.hardAttempts ?? DEFAULT_HARD_ATTEMPTS;
  const healedVisibilityMs = options?.healedVisibilityMs ?? healWindowMs;
  const storageThreshold = options?.storageThreshold ?? DEFAULT_STORAGE_THRESHOLD;

  const alerts: Alert[] = [];

  const incidents = computeBackupIncidents(tasks, { now, lookbackMs, healWindowMs, hardAttempts });
  for (const incident of incidents) {
    if (incident.state === 'healed' && now - toMs(incident.healedAt!) > healedVisibilityMs) {
      continue;
    }
    alerts.push(backupAlert(incident, resources, hardAttempts, healWindowMs));
  }

  const cutoffSeconds = (now - lookbackMs) / 1000;
  for (const task of tasks) {
    if (task.type === 'vzdump') continue;
    if (task.starttime < cutoffSeconds) continue;
    if (taskFinalState(task.status) !== 'error') continue;
    alerts.push({
      id: task.upid,
      kind: 'task',
      severity: 'error',
      title: `${task.type} failed on ${task.node} (${task.id}) — ${task.user}`,
      at: task.starttime,
      node: task.node,
    });
  }

  for (const r of resources) {
    if (r.type !== 'storage') continue;
    const used = r.disk ?? 0;
    const total = r.maxdisk ?? 0;
    if (total <= 0) continue;
    const fraction = used / total;
    if (fraction > storageThreshold) {
      alerts.push({
        id: r.id ?? `storage:${r.node}:${r.storage}`,
        kind: 'storage',
        severity: 'warning',
        title: `Storage "${r.storage}" on ${r.node} is ${Math.round(fraction * 100)}% full`,
        at: Math.floor(now / 1000),
        ...(r.node !== undefined ? { node: r.node } : {}),
      });
    }
  }

  return sortAlerts(alerts);
}
