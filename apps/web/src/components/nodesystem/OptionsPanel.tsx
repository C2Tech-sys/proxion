import { useId, useState } from 'react';
import { Loader2 } from 'lucide-react';

import { EmptyState } from '@/components/EmptyState';
import { KeyValueGrid } from '@/components/KeyValueGrid';
import { Panel } from '@/components/Panel';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { Textarea } from '@/components/ui/textarea';
import { EditHardwareButton } from '@/components/hardware/EditHardwareButton';
import { SystemField } from '@/components/nodesystem/SystemField';
import { parseBoundedInt } from '@/components/nodesystem/systemGate';
import { errorMessage } from '@/api/errors';
import { nodeSystemErrorMessage, useNodeOptions, useUpdateNodeOptions } from '@/api/nodeSystemHooks';
import type { NodeOptions, UpdateOptionsBody } from '@/api/nodeSystem';

const MAC_RE = /^([0-9A-Fa-f]{2}:){5}[0-9A-Fa-f]{2}$/;
const MAX_DESCRIPTION = 8192;

export interface OptionsPanelProps {
  node: string;
  /** Why editing is disabled; `undefined` when the caller may write. */
  disabledReason: string | undefined;
}

/** Node -> System -> Options: description, start-all-on-boot delay, wake-on-LAN MAC, ballooning
 * target. (The ACME fields of the node config are not editable here.) */
export function OptionsPanel({ node, disabledReason }: OptionsPanelProps) {
  const options = useNodeOptions(node);
  const [editing, setEditing] = useState(false);

  return (
    <div data-testid="node-system-options">
      <Panel
        title="Options"
        action={
          options.data ? (
            <EditHardwareButton label="options" disabledReason={disabledReason} onClick={() => setEditing(true)} />
          ) : undefined
        }
      >
        {options.isLoading ? (
          <Skeleton className="h-24" />
        ) : options.isError ? (
          <EmptyState message={`Could not load the node options: ${errorMessage(options.error)}`} />
        ) : options.data ? (
          <KeyValueGrid
            rows={[
              { label: 'Description', value: options.data.description ?? '-' },
              {
                label: 'Start all on boot delay (s)',
                value: options.data.startallOnbootDelay !== undefined ? String(options.data.startallOnbootDelay) : '-',
              },
              { label: 'Wake-on-LAN MAC', value: options.data.wakeonlan ?? '-' },
              {
                label: 'Ballooning target (%)',
                value: options.data.ballooningTarget !== undefined ? String(options.data.ballooningTarget) : '-',
              },
            ]}
          />
        ) : null}
      </Panel>
      {editing && options.data && (
        <OptionsDialog
          open
          onOpenChange={(open) => {
            if (!open) setEditing(false);
          }}
          node={node}
          current={options.data}
        />
      )}
    </div>
  );
}

interface OptionsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  node: string;
  current: NodeOptions;
}

/**
 * Edits the node options. Sends only what changed -- clearing a field that had a value sends `null`
 * -- plus the digest of the read this dialog started from, so PVE refuses the save if the config
 * changed underneath. Mount it fresh per open.
 */
function OptionsDialog({ open, onOpenChange, node, current }: OptionsDialogProps) {
  const id = useId();
  const mutation = useUpdateNodeOptions();
  const [description, setDescription] = useState(current.description ?? '');
  const [delayText, setDelayText] = useState(current.startallOnbootDelay !== undefined ? String(current.startallOnbootDelay) : '');
  const [mac, setMac] = useState(current.wakeonlan ?? '');
  const [targetText, setTargetText] = useState(current.ballooningTarget !== undefined ? String(current.ballooningTarget) : '');

  const busy = mutation.isPending;
  const delay = parseBoundedInt(delayText, 0, 300);
  const target = parseBoundedInt(targetText, 0, 100);
  const trimmedMac = mac.trim();
  const errors = {
    description: description.length > MAX_DESCRIPTION ? `A description can be at most ${MAX_DESCRIPTION} characters.` : undefined,
    delay: delay === undefined ? 'Enter a whole number of seconds between 0 and 300.' : undefined,
    mac: trimmedMac !== '' && !MAC_RE.test(trimmedMac) ? 'Enter a MAC address like aa:bb:cc:dd:ee:ff.' : undefined,
    target: target === undefined ? 'Enter a whole number between 0 and 100.' : undefined,
  };
  const valid = Object.values(errors).every((e) => e === undefined);

  // Only the fields that differ from what the dialog opened with; blank -> null (clear).
  const body: UpdateOptionsBody = {};
  if (description !== (current.description ?? '')) body.description = description.trim() === '' ? null : description;
  if (delay !== undefined && delay !== (current.startallOnbootDelay ?? null)) body.startallOnbootDelay = delay;
  if (trimmedMac !== (current.wakeonlan ?? '')) body.wakeonlan = trimmedMac === '' ? null : trimmedMac;
  if (target !== undefined && target !== (current.ballooningTarget ?? null)) body.ballooningTarget = target;
  const changed = Object.keys(body).length > 0;
  const canSave = valid && changed && !busy;

  function submit() {
    if (!canSave) return;
    const withDigest: UpdateOptionsBody = current.digest !== undefined ? { ...body, digest: current.digest } : body;
    mutation.mutate({ node, body: withDigest }, { onSuccess: () => onOpenChange(false) });
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next && busy) return;
        onOpenChange(next);
      }}
    >
      <DialogContent className="max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Edit: Options</DialogTitle>
          <DialogDescription>Leave a field blank to clear it.</DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-4">
          <SystemField label="Description" htmlFor={`${id}-description`} error={errors.description}>
            <Textarea
              id={`${id}-description`}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              disabled={busy}
              rows={3}
              aria-invalid={errors.description !== undefined || undefined}
            />
          </SystemField>
          <SystemField
            label="Start all on boot delay (s)"
            htmlFor={`${id}-delay`}
            error={errors.delay}
            hint="Seconds to wait before starting guests after the node boots (0-300)."
          >
            <Input
              id={`${id}-delay`}
              value={delayText}
              onChange={(e) => setDelayText(e.target.value)}
              disabled={busy}
              inputMode="numeric"
              aria-invalid={errors.delay !== undefined || undefined}
              autoComplete="off"
            />
          </SystemField>
          <SystemField label="Wake-on-LAN MAC" htmlFor={`${id}-mac`} error={errors.mac}>
            <Input
              id={`${id}-mac`}
              value={mac}
              onChange={(e) => setMac(e.target.value)}
              disabled={busy}
              aria-invalid={errors.mac !== undefined || undefined}
              placeholder="aa:bb:cc:dd:ee:ff"
              autoComplete="off"
            />
          </SystemField>
          <SystemField
            label="Ballooning target (%)"
            htmlFor={`${id}-target`}
            error={errors.target}
            hint="Memory usage (0-100) above which guest ballooning starts."
          >
            <Input
              id={`${id}-target`}
              value={targetText}
              onChange={(e) => setTargetText(e.target.value)}
              disabled={busy}
              inputMode="numeric"
              aria-invalid={errors.target !== undefined || undefined}
              autoComplete="off"
            />
          </SystemField>
          {mutation.isError && (
            <p role="alert" className="text-xs text-status-error">
              {nodeSystemErrorMessage(mutation.error, 'The node options could not be saved.')}
            </p>
          )}
        </div>

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
