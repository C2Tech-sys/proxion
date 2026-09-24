import { Loader2 } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';

export type ConsoleConnectionStatus = 'connecting' | 'connected' | 'disconnected';

const STATUS_LABEL: Record<ConsoleConnectionStatus, string> = {
  connecting: 'Connecting…',
  connected: 'Connected',
  disconnected: 'Disconnected',
};

const STATUS_CLASS: Record<ConsoleConnectionStatus, string> = {
  connecting: 'border-status-migrating/40 bg-status-migrating/10 text-status-migrating',
  connected: 'border-status-running/40 bg-status-running/10 text-status-running',
  disconnected: 'border-status-stopped/40 bg-status-stopped/10 text-status-stopped',
};

export interface ConsoleStatusPillProps {
  status: ConsoleConnectionStatus;
  /** Extra detail shown next to the status, e.g. a disconnect reason or "Fixture mode". */
  reason?: string | undefined;
}

/** Small status badge for a console/terminal toolbar: connecting / connected / disconnected + reason. */
export function ConsoleStatusPill({ status, reason }: ConsoleStatusPillProps) {
  return (
    <Badge variant="outline" className={cn('gap-1.5 font-normal', STATUS_CLASS[status])}>
      {status === 'connecting' && <Loader2 className="animate-spin" />}
      <span>{STATUS_LABEL[status]}</span>
      {reason && <span className="text-muted-foreground">— {reason}</span>}
    </Badge>
  );
}
