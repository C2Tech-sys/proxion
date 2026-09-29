import { useEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
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
import { useUploadStore, findActiveUpload, type UploadEntry } from '@/store/uploadStore';
import type { StorageUploadContent } from '@/api/actions';
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
 * stays editable (validated the same way the server does). The upload itself is tracked app-wide
 * in `useUploadStore` (T39), not in local state, so it survives this dialog unmounting (a shell
 * remount, closing the dialog) -- this component only holds *which* tracked upload (if any) it is
 * currently showing, by id.
 *
 * The dialog refuses to close (overlay click, Escape, the header's own X) while its own upload is
 * `uploading` -- the only ways out mid-upload are Cancel (aborts it) and "Continue in background"
 * (leaves it running and closes anyway; `UploadsIndicator` in `StorageActions` picks it up). Once
 * the upload reaches `processing` (the server answered 202) the dialog closes itself, the same
 * point the old local-state version did.
 *
 * If this component (re)mounts while an upload for this exact node/storage is already `uploading`
 * -- e.g. the shell remounted it, or `StorageActions`'s whole tree did -- it reattaches to that
 * upload on its very first render instead of starting blank, so a remount never loses track of
 * progress the user can already see reflected in `UploadsIndicator`.
 */
export function UploadDialog({ node, storage, availableContentTypes, open, onOpenChange }: UploadDialogProps) {
  // Passed explicitly to `start()` below rather than relying solely on the module-level client
  // `initUploadStore` (`main.tsx`) sets -- this is the one every render test's own
  // `QueryClientProvider` actually provides, so tests never need to call `initUploadStore`
  // themselves; `start()` still falls back to the injected one for any caller outside a React tree.
  const queryClient = useQueryClient();
  // Looked up once, on this component's very first render, so a fresh mount that lands while an
  // upload for this exact node/storage is already `uploading` (a shell remount, `StorageActions`'s
  // whole tree remounting) reattaches to it immediately -- `uploadId`, `filename` and `content` all
  // seed from the same lookup so the form reflects that upload from the start, not one render late.
  // (`file` itself can't be reconstructed this way -- see the `pending` file-row rendering below,
  // which shows the entry's own filename/size instead of relying on a local `File` object.)
  const [reattached] = useState(() => findActiveUpload(useUploadStore.getState().uploads, node, storage));
  const [content, setContent] = useState<StorageUploadContent>(reattached?.content ?? (availableContentTypes[0] ?? 'iso'));
  const [file, setFile] = useState<File | null>(null);
  const [filename, setFilename] = useState(reattached?.filename ?? '');
  const [uploadId, setUploadId] = useState<string | null>(reattached?.id ?? null);

  const entry = useUploadStore((s): UploadEntry | undefined => (uploadId ? s.uploads[uploadId] : undefined));
  const pending = entry?.status === 'uploading';

  // Once the server has answered 202 (T39: "processing" means it has a upid and is just waiting on
  // the PVE task now), this dialog's job is done -- it closes itself the same as the old
  // `onSettled`'s success branch did, leaving the entry tracked in the store either way.
  useEffect(() => {
    if (entry?.status === 'processing') {
      onOpenChange(false);
      resetLocal();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entry?.status]);

  // Re-validated whenever `content` changes too (this is a plain function of both, not memoized
  // state) -- if the content type changes and the current filename no longer fits (e.g. an ISO
  // filename after switching to "Import"), the error shows immediately rather than the filename
  // being silently edited or the mismatch only surfacing once PVE rejects it (T34).
  const filenameError = filename.length > 0 ? validateStorageFilename(content, filename) : null;
  const filenameValid = filenameError === null;
  const canSubmit = file !== null && filename.length > 0 && filenameValid && !pending;

  function resetLocal() {
    setFile(null);
    setFilename('');
    setUploadId(null);
  }

  function handleFileChange(selected: File | null) {
    setFile(selected);
    if (selected) setFilename(selected.name);
  }

  function handleCancel() {
    if (uploadId) useUploadStore.getState().cancel(uploadId);
    resetLocal();
    onOpenChange(false);
  }

  /** Closes the dialog without touching the tracked upload -- it keeps running, and
   * `UploadsIndicator` (rendered alongside this dialog in `StorageActions`) shows its progress. */
  function handleContinueInBackground() {
    onOpenChange(false);
  }

  function handleSubmit() {
    if (!file || !canSubmit) return;
    const id = useUploadStore.getState().start({ node, storage, content, filename, file }, queryClient);
    setUploadId(id);
  }

  const sent = entry?.sent ?? 0;
  const total = entry?.total ?? file?.size ?? 0;
  const percent = total > 0 ? Math.min(100, Math.round((sent / total) * 100)) : 0;

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        // Refuses to close (overlay click, Escape, the header X) while uploading -- Cancel and
        // "Continue in background" are the only ways out mid-upload (see their own handlers above).
        if (!next && pending) return;
        if (!next) resetLocal();
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
              disabled={pending}
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
              disabled={pending}
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
              disabled={pending}
              aria-invalid={!filenameValid}
            />
            {filenameError && <span className="text-xs text-destructive">{filenameError}</span>}
          </div>

          {pending && (
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
                {percent}% &middot; {formatBytes(sent)} / {formatBytes(total)}
              </span>
            </div>
          )}
        </div>

        <DialogFooter>
          {pending && (
            <Button variant="outline" onClick={handleContinueInBackground}>
              Continue in background
            </Button>
          )}
          <Button variant="outline" onClick={handleCancel}>
            Cancel
          </Button>
          <Button onClick={handleSubmit} disabled={!canSubmit}>
            {pending && <Loader2 className="size-4 animate-spin" />}
            Upload
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
