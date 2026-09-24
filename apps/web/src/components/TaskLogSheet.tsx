import { useEffect, useRef } from 'react';
import { Copy } from 'lucide-react';
import { toast } from 'sonner';

import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { EmptyState } from '@/components/EmptyState';
import { useTaskLog } from '@/api/hooks';
import { formatDateTime, formatDuration } from '@/lib/format';
import type { PveTask } from '@/api/types';

export interface TaskLogSheetProps {
  /** The task whose log to show, or `null` to keep the sheet closed. */
  task: PveTask | null;
  onOpenChange: (open: boolean) => void;
}

function taskDuration(task: PveTask): number {
  return (task.endtime ?? Math.floor(Date.now() / 1000)) - task.starttime;
}

/**
 * A right-hand Sheet showing one task's captured log (`/nodes/{node}/tasks/{upid}/log`) in a
 * monospace, auto-scrolling, copyable pane. Shared by the node/VM Tasks tabs and `/tasks`.
 */
export function TaskLogSheet({ task, onOpenChange }: TaskLogSheetProps) {
  const { data: lines, isLoading } = useTaskLog(task?.node ?? '', task?.upid ?? '');
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [lines]);

  function copyLog() {
    const text = (lines ?? []).map((l) => l.t).join('\n');
    navigator.clipboard
      ?.writeText(text)
      .then(() => toast.success('Copied task log'))
      .catch(() => toast.error('Could not copy task log'));
  }

  return (
    <Sheet open={task !== null} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-full sm:max-w-2xl">
        <SheetHeader>
          {/* The UPID is an identifier but not aligned in a column -- sans, per T11 (mono is
              reserved for the log body below, where alignment is functional). */}
          <SheetTitle>{task?.upid ?? ''}</SheetTitle>
          {task && (
            <SheetDescription>
              {task.type} on {task.node} &middot; started {formatDateTime(task.starttime)} &middot;{' '}
              {task.endtime ? formatDuration(taskDuration(task)) : 'running'} &middot; {task.status ?? 'running'}
            </SheetDescription>
          )}
        </SheetHeader>

        <div className="flex items-center justify-end gap-2 px-4">
          <Button variant="outline" size="sm" onClick={copyLog} disabled={!lines || lines.length === 0}>
            <Copy className="size-3.5" />
            Copy
          </Button>
        </div>

        <div
          ref={scrollRef}
          className="mx-4 mb-4 min-h-0 flex-1 overflow-auto rounded-md border border-border bg-background p-3"
        >
          {isLoading ? (
            <Skeleton className="h-40" />
          ) : !lines || lines.length === 0 ? (
            <EmptyState message="No log captured for this task." />
          ) : (
            <pre className="font-mono text-[12px] leading-relaxed whitespace-pre-wrap text-foreground">
              {lines.map((line) => (
                <div key={line.n} className="flex gap-3">
                  <span className="shrink-0 select-none text-muted-foreground">{String(line.n).padStart(4, ' ')}</span>
                  <span className="min-w-0 break-all">{line.t}</span>
                </div>
              ))}
            </pre>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}
