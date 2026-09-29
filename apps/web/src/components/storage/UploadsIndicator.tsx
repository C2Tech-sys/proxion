import { X } from 'lucide-react';
import { useShallow } from 'zustand/react/shallow';

import { Button } from '@/components/ui/button';
import { useUploadStore, selectUploadsFor, type UploadEntry } from '@/store/uploadStore';
import { formatBytes } from '@/lib/format';
import { cn } from '@/lib/utils';

export interface UploadsIndicatorProps {
  node: string;
  storage: string;
}

function statusText(entry: UploadEntry, percent: number): string {
  switch (entry.status) {
    case 'uploading':
      return `Uploading ${entry.filename} · ${percent}%`;
    case 'processing':
      return `Processing ${entry.filename}`;
    case 'error':
      return entry.error ?? `${entry.filename} could not be uploaded.`;
    case 'done':
      return `${entry.filename} is ready`;
  }
}

/**
 * One compact chip per tracked upload for this node/storage (T39), newest first, rendered in
 * `StorageActions` next to the Upload/Download-from-URL buttons so an upload stays visible even
 * after its `UploadDialog` has closed ("Continue in background") or been unmounted entirely (a
 * shell remount, navigating away and back). Only `uploading`/`processing`/`error` uploads show a
 * row here by default; a `done` one is included too for the few seconds before its own
 * auto-removal (`UPLOAD_AUTO_REMOVE_MS` in `uploadStore.ts`) so the "<filename> is ready" state is
 * actually visible, not just the toast that already fired once.
 */
export function UploadsIndicator({ node, storage }: UploadsIndicatorProps) {
  // `selectUploadsFor` builds a fresh array every call -- `useShallow` compares its elements
  // (stable `UploadEntry` references, only ever replaced wholesale by a `patch()` in the store)
  // instead of the array's own identity, so this only re-renders when an entry actually changes,
  // not on every store update for some *other* node/storage (and never loops: without it, a new
  // array each render trips React's "getSnapshot should be cached" infinite-update guard).
  const uploads = useUploadStore(useShallow((s) => selectUploadsFor(s.uploads, node, storage)));
  const cancel = useUploadStore((s) => s.cancel);
  const dismiss = useUploadStore((s) => s.dismiss);

  if (uploads.length === 0) return null;

  return (
    // `w-full min-w-0`: this sits in `StorageActions`'s own `flex flex-wrap` row alongside the
    // Upload/Download buttons -- without these, a flex item's default `min-width: auto` keeps it
    // (and the `truncate` below) from ever shrinking below its content's intrinsic width, so on a
    // narrow viewport it would push the row wider instead of wrapping onto its own line.
    <div className="flex w-full min-w-0 flex-col gap-1">
      {uploads.map((entry) => {
        const percent = entry.total > 0 ? Math.min(100, Math.round((entry.sent / entry.total) * 100)) : 0;
        const isError = entry.status === 'error';
        return (
          <div
            key={entry.id}
            className={cn(
              'flex min-w-0 items-center gap-2 rounded-md border border-border bg-secondary/50 px-2 py-1 text-xs',
              isError && 'border-destructive/50 text-destructive',
            )}
          >
            <div className="flex min-w-0 flex-1 flex-col gap-1">
              <span className="truncate">{statusText(entry, percent)}</span>
              {(entry.status === 'uploading' || entry.status === 'processing') && (
                <div className="h-1 w-full max-w-40 overflow-hidden rounded-full bg-muted">
                  <div
                    className="h-full rounded-full bg-accent transition-[width]"
                    style={{ width: entry.status === 'processing' ? '100%' : `${percent}%` }}
                    role="progressbar"
                    aria-valuenow={entry.status === 'processing' ? 100 : percent}
                    aria-valuemin={0}
                    aria-valuemax={100}
                  />
                </div>
              )}
              {entry.status === 'uploading' && (
                <span className="text-[10px] text-muted-foreground">
                  {formatBytes(entry.sent)} / {formatBytes(entry.total)}
                </span>
              )}
            </div>
            {entry.status === 'uploading' && (
              <Button
                variant="ghost"
                size="sm"
                className="h-6 px-2 text-xs"
                aria-label={`Cancel upload of ${entry.filename}`}
                onClick={() => cancel(entry.id)}
              >
                Cancel
              </Button>
            )}
            <Button
              variant="ghost"
              size="icon"
              className="size-6 shrink-0"
              aria-label={`Dismiss ${entry.filename}`}
              onClick={() => dismiss(entry.id)}
            >
              <X className="size-3.5" />
            </Button>
          </div>
        );
      })}
    </div>
  );
}
