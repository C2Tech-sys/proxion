import type { Alert, AlertKind, AlertSeverity, ResourceLike } from '@proxion/core';
import { buildDeepLink, severityRank } from './format.js';
import type { NotifyEvent } from './types.js';

/**
 * What we remember about one alert id across snapshots -- enough to format a `'cleared'` event
 * (title/kind/detail/node/vmid) even after the alert itself has vanished from the latest
 * snapshot, and enough to decide every other transition (`severity`, and whether/when it was last
 * announced). Persisted verbatim to `<PROXION_DATA_DIR>/notify-state.json` (see `notifier.ts`) so
 * a restart never re-announces an alert it already told someone about.
 */
export interface KnownAlert {
  severity: AlertSeverity;
  kind: AlertKind;
  title: string;
  detail?: string | undefined;
  node?: string | undefined;
  vmid?: string | undefined;
  /** Unix epoch seconds this id was first seen, known or not. */
  firstSeenAt: number;
  /** Unix epoch seconds this id was last announced (an `'opened'`/`'escalated'` transition) --
   *  `undefined` means it's tracked but has never crossed `minSeverity`, so a later heal/removal
   *  is not worth a `'resolved'`/`'cleared'` notice either (nobody was ever told it was open). */
  notifiedAt?: number | undefined;
}

export type KnownAlertMap = ReadonlyMap<string, KnownAlert>;

export interface ComputeTransitionsOptions {
  currentAlerts: readonly Alert[];
  known: KnownAlertMap;
  minSeverity: 'warning' | 'error';
  includeResolved: boolean;
  /** Unix epoch ms (a `Date.now()`-shaped value -- see `Notifier`'s injectable clock). */
  now: number;
  publicUrl?: string | undefined;
  resources: readonly ResourceLike[];
}

export interface ComputeTransitionsResult {
  events: NotifyEvent[];
  nextKnown: Map<string, KnownAlert>;
}

function knownFrom(alert: Alert, extra: Partial<KnownAlert> = {}): KnownAlert {
  return {
    severity: alert.severity,
    kind: alert.kind,
    title: alert.title,
    detail: alert.detail,
    node: alert.node,
    vmid: alert.vmid,
    firstSeenAt: extra.firstSeenAt ?? 0,
    notifiedAt: extra.notifiedAt,
  };
}

/**
 * Diffs one alerts snapshot against the previously-known state and returns both the transition
 * events to notify about and the updated known-state map to persist. Pure (no I/O, no timers) so
 * it's exercised directly in `test/notifier.test.ts` without any fake clock/timer plumbing --
 * `Notifier` itself only adds persistence, debouncing and channel delivery around this.
 *
 * Transition rules (see the ticket for the full spec):
 *  - a brand new alert at/above `minSeverity` -> `'opened'`; below it, tracked silently.
 *  - a known alert whose severity becomes `'healed'` -> `'resolved'` (only if it was ever
 *    `'opened'`, and only if `includeResolved`).
 *  - a known, previously-opened alert that disappears from the snapshot -> `'cleared'` ("no
 *    longer reported"), same `includeResolved` gate; removed from `nextKnown` either way.
 *  - warning -> error on a previously-opened alert -> `'escalated'`; on one that was tracked but
 *    never opened (below `minSeverity` as a warning), crossing to error is its first `'opened'`.
 *  - error -> warning (de-escalation) and any other severity-preserving update just refresh the
 *    stored snapshot -- no event.
 */
export function computeTransitions(options: ComputeTransitionsOptions): ComputeTransitionsResult {
  const { currentAlerts, known, minSeverity, includeResolved, now, publicUrl, resources } = options;
  const nowSeconds = Math.floor(now / 1000);
  const nextKnown = new Map(known);
  const events: NotifyEvent[] = [];
  const seenIds = new Set<string>();

  for (const alert of currentAlerts) {
    seenIds.add(alert.id);
    const prior = known.get(alert.id);
    const url = buildDeepLink(alert, publicUrl, resources);
    const emit = (type: NotifyEvent['type']): void => {
      events.push({
        type,
        severity: alert.severity,
        kind: alert.kind,
        title: alert.title,
        detail: alert.detail,
        node: alert.node,
        vmid: alert.vmid,
        at: alert.at,
        url,
      });
    };

    if (!prior) {
      const meetsThreshold =
        alert.severity !== 'healed' && severityRank(alert.severity) >= severityRank(minSeverity);
      if (meetsThreshold) emit('opened');
      nextKnown.set(
        alert.id,
        knownFrom(alert, { firstSeenAt: nowSeconds, notifiedAt: meetsThreshold ? nowSeconds : undefined }),
      );
      continue;
    }

    if (alert.severity === 'healed' && prior.severity !== 'healed') {
      if (prior.notifiedAt !== undefined && includeResolved) emit('resolved');
      nextKnown.set(alert.id, { ...prior, severity: 'healed', title: alert.title, detail: alert.detail });
      continue;
    }

    if (alert.severity === 'error' && prior.severity === 'warning') {
      if (prior.notifiedAt !== undefined) {
        emit('escalated');
        nextKnown.set(alert.id, {
          ...prior,
          severity: 'error',
          title: alert.title,
          detail: alert.detail,
          notifiedAt: nowSeconds,
        });
      } else if (severityRank('error') >= severityRank(minSeverity)) {
        emit('opened');
        nextKnown.set(alert.id, {
          ...prior,
          severity: 'error',
          title: alert.title,
          detail: alert.detail,
          notifiedAt: nowSeconds,
        });
      } else {
        nextKnown.set(alert.id, { ...prior, severity: 'error', title: alert.title, detail: alert.detail });
      }
      continue;
    }

    // De-escalation (error -> warning), a re-opened healed alert (healed -> warning/error, which
    // `!prior` already can't be since `prior` exists -- this is a genuine re-occurrence), or no
    // severity change at all: refresh the cached fields, no event either way. A re-occurrence
    // after healing is deliberately treated like any other severity update rather than a fresh
    // `'opened'` -- the incident id (`backup:<node>:<vmid>:<upid>`) is stable per run of
    // failures, so PVE itself will mint a new id for a genuinely new run.
    nextKnown.set(alert.id, { ...prior, severity: alert.severity, title: alert.title, detail: alert.detail });
  }

  for (const [id, prior] of known) {
    if (seenIds.has(id)) continue;
    if (prior.notifiedAt !== undefined && includeResolved) {
      events.push({
        type: 'cleared',
        severity: prior.severity,
        kind: prior.kind,
        title: prior.title,
        detail: 'No longer reported',
        node: prior.node,
        vmid: prior.vmid,
        at: nowSeconds,
        url: buildDeepLink(prior, publicUrl, resources),
      });
    }
    nextKnown.delete(id);
  }

  return { events, nextKnown };
}
