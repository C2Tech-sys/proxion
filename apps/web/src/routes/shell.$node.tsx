import { createFileRoute } from '@tanstack/react-router';
import { X } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { StatusDot } from '@/components/StatusDot';
import { Terminal } from '@/components/console/Terminal';
import { useNodeStatus } from '@/api/hooks';

/**
 * Pop-out node shell window (`window.open(..., 'popup,width=1280,height=800')`), outside
 * the app shell: no top bar, no inventory rail, just this node and a way to close it.
 */
export const Route = createFileRoute('/shell/$node')({
  component: ShellPopout,
});

function ShellPopout() {
  const { node } = Route.useParams();
  const { data: status } = useNodeStatus(node);

  return (
    <div className="flex h-svh flex-col bg-background text-foreground">
      <div className="flex shrink-0 items-center gap-2 border-b border-border px-3 py-2">
        <StatusDot status={status ? 'online' : undefined} />
        <h1 className="text-sm font-semibold">{node}</h1>
        <span className="text-xs text-muted-foreground">Node shell</span>
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
        <Terminal node={node} fill />
      </div>
    </div>
  );
}
