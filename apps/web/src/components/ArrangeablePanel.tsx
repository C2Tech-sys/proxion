import type { DragEvent, ReactNode } from 'react';
import { ChevronDown, ChevronUp, GripVertical } from 'lucide-react';

import { Panel, type PanelProps } from '@/components/Panel';
import { cn } from '@/lib/utils';

export interface ArrangeablePanelProps extends Omit<PanelProps, 'action' | 'className'> {
  // Redeclared (rather than inherited from `PanelProps`) so an explicit `undefined` -- the
  // 1-column panels' `className={span === 2 ? 'lg:col-span-2' : undefined}` in SummaryTab.tsx --
  // type-checks under `exactOptionalPropertyTypes`.
  className?: string | undefined;
  /** Whether Summary's arrange mode is on. Outside arrange mode this renders exactly like a
   *  plain `Panel` (with `action` passed straight through) -- "nothing changes visually" (T22). */
  arrangeMode: boolean;
  /** The panel's own header action (e.g. Notes' pencil), shown alongside the arrange controls in
   *  arrange mode rather than replaced by them. */
  action?: ReactNode | undefined;
  onMoveUp: () => void;
  onMoveDown: () => void;
  canMoveUp: boolean;
  canMoveDown: boolean;
  onDragStart: (event: DragEvent<HTMLDivElement>) => void;
  onDragOver: (event: DragEvent<HTMLDivElement>) => void;
  onDrop: (event: DragEvent<HTMLDivElement>) => void;
  onDragEnd: () => void;
  isDragging: boolean;
  /** Which edge of this panel the currently-dragged panel would land on, or `null`. */
  dropIndicator: 'before' | 'after' | null;
}

/**
 * Wraps `Panel` with T22's arrange-mode affordances: a drag handle plus keyboard-reachable "Move
 * up"/"Move down" buttons in the header, native HTML5 drag-and-drop on the wrapper, and a small
 * indicator line showing where a dragged panel would land. All of the actual reordering logic
 * (what a drop or a move means for the saved order) lives in the caller (`SummaryTab.tsx`) and
 * `pages/vm/summaryLayout.ts` -- this component only wires up the DOM events and renders state
 * it's given.
 */
export function ArrangeablePanel({
  title,
  className,
  children,
  action,
  arrangeMode,
  onMoveUp,
  onMoveDown,
  canMoveUp,
  canMoveDown,
  onDragStart,
  onDragOver,
  onDrop,
  onDragEnd,
  isDragging,
  dropIndicator,
}: ArrangeablePanelProps) {
  return (
    <div
      className={cn('relative', className)}
      draggable={arrangeMode}
      onDragStart={arrangeMode ? onDragStart : undefined}
      onDragOver={arrangeMode ? onDragOver : undefined}
      onDrop={arrangeMode ? onDrop : undefined}
      onDragEnd={arrangeMode ? onDragEnd : undefined}
      data-arrange-mode={arrangeMode || undefined}
      data-dragging={isDragging || undefined}
    >
      {dropIndicator === 'before' && (
        <div
          aria-hidden="true"
          data-testid={`drop-indicator-before-${title}`}
          className="absolute inset-x-1 -top-[7px] z-10 h-[3px] rounded-full bg-accent"
        />
      )}
      <Panel
        title={title}
        className={cn(isDragging && 'opacity-50')}
        action={
          arrangeMode ? (
            <div className="flex items-center gap-1">
              {action}
              <button
                type="button"
                aria-label={`Move ${title} up`}
                disabled={!canMoveUp}
                onClick={onMoveUp}
                className="rounded-sm p-0.5 text-muted-foreground hover:text-foreground disabled:pointer-events-none disabled:opacity-30"
              >
                <ChevronUp className="size-3.5" />
              </button>
              <button
                type="button"
                aria-label={`Move ${title} down`}
                disabled={!canMoveDown}
                onClick={onMoveDown}
                className="rounded-sm p-0.5 text-muted-foreground hover:text-foreground disabled:pointer-events-none disabled:opacity-30"
              >
                <ChevronDown className="size-3.5" />
              </button>
              <span
                aria-label={`Drag to reorder ${title}`}
                data-testid="drag-handle"
                className="cursor-grab p-0.5 text-muted-foreground hover:text-foreground active:cursor-grabbing"
              >
                <GripVertical className="size-3.5" />
              </span>
            </div>
          ) : (
            action
          )
        }
      >
        {children}
      </Panel>
      {dropIndicator === 'after' && (
        <div
          aria-hidden="true"
          data-testid={`drop-indicator-after-${title}`}
          className="absolute inset-x-1 -bottom-[7px] z-10 h-[3px] rounded-full bg-accent"
        />
      )}
    </div>
  );
}
