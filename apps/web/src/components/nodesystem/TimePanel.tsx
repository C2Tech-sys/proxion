import { useId, useMemo, useState } from 'react';
import { Loader2 } from 'lucide-react';

import { EmptyState } from '@/components/EmptyState';
import { KeyValueGrid } from '@/components/KeyValueGrid';
import { Panel } from '@/components/Panel';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Skeleton } from '@/components/ui/skeleton';
import { EditHardwareButton } from '@/components/hardware/EditHardwareButton';
import { NativeSelect } from '@/components/hardware/NativeSelect';
import { SystemField } from '@/components/nodesystem/SystemField';
import { formatEpochDateTime, timeZoneOptions } from '@/components/nodesystem/systemFormat';
import { errorMessage } from '@/api/errors';
import { nodeSystemErrorMessage, useNodeTime, useUpdateNodeTime } from '@/api/nodeSystemHooks';

export interface TimePanelProps {
  node: string;
  /** Why editing is disabled; `undefined` when the caller may write. */
  disabledReason: string | undefined;
}

/** Node -> System -> Time: the time zone and the node's clock (local and UTC, as absolute times). */
export function TimePanel({ node, disabledReason }: TimePanelProps) {
  const time = useNodeTime(node);
  const [editing, setEditing] = useState(false);

  return (
    <div data-testid="node-system-time">
      <Panel
        title="Time"
        action={
          time.data ? (
            <EditHardwareButton label="time zone" disabledReason={disabledReason} onClick={() => setEditing(true)} />
          ) : undefined
        }
      >
        {time.isLoading ? (
          <Skeleton className="h-16" />
        ) : time.isError ? (
          <EmptyState message={`Could not load the time settings: ${errorMessage(time.error)}`} />
        ) : time.data ? (
          <KeyValueGrid
            rows={[
              { label: 'Time zone', value: time.data.timezone },
              { label: 'Server time', value: formatEpochDateTime(time.data.localtime) },
              { label: 'UTC time', value: `${formatEpochDateTime(time.data.time)} UTC` },
            ]}
          />
        ) : null}
      </Panel>
      {editing && time.data && (
        <TimeZoneDialog
          open
          onOpenChange={(open) => {
            if (!open) setEditing(false);
          }}
          node={node}
          current={time.data.timezone}
        />
      )}
    </div>
  );
}

interface TimeZoneDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  node: string;
  current: string;
}

/** Picks the node's time zone from the browser's list (or a short built-in one). Mount it fresh
 * per open. */
function TimeZoneDialog({ open, onOpenChange, node, current }: TimeZoneDialogProps) {
  const id = useId();
  const mutation = useUpdateNodeTime();
  const zones = useMemo(() => timeZoneOptions(current), [current]);
  const [zone, setZone] = useState(current);
  const busy = mutation.isPending;
  const canSave = zone !== current && !busy;

  function submit() {
    if (!canSave) return;
    mutation.mutate({ node, body: { timezone: zone } }, { onSuccess: () => onOpenChange(false) });
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next && busy) return;
        onOpenChange(next);
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Edit: Time zone</DialogTitle>
          <DialogDescription>Sets the time zone the node displays and logs in.</DialogDescription>
        </DialogHeader>

        <SystemField label="Time zone" htmlFor={`${id}-zone`}>
          <NativeSelect id={`${id}-zone`} value={zone} onChange={(e) => setZone(e.target.value)} disabled={busy}>
            {zones.map((z) => (
              <option key={z} value={z}>
                {z}
              </option>
            ))}
          </NativeSelect>
        </SystemField>

        {mutation.isError && (
          <p role="alert" className="text-xs text-status-error">
            {nodeSystemErrorMessage(mutation.error, 'The time zone could not be saved.')}
          </p>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={!canSave}>
            {busy && <Loader2 className="size-4 animate-spin" />}
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
