import { useState } from 'react';
import { TriangleAlert } from 'lucide-react';

import { EmptyState } from '@/components/EmptyState';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { RemoveCertificateDialog, UploadCertificateDialog } from '@/components/nodesystem/CertificateDialogs';
import { certificateExpiry, formatEpochDate, type ExpiryLevel } from '@/components/nodesystem/systemFormat';
import { errorMessage } from '@/api/errors';
import { useNodeCertificates } from '@/api/nodeSystemHooks';
import type { NodeCertificate } from '@/api/nodeSystem';
import { cn } from '@/lib/utils';

/** The file PVE keeps an uploaded custom certificate in. */
export const CUSTOM_CERT_FILE = 'pveproxy-ssl.pem';

const EXPIRY_CLASS: Record<ExpiryLevel, string> = {
  ok: 'text-muted-foreground',
  warning: 'font-medium text-status-paused',
  expired: 'font-medium text-status-error',
};

export interface CertificatesPanelProps {
  node: string;
  /** Why the write buttons are disabled; `undefined` when the caller may write. */
  disabledReason: string | undefined;
}

function ExpiryCell({ cert }: { cert: NodeCertificate }) {
  const expiry = certificateExpiry(cert.notafter);
  return (
    <div className="flex flex-col">
      <span>{formatEpochDate(cert.notafter)}</span>
      {expiry && (
        <span
          data-testid={`node-cert-expiry-${cert.filename}`}
          data-level={expiry.level}
          className={cn('flex items-center gap-1 text-xs', EXPIRY_CLASS[expiry.level])}
        >
          {expiry.level !== 'ok' && <TriangleAlert className="size-3 shrink-0" aria-hidden="true" />}
          {expiry.text}
        </span>
      )}
    </div>
  );
}

/** Node -> Certificates: the certificate files Proxmox reports, with upload / remove of the custom
 * one (`pveproxy-ssl.pem`). */
export function CertificatesPanel({ node, disabledReason }: CertificatesPanelProps) {
  const certs = useNodeCertificates(node);
  const [uploading, setUploading] = useState(false);
  const [removing, setRemoving] = useState(false);

  const disabled = disabledReason !== undefined;
  const hasCustom = certs.data?.some((cert) => cert.filename === CUSTOM_CERT_FILE) === true;

  return (
    <div data-testid="node-system-certificates" className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-sm font-medium text-muted-foreground">Certificates on {node}</h2>
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            disabled={disabled}
            aria-disabled={disabled || undefined}
            title={disabledReason}
            onClick={() => setUploading(true)}
          >
            Upload custom certificate
          </Button>
          {hasCustom && (
            <Button
              variant="outline"
              size="sm"
              className="text-destructive hover:text-destructive"
              disabled={disabled}
              aria-disabled={disabled || undefined}
              title={disabledReason}
              onClick={() => setRemoving(true)}
            >
              Remove custom certificate
            </Button>
          )}
        </div>
      </div>

      {certs.isLoading ? (
        <Skeleton className="h-40" />
      ) : certs.isError ? (
        <EmptyState message={`Could not load the certificates: ${errorMessage(certs.error)}`} />
      ) : (certs.data ?? []).length === 0 ? (
        <EmptyState message="No certificates reported for this node." />
      ) : (
        <div className="overflow-x-auto rounded-lg border border-border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>File</TableHead>
                <TableHead>Subject</TableHead>
                <TableHead>Issuer</TableHead>
                <TableHead>SANs</TableHead>
                <TableHead>Valid from</TableHead>
                <TableHead>Valid until</TableHead>
                <TableHead>Fingerprint</TableHead>
                <TableHead>Key</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {certs.data?.map((cert) => (
                <TableRow key={cert.filename} data-testid={`node-cert-row-${cert.filename}`}>
                  <TableCell className="font-medium">{cert.filename}</TableCell>
                  <TableCell className="max-w-56 break-words whitespace-normal">{cert.subject ?? ''}</TableCell>
                  <TableCell className="max-w-56 break-words whitespace-normal">{cert.issuer ?? ''}</TableCell>
                  <TableCell className="max-w-48 break-words whitespace-normal">{cert.san.join(', ')}</TableCell>
                  <TableCell>{formatEpochDate(cert.notbefore)}</TableCell>
                  <TableCell>
                    <ExpiryCell cert={cert} />
                  </TableCell>
                  <TableCell className="max-w-48 font-mono text-xs break-all whitespace-normal">
                    {cert.fingerprint ?? ''}
                  </TableCell>
                  <TableCell>
                    {cert.publicKeyType !== undefined
                      ? `${cert.publicKeyType}${cert.publicKeyBits !== undefined ? ` (${cert.publicKeyBits})` : ''}`
                      : ''}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}

      {uploading && (
        <UploadCertificateDialog
          open
          onOpenChange={(open) => {
            if (!open) setUploading(false);
          }}
          node={node}
        />
      )}
      {removing && (
        <RemoveCertificateDialog
          open
          onOpenChange={(open) => {
            if (!open) setRemoving(false);
          }}
          node={node}
        />
      )}
    </div>
  );
}
