import { useState, type ReactNode } from 'react';

import { VncConsole } from '@/components/console/VncConsole';
import { Terminal } from '@/components/console/Terminal';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import type { VmTabProps } from '@/pages/vm/tabs';

type LxcConsoleMode = 'terminal' | 'vnc';

/**
 * VM/CT console tab: a QEMU guest only speaks VNC, so it always gets the embedded noVNC
 * console. An LXC container has a real serial console *and* a container shell, so it opens
 * to the shell (the common case) with a segmented control to switch to its VNC console.
 */
export function ConsoleTab({ node, type, vmid }: VmTabProps) {
  const [lxcMode, setLxcMode] = useState<LxcConsoleMode>('terminal');

  if (type === 'qemu') {
    return <VncConsole node={node} type={type} vmid={vmid} />;
  }

  return (
    // `h-full flex-col`, with the segmented control at its natural height and the console
    // wrapper taking `min-h-0 flex-1`, so Terminal/VncConsole's own `h-full` (see
    // console/layout.ts) resolves against a definite height instead of the extra wrapper
    // this LXC branch adds between it and the (already height-chained) tab body.
    <div className="flex h-full flex-col gap-2">
      <div className="inline-flex w-fit items-center gap-0.5 rounded-md border border-border p-0.5">
        <SegmentButton active={lxcMode === 'terminal'} onClick={() => setLxcMode('terminal')}>
          Shell
        </SegmentButton>
        <SegmentButton active={lxcMode === 'vnc'} onClick={() => setLxcMode('vnc')}>
          VNC
        </SegmentButton>
      </div>
      <div className="min-h-0 flex-1">
        {lxcMode === 'terminal' ? (
          <Terminal node={node} type={type} vmid={vmid} />
        ) : (
          <VncConsole node={node} type={type} vmid={vmid} />
        )}
      </div>
    </div>
  );
}

function SegmentButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <Button
      type="button"
      size="sm"
      variant="ghost"
      onClick={onClick}
      aria-pressed={active}
      className={cn('h-7 px-3', active && 'bg-secondary text-secondary-foreground')}
    >
      {children}
    </Button>
  );
}
