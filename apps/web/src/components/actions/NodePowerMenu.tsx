import { useState } from 'react';
import { Power, RotateCcw } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { NodeActionDialog } from '@/components/actions/NodeActionDialog';
import { useAuthMe } from '@/api/hooks';
import { useNodePermissions } from '@/api/actionHooks';
import { USE_FIXTURES } from '@/api/client';
import type { NodeActionCommand } from '@/api/actions';

export interface NodePowerMenuProps {
  node: string;
}

/**
 * The node page header's "Power" dropdown -- Reboot…/Shut down…, each opening `NodeActionDialog`
 * for its own typed-name confirmation. Gated on a signed-in session and the caller's own
 * `Sys.PowerMgmt` on this node (`useNodePermissions`), same disabled-button-with-tooltip pattern
 * `ObjectHeader`'s own quick actions use for the equivalent guest-scoped gate; the server enforces
 * both independently either way. Meant to be passed as `ObjectHeader`'s `extra` prop where a page
 * uses it, or rendered in the analogous header slot otherwise (see `node.$node.tsx`).
 */
export function NodePowerMenu({ node }: NodePowerMenuProps) {
  const auth = useAuthMe();
  const permissions = useNodePermissions(node);
  const [pendingCommand, setPendingCommand] = useState<NodeActionCommand | null>(null);

  // Fixture/demo mode has no real session concept (and nothing real to protect) -- it always
  // demonstrates the enabled state, same convention `ObjectHeader`'s `GuestQuickActions` uses.
  const isSessionMode = USE_FIXTURES || auth.data?.mode === 'session';
  const hasPowerMgmt = permissions.data?.can('Sys.PowerMgmt') === true;
  const enabled = isSessionMode && hasPowerMgmt;
  const disabledReason = !isSessionMode
    ? 'Read-only: signed in with a service token'
    : !hasPowerMgmt
      ? "You don't have Sys.PowerMgmt on this node"
      : undefined;

  return (
    <>
      {enabled ? (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="outline" size="sm" className="gap-1.5 text-xs">
              <Power className="size-3.5" /> Power
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem variant="destructive" onSelect={() => setPendingCommand('reboot')}>
              <RotateCcw /> Reboot…
            </DropdownMenuItem>
            <DropdownMenuItem variant="destructive" onSelect={() => setPendingCommand('shutdown')}>
              <Power /> Shut down…
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      ) : (
        <Tooltip>
          <TooltipTrigger asChild>
            <span tabIndex={0} className="inline-flex rounded-md focus-visible:ring-[3px] focus-visible:ring-ring/50">
              <Button
                variant="outline"
                size="sm"
                disabled
                aria-disabled="true"
                tabIndex={-1}
                // The Tooltip above is the primary UI for this reason (hover/focus on the
                // wrapping span); `title` is a redundant, always-queryable fallback -- same text,
                // so a test (or an assistive setup that reads `title` instead of a hover-only
                // tooltip) never sees a different message from the two.
                title={disabledReason}
                className="pointer-events-none gap-1.5 text-xs"
              >
                <Power className="size-3.5" /> Power
              </Button>
            </span>
          </TooltipTrigger>
          <TooltipContent>{disabledReason}</TooltipContent>
        </Tooltip>
      )}

      <NodeActionDialog
        key={pendingCommand ?? 'none'}
        node={node}
        command={pendingCommand}
        onOpenChange={(open) => {
          if (!open) setPendingCommand(null);
        }}
      />
    </>
  );
}
