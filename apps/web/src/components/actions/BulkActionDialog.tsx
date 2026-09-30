import { useState } from 'react';
import { Loader2 } from 'lucide-react';
import { useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Checkbox } from '@/components/ui/checkbox';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { guestAction } from '@/api/actions';
import { CLUSTER_RESOURCES_QUERY_KEY } from '@/api/liveState';
import { guestKey } from '@/pages/guests/guestList';
import {
  BULK_ACTION_VERB,
  runWithConcurrency,
  splitBulkAction,
  type BulkAction,
  type BulkGuest,
  type BulkRunResult,
} from '@/lib/bulkActions';

/** Same timeout choices as `GuestActionDialog`'s own shutdown/reboot controls -- a tiny,
 *  bulk-specific duplicate (see `bulkActions.ts`'s own note on why this isn't a shared import). */
const TIMEOUT_OPTIONS = [60, 120, 180, 300, 600] as const;
const DEFAULT_TIMEOUT_SECONDS = 120;

/** How many `guestAction` requests this dialog lets run at once (T44's ticket spec). */
const CONCURRENCY_LIMIT = 3;

function guestWord(count: number): string {
  return count === 1 ? 'guest' : 'guests';
}

export interface BulkActionDialogProps {
  action: BulkAction;
  /** The currently-selected guests, in whatever order the table has them -- this dialog splits
   *  them into applicable/skipped itself (`splitBulkAction`), so the caller doesn't have to. */
  guests: BulkGuest[];
  /** Called whenever the dialog should close (Cancel, Close, or an outside dismissal once the run
   *  isn't in flight) -- the caller owns whether this component is mounted at all. */
  onOpenChange: (open: boolean) => void;
  /** Called exactly once, right after a run finishes, with the keys (`guestKey`) of every guest
   *  that failed -- empty when every applicable guest started successfully. The Guests page uses
   *  this to clear the whole selection on a clean run, or narrow it down to just the failures. */
  onRunComplete: (failedKeys: string[]) => void;
}

type Phase = 'confirm' | 'running' | 'summary';

/**
 * Confirms and runs one power action across every applicable guest in the current selection
 * (T44). Guests the action doesn't apply to (wrong power state, or a template) are listed
 * separately and never sent to `guestAction` at all; the applicable ones run with a concurrency
 * limit of `CONCURRENCY_LIMIT` (`runWithConcurrency`) so a large selection doesn't fire dozens of
 * requests at once. Unlike the per-guest `useGuestAction`, this never toasts per guest -- only
 * once, with the whole run's summary -- and reports which guests still need attention
 * (`onRunComplete`) so the Guests page can drop successes from the selection while leaving
 * failures selected for an easy retry.
 */
export function BulkActionDialog({ action, guests, onOpenChange, onRunComplete }: BulkActionDialogProps) {
  const queryClient = useQueryClient();
  const [phase, setPhase] = useState<Phase>('confirm');
  const [forceStop, setForceStop] = useState(false);
  const [timeoutSeconds, setTimeoutSeconds] = useState<number>(DEFAULT_TIMEOUT_SECONDS);
  const [done, setDone] = useState(0);
  const [results, setResults] = useState<BulkRunResult<BulkGuest>[]>([]);

  const { applicable, skipped } = splitBulkAction(guests, action);
  const verb = BULK_ACTION_VERB[action];

  function handleConfirm(): void {
    setPhase('running');
    setDone(0);

    const body = action === 'shutdown' && forceStop ? { forceStop: true, timeout: timeoutSeconds } : undefined;

    void runWithConcurrency(applicable, CONCURRENCY_LIMIT, async (guest) => {
      try {
        await guestAction(guest.node, guest.type, guest.vmid, action, body);
      } finally {
        setDone((n) => n + 1);
      }
    }).then((runResults) => {
      setResults(runResults);
      setPhase('summary');

      const succeeded = runResults.filter((r) => r.ok);
      const failed = runResults.filter((r) => !r.ok);
      const summary =
        failed.length === 0 ? `${succeeded.length} started` : `${succeeded.length} started, ${failed.length} failed`;
      toast[failed.length === 0 ? 'success' : 'error'](summary);

      if (succeeded.length > 0) {
        void queryClient.invalidateQueries({ queryKey: CLUSTER_RESOURCES_QUERY_KEY });
        for (const r of succeeded) {
          void queryClient.invalidateQueries({ queryKey: ['vm-status', r.item.node, r.item.type, r.item.vmid] });
        }
      }

      onRunComplete(failed.map((r) => guestKey(r.item)));
    });
  }

  return (
    <AlertDialog
      open
      onOpenChange={(open) => {
        if (!open && phase !== 'running') onOpenChange(false);
      }}
    >
      <AlertDialogContent>
        {phase === 'confirm' && (
          <>
            <AlertDialogHeader>
              <AlertDialogTitle>
                {verb} {applicable.length} {guestWord(applicable.length)}?
              </AlertDialogTitle>
              <AlertDialogDescription>
                {applicable.length === 0
                  ? 'None of the selected guests can be acted on right now.'
                  : `${verb} will be requested for ${applicable.length} ${guestWord(applicable.length)}.`}
              </AlertDialogDescription>
            </AlertDialogHeader>

            {applicable.length > 0 && (
              <ul className="max-h-40 space-y-1 overflow-y-auto text-sm">
                {applicable.map((guest) => (
                  <li key={guestKey(guest)} className="rounded-md border border-border bg-muted/40 px-3 py-1.5">
                    <span className="font-medium text-foreground">{guest.name}</span>{' '}
                    <span className="text-muted-foreground font-numeric">(VMID {guest.vmid})</span>{' '}
                    <span className="text-muted-foreground">on {guest.node}</span>
                  </li>
                ))}
              </ul>
            )}

            {skipped.length > 0 && (
              <details className="text-sm text-muted-foreground">
                <summary className="cursor-pointer select-none">Skipped ({skipped.length})</summary>
                <ul className="mt-1 space-y-1">
                  {skipped.map(({ guest, reason }) => (
                    <li key={guestKey(guest)}>
                      {guest.name} (VMID {guest.vmid}) — {reason}
                    </li>
                  ))}
                </ul>
              </details>
            )}

            {action === 'shutdown' && (
              <div className="flex items-center gap-2">
                <Checkbox
                  id="bulk-action-force-stop"
                  checked={forceStop}
                  onCheckedChange={(checked) => setForceStop(checked === true)}
                />
                <label htmlFor="bulk-action-force-stop" className="text-sm">
                  Force stop after timeout
                </label>
                <Select
                  value={String(timeoutSeconds)}
                  onValueChange={(value) => setTimeoutSeconds(Number(value))}
                  disabled={!forceStop}
                >
                  <SelectTrigger size="sm" className="ml-auto w-24" aria-label="Force-stop timeout">
                    <SelectValue>{`${timeoutSeconds}s`}</SelectValue>
                  </SelectTrigger>
                  <SelectContent>
                    {TIMEOUT_OPTIONS.map((seconds) => (
                      <SelectItem key={seconds} value={String(seconds)}>
                        {seconds}s
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}

            <AlertDialogFooter>
              <AlertDialogCancel>Cancel</AlertDialogCancel>
              <AlertDialogAction
                variant={action === 'stop' ? 'destructive' : 'default'}
                disabled={applicable.length === 0}
                onClick={(event) => {
                  // Radix closes the dialog on click by default; this flow needs to stay open
                  // through the running/summary phases, same reasoning as `GuestActionDialog`.
                  event.preventDefault();
                  handleConfirm();
                }}
              >
                {verb} {applicable.length} {guestWord(applicable.length)}
              </AlertDialogAction>
            </AlertDialogFooter>
          </>
        )}

        {phase === 'running' && (
          <>
            <AlertDialogHeader>
              <AlertDialogTitle className="flex items-center gap-2">
                <Loader2 className="size-4 animate-spin" /> Running…
              </AlertDialogTitle>
              <AlertDialogDescription>
                {done} of {applicable.length} done
              </AlertDialogDescription>
            </AlertDialogHeader>
            <div className="h-2 w-full overflow-hidden rounded-full bg-muted" role="progressbar" aria-valuenow={done} aria-valuemin={0} aria-valuemax={applicable.length}>
              <div
                className="h-full bg-primary transition-all"
                style={{ width: `${applicable.length === 0 ? 0 : (done / applicable.length) * 100}%` }}
              />
            </div>
          </>
        )}

        {phase === 'summary' && (
          <>
            <AlertDialogHeader>
              <AlertDialogTitle>
                {results.filter((r) => r.ok).length} started
                {results.some((r) => !r.ok) ? `, ${results.filter((r) => !r.ok).length} failed` : ''}
              </AlertDialogTitle>
            </AlertDialogHeader>
            {results.some((r) => !r.ok) && (
              <ul className="space-y-1 text-sm text-destructive">
                {results
                  .filter((r) => !r.ok)
                  .map((r) => (
                    <li key={guestKey(r.item)}>
                      {r.item.name}: {r.error}
                    </li>
                  ))}
              </ul>
            )}
            <AlertDialogFooter>
              <AlertDialogAction>Close</AlertDialogAction>
            </AlertDialogFooter>
          </>
        )}
      </AlertDialogContent>
    </AlertDialog>
  );
}
