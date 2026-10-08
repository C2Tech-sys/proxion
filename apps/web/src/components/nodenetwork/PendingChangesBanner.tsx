import { Loader2, TriangleAlert } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { useRevertNodeNetwork } from '@/api/nodeNetworkHooks';

export interface PendingChangesBannerProps {
  node: string;
  /** PVE's pending-changes diff; the banner renders nothing when it is blank. */
  changes: string;
  /** When set, Apply and Revert are disabled and this is their tooltip. */
  disabledReason?: string | undefined;
  onApply: () => void;
}

/**
 * The yellow strip above the interface table while PVE holds staged network changes: the diff in
 * a `<pre>`, **Apply configuration** (opens the typed confirmation) and **Revert** (discards the
 * staged changes straight away -- nothing live is affected).
 */
export function PendingChangesBanner({ node, changes, disabledReason, onApply }: PendingChangesBannerProps) {
  const revert = useRevertNodeNetwork();
  if (changes.trim() === '') return null;
  const disabled = disabledReason !== undefined;

  return (
    <div
      role="status"
      data-testid="node-network-pending"
      className="mb-3 rounded-lg border border-status-paused/50 bg-status-paused/10 px-3 py-3 text-sm"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2 font-medium">
          <TriangleAlert className="size-4 shrink-0 text-status-paused" aria-hidden="true" />
          <span>Pending changes: not applied to the node yet</span>
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            disabled={disabled || revert.isPending}
            aria-disabled={disabled || undefined}
            title={disabledReason}
            onClick={() => revert.mutate(node)}
          >
            {revert.isPending && <Loader2 className="size-4 animate-spin" />}
            Revert
          </Button>
          <Button size="sm" disabled={disabled} aria-disabled={disabled || undefined} title={disabledReason} onClick={onApply}>
            Apply configuration
          </Button>
        </div>
      </div>
      <pre
        data-testid="node-network-pending-diff"
        className="mt-2 max-h-64 overflow-auto rounded-md border border-border bg-background px-3 py-2 font-mono text-xs"
      >
        {changes}
      </pre>
    </div>
  );
}
