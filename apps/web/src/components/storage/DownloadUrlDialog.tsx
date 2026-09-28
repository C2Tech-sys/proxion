import { useState } from 'react';
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
import { Checkbox } from '@/components/ui/checkbox';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { useStorageDownloadUrl } from '@/api/actionHooks';
import { queryUrlMetadata, GuestActionError, type StorageUploadContent } from '@/api/actions';
import { formatBytes } from '@/lib/format';

/** Same regex/rejection the server enforces (`storageRoutes.ts`'s `filenameSchema`) -- see
 * `UploadDialog.tsx`'s identical copy for why this lives inline rather than shared. */
const FILENAME_RE = /^[A-Za-z0-9][A-Za-z0-9_.+-]{0,254}$/;
function isValidFilename(value: string): boolean {
  return value.length > 0 && value.length <= 255 && FILENAME_RE.test(value) && !value.includes('..');
}

/** Same http(s)-only rule the server enforces (`storageRoutes.ts`'s `urlSchema`). */
function isValidUrl(value: string): boolean {
  if (value.length === 0 || value.length > 2048) return false;
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

const CONTENT_LABELS: Record<StorageUploadContent, string> = {
  iso: 'ISO image',
  vztmpl: 'CT template',
  import: 'Import',
};

type ChecksumAlgorithm = 'md5' | 'sha1' | 'sha224' | 'sha256' | 'sha384' | 'sha512';
const CHECKSUM_ALGORITHMS: ChecksumAlgorithm[] = ['md5', 'sha1', 'sha224', 'sha256', 'sha384', 'sha512'];

export interface DownloadUrlDialogProps {
  node: string;
  storage: string;
  availableContentTypes: StorageUploadContent[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/**
 * "Download from URL" onto a storage (T32) -- Proxmox itself fetches the URL; there is no
 * client-side download here (see the server README's "Storage browser" section). "Query URL" asks
 * PVE for the remote file's metadata (filename/size) without downloading it, to pre-fill the
 * filename field; the checksum fields are optional but travel together (both or neither).
 */
export function DownloadUrlDialog({ node, storage, availableContentTypes, open, onOpenChange }: DownloadUrlDialogProps) {
  const [url, setUrl] = useState('');
  const [content, setContent] = useState<StorageUploadContent>(availableContentTypes[0] ?? 'iso');
  const [filename, setFilename] = useState('');
  const [size, setSize] = useState<number | undefined>(undefined);
  const [checksum, setChecksum] = useState('');
  const [checksumAlgorithm, setChecksumAlgorithm] = useState<ChecksumAlgorithm | ''>('');
  const [verifyCertificates, setVerifyCertificates] = useState(true);
  const [querying, setQuerying] = useState(false);
  const [queryError, setQueryError] = useState<string | undefined>(undefined);
  const mutation = useStorageDownloadUrl();

  const urlValid = isValidUrl(url);
  const filenameValid = filename.length === 0 || isValidFilename(filename);
  const checksumPairValid = (checksum.length === 0) === (checksumAlgorithm === '');
  const canSubmit = urlValid && filename.length > 0 && filenameValid && checksumPairValid && !mutation.isPending;

  function reset() {
    setUrl('');
    setFilename('');
    setSize(undefined);
    setChecksum('');
    setChecksumAlgorithm('');
    setVerifyCertificates(true);
    setQueryError(undefined);
    mutation.reset();
  }

  async function handleQuery() {
    if (!urlValid) return;
    setQuerying(true);
    setQueryError(undefined);
    try {
      const result = await queryUrlMetadata(node, url, verifyCertificates);
      if (result.filename) setFilename(result.filename);
      setSize(result.size);
    } catch (error) {
      setQueryError(error instanceof GuestActionError ? error.message : 'Could not query the URL.');
    } finally {
      setQuerying(false);
    }
  }

  function handleSubmit() {
    if (!canSubmit) return;
    mutation.mutate(
      {
        node,
        storage,
        body: {
          url,
          content,
          filename,
          ...(checksum && checksumAlgorithm ? { checksum, checksumAlgorithm } : {}),
          verifyCertificates,
        },
      },
      {
        onSuccess: () => {
          reset();
          onOpenChange(false);
        },
      },
    );
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) reset();
        onOpenChange(next);
      }}
    >
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Download from URL to {storage}</DialogTitle>
          <DialogDescription>Proxmox VE fetches the URL directly onto this storage.</DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-4">
          <div className="flex flex-col gap-1.5">
            <label className="text-sm text-muted-foreground" htmlFor="download-url">
              URL
            </label>
            <div className="flex gap-2">
              <Input
                id="download-url"
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                placeholder="https://example.com/debian.iso"
                disabled={mutation.isPending}
              />
              <Button type="button" variant="outline" onClick={handleQuery} disabled={!urlValid || querying || mutation.isPending}>
                {querying && <Loader2 className="size-4 animate-spin" />}
                Query URL
              </Button>
            </div>
            {queryError && <span className="text-xs text-destructive">{queryError}</span>}
            {size !== undefined && <span className="text-xs text-muted-foreground">{formatBytes(size)}</span>}
          </div>

          <div className="flex flex-col gap-1.5">
            <label className="text-sm text-muted-foreground" htmlFor="download-content-type">
              Content type
            </label>
            <Select
              value={content}
              onValueChange={(value) => setContent(value as StorageUploadContent)}
              disabled={mutation.isPending}
            >
              <SelectTrigger id="download-content-type" className="w-full">
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
            <label className="text-sm text-muted-foreground" htmlFor="download-filename">
              Filename
            </label>
            <Input
              id="download-filename"
              value={filename}
              onChange={(e) => setFilename(e.target.value)}
              disabled={mutation.isPending}
              aria-invalid={!filenameValid}
            />
            {!filenameValid && <span className="text-xs text-destructive">Invalid filename.</span>}
          </div>

          <div className="grid grid-cols-2 gap-2">
            <div className="flex flex-col gap-1.5">
              <label className="text-sm text-muted-foreground" htmlFor="download-checksum">
                Checksum (optional)
              </label>
              <Input
                id="download-checksum"
                value={checksum}
                onChange={(e) => setChecksum(e.target.value)}
                disabled={mutation.isPending}
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <label className="text-sm text-muted-foreground" htmlFor="download-checksum-algorithm">
                Algorithm
              </label>
              <Select
                {...(checksumAlgorithm ? { value: checksumAlgorithm } : {})}
                onValueChange={(value) => setChecksumAlgorithm(value as ChecksumAlgorithm)}
                disabled={mutation.isPending}
              >
                <SelectTrigger id="download-checksum-algorithm" className="w-full">
                  <SelectValue placeholder="None" />
                </SelectTrigger>
                <SelectContent>
                  {CHECKSUM_ALGORITHMS.map((algo) => (
                    <SelectItem key={algo} value={algo}>
                      {algo}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          {!checksumPairValid && (
            <span className="text-xs text-destructive">Checksum and algorithm must both be set, or both left empty.</span>
          )}

          <label className="flex items-center gap-2 text-sm">
            <Checkbox
              checked={verifyCertificates}
              onCheckedChange={(checked) => setVerifyCertificates(checked === true)}
              disabled={mutation.isPending}
            />
            Verify certificates
          </label>
        </div>

        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => {
              reset();
              onOpenChange(false);
            }}
            disabled={mutation.isPending}
          >
            Cancel
          </Button>
          <Button onClick={handleSubmit} disabled={!canSubmit}>
            {mutation.isPending && <Loader2 className="size-4 animate-spin" />}
            Start download
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
