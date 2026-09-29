import { useState, type ReactNode } from 'react';
import { CloudDownload, Upload } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { UploadDialog } from '@/components/storage/UploadDialog';
import { UploadsIndicator } from '@/components/storage/UploadsIndicator';
import { DownloadUrlDialog } from '@/components/storage/DownloadUrlDialog';
import { useAuthMe } from '@/api/hooks';
import { useStoragePermissions } from '@/api/actionHooks';
import { USE_FIXTURES } from '@/api/client';
import type { StorageUploadContent } from '@/api/actions';

const UPLOAD_CONTENT_TYPES: StorageUploadContent[] = ['iso', 'vztmpl', 'import'];

export interface StorageActionsProps {
  node: string;
  storage: string;
  /** The storage's own `content` types (its cluster-resources row, comma-separated and already
   * split) -- Upload/Download-from-URL only ever show up when at least one of `iso`/`vztmpl`/
   * `import` is among them. */
  contentTypes: string[];
}

interface GatedButtonProps {
  enabled: boolean;
  disabledReason: string | undefined;
  onClick: () => void;
  icon: ReactNode;
  label: string;
}

/** One header action button, gated the same disabled-button-with-tooltip way `NodePowerMenu` gates
 * its own Power dropdown -- kept local since both Upload and Download-from-URL share the exact
 * same gate (`Datastore.AllocateTemplate` on this storage). */
function GatedButton({ enabled, disabledReason, onClick, icon, label }: GatedButtonProps) {
  if (enabled) {
    return (
      <Button variant="outline" size="sm" className="gap-1.5 text-xs" onClick={onClick}>
        {icon} {label}
      </Button>
    );
  }

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span tabIndex={0} className="inline-flex rounded-md focus-visible:ring-[3px] focus-visible:ring-ring/50">
          <Button
            variant="outline"
            size="sm"
            disabled
            aria-disabled="true"
            tabIndex={-1}
            // Same redundant-but-always-queryable `title` convention `NodePowerMenu` uses: the
            // Tooltip is the primary UI (hover/focus on the wrapping span), `title` is the
            // fallback so a test (or an assistive setup reading `title` instead of a hover-only
            // tooltip) never sees a different message.
            title={disabledReason}
            className="pointer-events-none gap-1.5 text-xs"
          >
            {icon} {label}
          </Button>
        </span>
      </TooltipTrigger>
      <TooltipContent>{disabledReason}</TooltipContent>
    </Tooltip>
  );
}

/**
 * The storage page header's Upload / Download-from-URL actions (T32). Hidden entirely when this
 * storage supports none of `iso`/`vztmpl`/`import`; otherwise gated on a signed-in session and the
 * caller's own `Datastore.AllocateTemplate` on this storage (`useStoragePermissions`), same
 * disabled-button-with-tooltip pattern `NodePowerMenu` uses for its own node-scoped gate -- the
 * server enforces both independently either way. Also renders `UploadsIndicator` (T39), which
 * shows any upload tracked in `useUploadStore` for this node/storage regardless of gating -- an
 * upload already in flight keeps running (and stays visible) even if the caller's privileges
 * change mid-upload.
 */
export function StorageActions({ node, storage, contentTypes }: StorageActionsProps) {
  const auth = useAuthMe();
  const permissions = useStoragePermissions(storage);
  const [uploadOpen, setUploadOpen] = useState(false);
  const [downloadOpen, setDownloadOpen] = useState(false);

  const availableContentTypes = UPLOAD_CONTENT_TYPES.filter((type) => contentTypes.includes(type));
  if (availableContentTypes.length === 0) return null;

  // Fixture/demo mode has no real session concept (and nothing real to protect) -- it always
  // demonstrates the enabled state, same convention `ObjectHeader`'s quick actions and
  // `NodePowerMenu` use.
  const isSessionMode = USE_FIXTURES || auth.data?.mode === 'session';
  const hasPrivilege = permissions.data?.can('Datastore.AllocateTemplate') === true;
  const enabled = isSessionMode && hasPrivilege;
  const disabledReason = !isSessionMode
    ? 'Read-only: signed in with a service token'
    : !hasPrivilege
      ? "You don't have Datastore.AllocateTemplate on this storage"
      : undefined;

  return (
    <div className="flex flex-wrap items-center gap-2">
      <GatedButton
        enabled={enabled}
        disabledReason={disabledReason}
        onClick={() => setUploadOpen(true)}
        icon={<Upload className="size-3.5" />}
        label="Upload"
      />
      <GatedButton
        enabled={enabled}
        disabledReason={disabledReason}
        onClick={() => setDownloadOpen(true)}
        icon={<CloudDownload className="size-3.5" />}
        label="Download from URL"
      />

      <UploadsIndicator node={node} storage={storage} />

      <UploadDialog
        node={node}
        storage={storage}
        availableContentTypes={availableContentTypes}
        open={uploadOpen}
        onOpenChange={setUploadOpen}
      />
      <DownloadUrlDialog
        node={node}
        storage={storage}
        availableContentTypes={availableContentTypes}
        open={downloadOpen}
        onOpenChange={setDownloadOpen}
      />
    </div>
  );
}
