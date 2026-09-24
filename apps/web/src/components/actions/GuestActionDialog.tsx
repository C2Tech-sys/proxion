import { useState } from 'react';
import { Loader2 } from 'lucide-react';

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
import type { GuestAction, GuestActionBody } from '@/api/actions';

const ACTION_VERB: Record<GuestAction, string> = {
  start: 'Start',
  shutdown: 'Shut down',
  stop: 'Stop',
  reboot: 'Reboot',
  reset: 'Reset',
  suspend: 'Pause',
  resume: 'Resume',
};

const ACTION_CONSEQUENCE: Record<GuestAction, string> = {
  start: 'The guest will be powered on.',
  shutdown: 'Sends an ACPI shutdown request to the guest OS.',
  stop: 'Stop is a hard power-off; the guest OS is not shut down cleanly.',
  reboot: 'Sends an ACPI reboot request to the guest OS.',
  reset: 'Reset is a hard power-off and restart; the guest OS is not shut down cleanly.',
  suspend: "The guest's state is saved to memory and its vCPUs are paused.",
  resume: 'The guest resumes from its paused state.',
};

const DESTRUCTIVE_ACTIONS = new Set<GuestAction>(['stop', 'reset']);

const TIMEOUT_OPTIONS = [60, 120, 180, 300, 600] as const;
const DEFAULT_TIMEOUT_SECONDS = 120;

export interface GuestActionDialogTarget {
  name: string;
  vmid: number;
  node: string;
}

export interface GuestActionDialogProps {
  /** The action to confirm, or `null` to render nothing (closed). */
  action: GuestAction | null;
  target: GuestActionDialogTarget;
  /** Whether the mutation this dialog's confirm button triggered is in flight. */
  isPending: boolean;
  onCancel: () => void;
  onConfirm: (body?: GuestActionBody) => void;
}

/**
 * The one confirmation dialog every guest quick action (header buttons, "More" menu, inventory
 * tree context menu) opens through `useGuestActionFlow`, so the copy, the destructive styling
 * and the shutdown/reboot timeout controls only exist once. Renders nothing when `action` is
 * `null`; give it a `key` derived from `action` where it's mounted so its local timeout/force-
 * stop state resets between one action and the next instead of carrying over.
 */
export function GuestActionDialog({ action, target, isPending, onCancel, onConfirm }: GuestActionDialogProps) {
  const [forceStop, setForceStop] = useState(false);
  const [timeoutSeconds, setTimeoutSeconds] = useState<number>(DEFAULT_TIMEOUT_SECONDS);

  if (!action) return null;

  const verb = ACTION_VERB[action];
  const destructive = DESTRUCTIVE_ACTIONS.has(action);

  function handleConfirm() {
    if (action === 'shutdown') {
      onConfirm(forceStop ? { forceStop: true, timeout: timeoutSeconds } : undefined);
    } else if (action === 'reboot') {
      onConfirm({ timeout: timeoutSeconds });
    } else {
      onConfirm(undefined);
    }
  }

  return (
    <AlertDialog
      open
      onOpenChange={(open) => {
        if (!open && !isPending) onCancel();
      }}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>
            {verb} {target.name}?
          </AlertDialogTitle>
          <AlertDialogDescription>{ACTION_CONSEQUENCE[action]}</AlertDialogDescription>
        </AlertDialogHeader>

        <div className="rounded-md border border-border bg-muted/40 px-3 py-2 text-sm">
          <span className="font-medium text-foreground">{target.name}</span>{' '}
          <span className="text-muted-foreground font-numeric">(VMID {target.vmid})</span>{' '}
          <span className="text-muted-foreground">on {target.node}</span>
        </div>

        {action === 'shutdown' && (
          <div className="flex items-center gap-2">
            <Checkbox
              id="guest-action-force-stop"
              checked={forceStop}
              onCheckedChange={(checked) => setForceStop(checked === true)}
            />
            <label htmlFor="guest-action-force-stop" className="text-sm">
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

        {action === 'reboot' && (
          <div className="flex items-center gap-2">
            <label className="text-sm text-muted-foreground">Timeout</label>
            <Select value={String(timeoutSeconds)} onValueChange={(value) => setTimeoutSeconds(Number(value))}>
              <SelectTrigger size="sm" className="ml-auto w-24" aria-label="Reboot timeout">
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
          <AlertDialogCancel disabled={isPending}>Cancel</AlertDialogCancel>
          <AlertDialogAction
            variant={destructive ? 'destructive' : 'default'}
            disabled={isPending}
            onClick={(event) => {
              // Radix's AlertDialogAction closes the dialog on click by default; this flow
              // closes it itself once the mutation settles (see useGuestActionFlow), so the
              // dialog can stay open (with a spinner) while the request is in flight.
              event.preventDefault();
              handleConfirm();
            }}
          >
            {isPending && <Loader2 className="size-4 animate-spin" />}
            {verb}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
