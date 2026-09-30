import { Clock } from 'lucide-react';

export interface PendingBannerProps {
  /** The config keys PVE is holding back until the guest restarts (`memory`, `cores`, ...). */
  keys: string[];
}

/**
 * The strip at the top of the Hardware tab while PVE has queued changes waiting for a restart.
 * Renders nothing when there are none; the affected rows carry their own "pending" badge.
 */
export function PendingBanner({ keys }: PendingBannerProps) {
  if (keys.length === 0) return null;
  return (
    <div
      role="status"
      data-testid="hardware-pending-banner"
      className="mb-3 flex items-center gap-2 rounded-lg border border-border bg-card px-3 py-2 text-sm"
    >
      <Clock className="size-4 shrink-0 text-status-paused" aria-hidden="true" />
      <span>Changes pending a restart: {keys.join(', ')}</span>
    </div>
  );
}
