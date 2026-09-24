import { useState } from 'react';
import { ChevronDown, ChevronRight, CircleAlert, CircleCheck, TriangleAlert } from 'lucide-react';
import type { Alert } from '@proxion/core';

import { useAlerts } from '@/api/hooks';
import { cn } from '@/lib/utils';

/** Remembers whether the "Recently healed" disclosure is open, per T23's spec (collapsed by
 * default). Best-effort: a private window or blocked site data just falls back to collapsed. */
const HEALED_DISCLOSURE_KEY = 'proxion.alertsStrip.healedOpen';

function readStoredDisclosure(): boolean {
  try {
    return localStorage.getItem(HEALED_DISCLOSURE_KEY) === '1';
  } catch {
    return false;
  }
}

function writeStoredDisclosure(open: boolean): void {
  try {
    localStorage.setItem(HEALED_DISCLOSURE_KEY, open ? '1' : '0');
  } catch {
    // ignore persistence failures (private browsing, blocked site data, ...)
  }
}

function AlertRow({ alert }: { alert: Alert }) {
  if (alert.severity === 'error') {
    return (
      <div className="flex items-center gap-2 text-sm">
        <CircleAlert className="size-4 shrink-0 text-status-error" />
        <span className="min-w-0 flex-1 truncate">{alert.title}</span>
      </div>
    );
  }

  if (alert.severity === 'warning') {
    return (
      <div className="flex items-center gap-2 text-sm">
        <TriangleAlert className="size-4 shrink-0 text-status-paused" />
        <span className="min-w-0 flex-1 truncate">{alert.title}</span>
        {alert.detail ? (
          <span className="shrink-0 text-xs text-muted-foreground">{alert.detail}</span>
        ) : null}
      </div>
    );
  }

  // 'healed' -- muted, small green check, single line (no detail suffix: the title already
  // carries both timestamps, e.g. "... failed at 20:10 · healed by retry at 20:15").
  return (
    <div className="flex items-center gap-2 text-sm text-muted-foreground">
      <CircleCheck className="size-3.5 shrink-0 text-status-running" />
      <span className="truncate">{alert.title}</span>
    </div>
  );
}

/**
 * The dashboard's alerts strip: backup incidents (soft -> warning, hard -> error, healed ->
 * muted, grouped under a collapsible disclosure), other failed tasks (error), and storage-full
 * warnings -- see `@proxion/core`'s `computeAlerts`. Self-sufficient (reads `useAlerts()` itself)
 * so both the Dashboard and, filtered to one guest, the VM Summary "Last backup" panel can use
 * the same source without threading resources/tasks through props. Hidden entirely when there's
 * nothing to show.
 */
export function AlertsStrip() {
  const { data: alerts } = useAlerts();
  const [healedOpen, setHealedOpen] = useState(readStoredDisclosure);

  if (!alerts || alerts.length === 0) return null;

  const errors = alerts.filter((a) => a.severity === 'error');
  const warnings = alerts.filter((a) => a.severity === 'warning');
  const healed = alerts.filter((a) => a.severity === 'healed');
  const hasErrorsOrWarnings = errors.length + warnings.length > 0;

  function toggleHealedOpen() {
    setHealedOpen((open) => {
      const next = !open;
      writeStoredDisclosure(next);
      return next;
    });
  }

  return (
    <div
      className={cn(
        'flex flex-col gap-1.5 rounded-lg border p-3',
        hasErrorsOrWarnings ? 'border-status-error/40 bg-status-error/10' : 'border-border bg-muted/40',
      )}
    >
      {[...errors, ...warnings].map((alert) => (
        <AlertRow key={alert.id} alert={alert} />
      ))}

      {healed.length > 0 && (
        <div className={hasErrorsOrWarnings ? 'mt-1 border-t border-border/60 pt-1.5' : undefined}>
          <button
            type="button"
            onClick={toggleHealedOpen}
            aria-expanded={healedOpen}
            className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
          >
            {healedOpen ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}
            Recently healed ({healed.length})
          </button>
          {healedOpen && (
            <div className="mt-1.5 flex flex-col gap-1.5 pl-1">
              {healed.map((alert) => (
                <AlertRow key={alert.id} alert={alert} />
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
