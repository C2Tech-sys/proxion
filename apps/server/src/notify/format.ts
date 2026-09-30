import type { ResourceLike } from '@proxion/core';
import type { NotifyEvent, NotifyEventType, NotifyMessage } from './types.js';

/** Order matters only between `warning`/`error` -- `healed` is never compared against the
 *  threshold (a heal is announced via `PROXION_NOTIFY_INCLUDE_RESOLVED`, not min-severity). */
export function severityRank(severity: 'warning' | 'error'): number {
  return severity === 'error' ? 2 : 1;
}

const TYPE_LABEL: Record<NotifyEventType, string> = {
  opened: 'NEW',
  resolved: 'RESOLVED',
  cleared: 'CLEARED',
  escalated: 'ESCALATED',
  'summary-item': 'CURRENT',
  test: 'TEST',
};

/** Finds the guest type (`qemu`/`lxc`) for a vmid in a `/cluster/resources` snapshot, for
 *  building a deep link -- `undefined` when the vmid isn't a guest resource at all (e.g. it was
 *  already removed) or the resources snapshot doesn't have it yet. */
export function resolveGuestType(
  resources: readonly ResourceLike[],
  vmid: string,
): 'qemu' | 'lxc' | undefined {
  const numericVmid = Number(vmid);
  for (const resource of resources) {
    if (
      (resource.type === 'qemu' || resource.type === 'lxc') &&
      resource.vmid !== undefined &&
      resource.vmid === numericVmid
    ) {
      return resource.type;
    }
  }
  return undefined;
}

/**
 * `<url>/vm/<node>/<type>/<vmid>?tab=summary` for a guest alert (one with both `node` and `vmid`,
 * and a resolvable guest type), `<url>/` otherwise (a storage alert, or a guest whose type isn't
 * known any more) -- `undefined` entirely when no `PROXION_PUBLIC_URL` is configured.
 */
export function buildDeepLink(
  alert: { node?: string | undefined; vmid?: string | undefined },
  publicUrl: string | undefined,
  resources: readonly ResourceLike[],
): string | undefined {
  if (!publicUrl) return undefined;
  const base = publicUrl.replace(/\/+$/, '');
  if (alert.node && alert.vmid) {
    const type = resolveGuestType(resources, alert.vmid);
    if (type) return `${base}/vm/${alert.node}/${type}/${alert.vmid}?tab=summary`;
  }
  return `${base}/`;
}

/** One human-readable line for an event -- shared by every text-based channel format (Discord,
 *  Slack, ntfy, and the email plain-text body). */
export function eventLine(event: NotifyEvent): string {
  const label = TYPE_LABEL[event.type];
  const parts = [`[${label}] ${event.title}`];
  if (event.detail) parts.push(event.detail);
  if (event.url) parts.push(event.url);
  return parts.join(' — ');
}

/** The message's headline, e.g. "3 alert(s) opened, 1 resolved" -- used by every channel that
 *  wants a one-line summary (Discord/Slack/ntfy Title/email subject). */
export function summaryHeadline(message: NotifyMessage): string {
  if (message.kind === 'test') return 'Test notification';
  if (message.kind === 'summary') {
    return message.events.length === 0
      ? 'Proxion notifications are active; no current alerts'
      : `Proxion notifications are active; ${message.events.length} current alert(s)`;
  }

  const counts = new Map<NotifyEventType, number>();
  for (const event of message.events) counts.set(event.type, (counts.get(event.type) ?? 0) + 1);
  const bits: string[] = [];
  for (const type of ['opened', 'escalated', 'resolved', 'cleared'] as const) {
    const count = counts.get(type);
    if (count) bits.push(`${count} ${type}`);
  }
  return bits.length > 0 ? `${bits.join(', ')}` : `${message.events.length} update(s)`;
}

/** Full plain-text body: headline, then one line per event. Shared by ntfy's body and the email
 *  channel's plain-text body. */
export function plainTextBody(message: NotifyMessage): string {
  const lines = message.events.map(eventLine);
  return [summaryHeadline(message), ...lines].join('\n');
}

/** The single highest severity across a message's events, for channels that pick one
 *  priority/color for the whole message (ntfy's `Priority` header, Gotify's `priority`). Treats
 *  `healed`/no-events as the lowest priority. */
export function highestSeverity(message: NotifyMessage): 'error' | 'warning' | 'healed' {
  let highest: 'error' | 'warning' | 'healed' = 'healed';
  for (const event of message.events) {
    if (event.severity === 'error') return 'error';
    if (event.severity === 'warning') highest = 'warning';
  }
  return highest;
}
