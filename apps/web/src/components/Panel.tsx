import type { ReactNode } from 'react';

import { cn } from '@/lib/utils';

export interface PanelProps {
  title: string;
  action?: ReactNode;
  className?: string;
  children: ReactNode;
}

/** A titled card used to build the Summary tab's panel grid. Flat, no nested shadows. */
export function Panel({ title, action, className, children }: PanelProps) {
  return (
    <section
      data-slot="panel"
      className={cn('flex flex-col rounded-lg border border-border bg-card', className)}
    >
      <header className="flex items-center justify-between border-b border-border px-3 py-2">
        <h3 className="text-xs font-medium tracking-[0.08em] text-muted-foreground uppercase">{title}</h3>
        {action}
      </header>
      {/* `data-slot="panel-body"` -- a hook for index.css's `[data-density='compact']` rule
          (see Preferences); purely additive, no visual/behavioral change on its own. */}
      <div data-slot="panel-body" className="flex-1 p-3">
        {children}
      </div>
    </section>
  );
}
