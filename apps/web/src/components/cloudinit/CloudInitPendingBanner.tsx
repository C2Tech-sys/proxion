import { Clock } from 'lucide-react';

export interface CloudInitPendingBannerProps {
  /** The cloud-init config keys PVE is holding back until the image is regenerated. */
  keys: string[];
}

/**
 * The strip at the top of the Cloud-Init tab while PVE has cloud-init changes waiting for the
 * image to be regenerated. Renders nothing when there are none; the affected rows carry their own
 * "pending" badge.
 */
export function CloudInitPendingBanner({ keys }: CloudInitPendingBannerProps) {
  if (keys.length === 0) return null;
  return (
    <div
      role="status"
      data-testid="cloudinit-pending-banner"
      className="mb-3 flex items-center gap-2 rounded-lg border border-border bg-card px-3 py-2 text-sm"
    >
      <Clock className="size-4 shrink-0 text-status-paused" aria-hidden="true" />
      <span>Changes pending, regenerate the image to apply them: {keys.join(', ')}</span>
    </div>
  );
}
