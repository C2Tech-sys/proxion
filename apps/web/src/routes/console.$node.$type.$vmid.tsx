import { createFileRoute, notFound } from '@tanstack/react-router';
import { X } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { StatusDot } from '@/components/StatusDot';
import { Badge } from '@/components/ui/badge';
import { VncConsole } from '@/components/console/VncConsole';
import { Terminal } from '@/components/console/Terminal';
import { useVmStatus } from '@/api/hooks';
import { statusToColor } from '@/lib/status';
import type { GuestType } from '@/api/types';

const STATUS_BADGE_CLASS: Record<ReturnType<typeof statusToColor>, string> = {
  running: 'border-status-running/40 bg-status-running/10 text-status-running',
  stopped: 'border-status-stopped/40 bg-status-stopped/10 text-status-stopped',
  paused: 'border-status-paused/40 bg-status-paused/10 text-status-paused',
  error: 'border-status-error/40 bg-status-error/10 text-status-error',
  template: 'border-status-template/40 bg-status-template/10 text-status-template',
  migrating: 'border-status-migrating/40 bg-status-migrating/10 text-status-migrating',
};

/**
 * Pop-out console window (`window.open(..., 'popup,width=1280,height=800')`), outside the
 * app shell: no top bar, no inventory rail, just this object and a way to close it.
 */
export const Route = createFileRoute('/console/$node/$type/$vmid')({
  beforeLoad: ({ params }) => {
    if (params.type !== 'qemu' && params.type !== 'lxc') {
      throw notFound();
    }
  },
  component: ConsolePopout,
});

function ConsolePopout() {
  const { node, type, vmid } = Route.useParams();
  const guestType = type as GuestType;
  const numericVmid = Number(vmid);
  const { data: status } = useVmStatus(node, guestType, numericVmid);
  const color = statusToColor(status?.status, status?.template === 1);

  return (
    <div className="flex h-svh flex-col bg-background text-foreground">
      <div className="flex shrink-0 items-center gap-2 border-b border-border px-3 py-2">
        <StatusDot status={status?.status} template={status?.template === 1} />
        <h1 className="text-sm font-semibold">{status?.name ?? `VM ${numericVmid}`}</h1>
        <span className="text-xs text-muted-foreground font-numeric">VMID {numericVmid}</span>
        <Badge variant="outline" className={STATUS_BADGE_CLASS[color]}>
          {status?.status ?? 'unknown'}
        </Badge>
        <span className="text-xs text-muted-foreground">on {node}</span>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="ml-auto size-7"
          aria-label="Close"
          onClick={() => window.close()}
        >
          <X className="size-4" />
        </Button>
      </div>
      <div className="min-h-0 flex-1 p-2">
        {guestType === 'qemu' ? (
          <VncConsole node={node} type={guestType} vmid={numericVmid} fill />
        ) : (
          <Terminal node={node} type={guestType} vmid={numericVmid} fill />
        )}
      </div>
    </div>
  );
}
