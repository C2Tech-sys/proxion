import { Button } from '@/components/ui/button';
import { BULK_ACTION_VERB, type BulkAction } from '@/lib/bulkActions';

/** Same copy as `GuestContextMenu`/`ObjectHeader`'s own token-mode disabled reason -- kept as its
 *  own tiny constant here rather than importing either of those files (T44's ticket: reuse
 *  power-action *routes*, not internals). */
const READ_ONLY_TOOLTIP = 'Read-only: signed in with a service token';

const BAR_ACTIONS: BulkAction[] = ['start', 'shutdown', 'reboot', 'stop'];

export interface BulkActionsBarProps {
  /** Guests currently selected in the table, regardless of whether the action about to be picked
   *  applies to all of them -- `BulkActionDialog` is what actually splits applicable/skipped. */
  selectedCount: number;
  /** True when the caller can't run any write action at all (a service token, not a session) --
   *  every button is disabled with the standard read-only tooltip; the server enforces this
   *  independently either way, same as every other quick action in the app. */
  tokenMode: boolean;
  onAction: (action: BulkAction) => void;
  onClear: () => void;
}

/**
 * The bulk power-actions bar above the Guests table (T44): appears once at least one guest is
 * selected, offering Start/Shut down/Reboot/Stop across the whole selection at once (each opens
 * `BulkActionDialog` to confirm) plus a Clear button. Per-guest applicability (a template, or the
 * wrong power state) is resolved by the dialog, not here -- this bar doesn't know which guests are
 * selected, only how many.
 */
export function BulkActionsBar({ selectedCount, tokenMode, onAction, onClear }: BulkActionsBarProps) {
  if (selectedCount === 0) return null;

  return (
    <div
      role="toolbar"
      aria-label="Bulk guest actions"
      className="flex flex-wrap items-center gap-2 rounded-md border border-border bg-muted/40 px-3 py-2 text-sm"
    >
      <span className="font-medium text-foreground">
        {selectedCount} selected
      </span>
      <div className="ml-auto flex flex-wrap items-center gap-1.5">
        {BAR_ACTIONS.map((action) => (
          <Button
            key={action}
            type="button"
            variant={action === 'stop' ? 'destructive' : 'outline'}
            size="sm"
            disabled={tokenMode}
            aria-disabled={tokenMode || undefined}
            title={tokenMode ? READ_ONLY_TOOLTIP : undefined}
            onClick={() => onAction(action)}
          >
            {BULK_ACTION_VERB[action]}
          </Button>
        ))}
        <Button type="button" variant="ghost" size="sm" onClick={onClear}>
          Clear
        </Button>
      </div>
    </div>
  );
}
