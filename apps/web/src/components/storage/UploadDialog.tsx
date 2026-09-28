import { useRef, useState } from 'react';
import { Loader2 } from 'lucide-react';

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { useStorageUpload } from '@/api/actionHooks';
import { GuestActionError, type StorageUploadContent } from '@/api/actions';
import { validateStorageFilename } from '@/lib/storageFilename';
import { formatBytes } from '@/lib/format';
import { cn } from '@/lib/utils';

const CONTENT_LABELS: Record<StorageUploadContent, string> = {
  iso: 'ISO image',
  vztmpl: 'CT template',
  import: 'Import',
};

const CONTENT_ACCEPT: Record<StorageUploadContent, string> = {
  iso: '.iso,.img',
  vztmpl: '.tar.gz,.tar.xz,.tar.zst,.tgz',
  import: '.ova,.ovf,.qcow2,.vmdk,.raw',
};

export interface UploadDialogProps {
  node: string;
  storage: string;
  /** The content types this storage supports (its cluster-resources `content` row, filtered to
   * the ones this dialog can upload) -- the type select only ever offers these. */
  availableContentTypes: StorageUploadContent[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/**
 * Upload an ISO / container template / import file from the browser onto a storage (T32). Content
 * type is limited to what this storage supports; the filename auto-fills from the chosen file and
 * stays editable (validated the same way the server does); a progress bar tracks
 * `XMLHttpRequest`'s own upload progress (`useStorageUpload`'s `onProgress`); Cancel aborts via an
 * `AbortController`. The dialog refuses to close (overlay click, Escape, the header's own X) while
 * an upload is in flight -- only Cancel (which itself aborts first) or a settled
 * success/error can close it.
 */
export function UploadDialog({ node, storage, availableContentTypes, open, onOpenChange }: UploadDialogProps) {
  const [content, setContent] = useState<StorageUploadContent>(availableContentTypes[0] ?? 'iso');
  const [file, setFile] = useState<File | null>(null);
  const [filename, setFilename] = useState('');
  const [progress, setProgress] = useState<{ sent: number; total: number } | null>(null);
  const abortControllerRef = useRef<AbortController | null>(null);
  const mutation = useStorageUpload();

  // Re-validated whenever `content` changes too (this is a plain function of both, not memoized
  // state) -- if the content type changes and the current filename no longer fits (e.g. an ISO
  // filename after switching to "Import"), the error shows immediately rather than the filename
  // being silently edited or the mismatch only surfacing once PVE rejects it (T34).
  const filenameError = filename.length > 0 ? validateStorageFilename(content, filename) : null;
  const filenameValid = filenameError === null;
  const canSubmit = file !== null && filename.length > 0 && filenameValid && !mutation.isPending;

  function reset() {
    setFile(null);
    setFilename('');
    setProgress(null);
    mutation.reset();
  }

  function handleFileChange(selected: File | null) {
    setFile(selected);
    if (selected) setFilename(selected.name);
  }

  function handleCancel() {
    abortControllerRef.current?.abort();
  }

  function handleSubmit() {
    if (!file || !canSubmit) return;
    const controller = new AbortController();
    abortControllerRef.current = controller;
    setProgress({ sent: 0, total: file.size });

    mutation.mutate(
      {
        node,
        storage,
        file,
        content,
        filename,
        onProgress: (sent, total) => setProgress({ sent, total }),
        signal: controller.signal,
      },
      {
        onSettled: (_result, error) => {
          abortControllerRef.current = null;
          // A cancelled upload (the user's own Cancel button) closes the dialog quietly, same as
          // any other settled outcome -- the toast for a real failure (not a cancel) already
          // came from `useStorageUpload`'s own `onError`.
          if (!error || (error instanceof GuestActionError && error.message === 'Upload cancelled')) {
            reset();
            onOpenChange(false);
            return;
          }
          setProgress(null);
        },
      },
    );
  }

  const percent = progress && progress.total > 0 ? Math.min(100, Math.round((progress.sent / progress.total) * 100)) : 0;

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        // Refuses to close (overlay click, Escape, the header X) while uploading -- Cancel is the
        // only way out mid-upload, and it aborts first (see `handleCancel`/`onSettled` above).
        if (!next && mutation.isPending) return;
        if (!next) reset();
        onOpenChange(next);
      }}
    >
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Upload to {storage}</DialogTitle>
          <DialogDescription>Upload an ISO image, container template, or import file from your browser.</DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-4">
          <div className="flex flex-col gap-1.5">
            <label className="text-sm text-muted-foreground" htmlFor="upload-content-type">
              Content type
            </label>
            <Select
              value={content}
              onValueChange={(value) => setContent(value as StorageUploadContent)}
              disabled={mutation.isPending}
            >
              <SelectTrigger id="upload-content-type" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {availableContentTypes.map((type) => (
                  <SelectItem key={type} value={type}>
                    {CONTENT_LABELS[type]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="flex flex-col gap-1.5">
            <label className="text-sm text-muted-foreground" htmlFor="upload-file">
              File
            </label>
            <input
              id="upload-file"
              type="file"
              accept={CONTENT_ACCEPT[content]}
              disabled={mutation.isPending}
              onChange={(e) => handleFileChange(e.target.files?.[0] ?? null)}
              className="text-sm file:mr-3 file:rounded-md file:border file:border-border file:bg-secondary file:px-2.5 file:py-1.5 file:text-xs file:font-medium disabled:opacity-50"
            />
            {file && <span className="text-xs text-muted-foreground">{formatBytes(file.size)}</span>}
          </div>

          <div className="flex flex-col gap-1.5">
            <label className="text-sm text-muted-foreground" htmlFor="upload-filename">
              Filename
            </label>
            <Input
              id="upload-filename"
              value={filename}
              onChange={(e) => setFilename(e.target.value)}
              disabled={mutation.isPending}
              aria-invalid={!filenameValid}
            />
            {filenameError && <span className="text-xs text-destructive">{filenameError}</span>}
          </div>

          {progress && (
            <div className="flex flex-col gap-1">
              <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
                <div
                  className={cn('h-full rounded-full bg-accent transition-[width]')}
                  style={{ width: `${percent}%` }}
                  role="progressbar"
                  aria-valuenow={percent}
                  aria-valuemin={0}
                  aria-valuemax={100}
                />
              </div>
              <span className="text-xs text-muted-foreground">
                {percent}% &middot; {formatBytes(progress.sent)} / {formatBytes(progress.total)}
              </span>
            </div>
          )}
        </div>

        <DialogFooter>
          {mutation.isPending ? (
            <Button variant="outline" onClick={handleCancel}>
              Cancel
            </Button>
          ) : (
            <Button
              variant="outline"
              onClick={() => {
                reset();
                onOpenChange(false);
              }}
            >
              Cancel
            </Button>
          )}
          <Button onClick={handleSubmit} disabled={!canSubmit}>
            {mutation.isPending && <Loader2 className="size-4 animate-spin" />}
            Upload
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
