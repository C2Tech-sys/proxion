import { useId, useState } from 'react';
import { Loader2 } from 'lucide-react';

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { SystemField } from '@/components/nodesystem/SystemField';
import {
  nodeSystemErrorMessage,
  useRemoveNodeCertificate,
  useUploadNodeCertificate,
} from '@/api/nodeSystemHooks';
import type { UploadCertificateBody } from '@/api/nodeSystem';

/** The word the upload dialog asks for. */
export const UPLOAD_CONFIRM_WORD = 'UPLOAD';
/** The word the remove dialog asks for. */
export const REMOVE_CONFIRM_WORD = 'REMOVE';

/** The one-sentence consequence the upload dialog spells out. `PVE_TLS_FINGERPRINT` is the
 * environment variable Proxion pins the Proxmox certificate with (`apps/server/src/config.ts`). */
export const UPLOAD_WARNING =
  "Proxmox restarts its web proxy with the new certificate; a wrong certificate or key makes the Proxmox web UI, and Proxion's connection to it, unreachable until fixed from the console. If Proxion pins this node's certificate fingerprint (PVE_TLS_FINGERPRINT), update that pin afterwards.";

/** The one-sentence consequence the remove dialog spells out. */
export const REMOVE_WARNING = 'Proxmox goes back to its self-signed certificate and restarts its web proxy.';

const CERT_BEGIN_RE = /-----BEGIN CERTIFICATE-----/;
const KEY_BEGIN_RE = /-----BEGIN (RSA |EC )?PRIVATE KEY-----/;
const MAX_PEM_LENGTH = 65536;

export interface UploadCertificateDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  node: string;
}

/**
 * Uploads a custom TLS certificate (chain + private key) for the node's web proxy, behind a typed
 * `UPLOAD` confirmation that spells out the lock-out risk. The private key is a secret: it lives
 * only in this dialog's field until submit, is cleared from state the moment the request is sent,
 * and the mutation's own copy of the variables is reset as soon as the request settles -- so a
 * failed upload asks for the key again rather than holding on to it.
 *
 * Mount it fresh per open (the tab renders it conditionally).
 */
export function UploadCertificateDialog({ open, onOpenChange, node }: UploadCertificateDialogProps) {
  const id = useId();
  const mutation = useUploadNodeCertificate();
  const [certificates, setCertificates] = useState('');
  const [key, setKey] = useState('');
  const [force, setForce] = useState(false);
  const [restart, setRestart] = useState(true);
  const [confirmText, setConfirmText] = useState('');
  const [serverError, setServerError] = useState<string | undefined>(undefined);
  const [submitting, setSubmitting] = useState(false);

  const certError =
    certificates.trim() !== '' && !CERT_BEGIN_RE.test(certificates)
      ? 'This does not look like a PEM certificate (no BEGIN CERTIFICATE line).'
      : certificates.length > MAX_PEM_LENGTH
        ? `The certificate can be at most ${MAX_PEM_LENGTH} characters.`
        : undefined;
  const keyError =
    key.trim() !== '' && !KEY_BEGIN_RE.test(key)
      ? 'This does not look like an unencrypted PEM private key (no BEGIN PRIVATE KEY line).'
      : key.length > MAX_PEM_LENGTH
        ? `The key can be at most ${MAX_PEM_LENGTH} characters.`
        : undefined;
  const confirmed = confirmText === UPLOAD_CONFIRM_WORD;
  const canSubmit = CERT_BEGIN_RE.test(certificates) && certError === undefined && keyError === undefined && confirmed && !submitting;

  async function submit() {
    if (!canSubmit) return;
    const body: UploadCertificateBody = { certificates, restart };
    if (key.trim() !== '') body.key = key;
    if (force) body.force = true;
    // The key leaves component state before the request goes out.
    setKey('');
    setServerError(undefined);
    setSubmitting(true);
    try {
      await mutation.mutateAsync({ node, body });
      onOpenChange(false);
    } catch (error) {
      setServerError(nodeSystemErrorMessage(error, 'The certificate could not be installed.'));
    } finally {
      // Drop react-query's copy of the variables (the key) as soon as the request settles.
      mutation.reset();
      setSubmitting(false);
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next && submitting) return;
        onOpenChange(next);
      }}
    >
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Upload custom certificate</DialogTitle>
          <DialogDescription>{UPLOAD_WARNING}</DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-4">
          <SystemField
            label="Certificate chain (PEM)"
            htmlFor={`${id}-cert`}
            error={certError}
            hint="The certificate first, then any intermediate certificates."
          >
            <Textarea
              id={`${id}-cert`}
              className="font-mono text-xs"
              value={certificates}
              onChange={(e) => setCertificates(e.target.value)}
              disabled={submitting}
              rows={7}
              spellCheck={false}
              autoComplete="off"
              aria-invalid={certError !== undefined || undefined}
              placeholder="-----BEGIN CERTIFICATE-----"
            />
          </SystemField>
          <SystemField
            label="Private key (PEM)"
            htmlFor={`${id}-key`}
            error={keyError}
            hint="Sent to Proxmox once and never kept. Leave it empty if the certificate file already carries the key."
          >
            <Textarea
              id={`${id}-key`}
              className="font-mono text-xs"
              value={key}
              onChange={(e) => setKey(e.target.value)}
              disabled={submitting}
              rows={5}
              spellCheck={false}
              autoComplete="off"
              aria-invalid={keyError !== undefined || undefined}
              placeholder="-----BEGIN PRIVATE KEY-----"
            />
          </SystemField>

          <div className="flex items-center gap-2">
            <Checkbox id={`${id}-force`} checked={force} onCheckedChange={(c) => setForce(c === true)} disabled={submitting} />
            <label htmlFor={`${id}-force`} className="text-sm">
              Force (skip Proxmox&apos;s validation)
            </label>
          </div>
          <div className="flex items-center gap-2">
            <Checkbox id={`${id}-restart`} checked={restart} onCheckedChange={(c) => setRestart(c === true)} disabled={submitting} />
            <label htmlFor={`${id}-restart`} className="text-sm">
              Restart pveproxy
            </label>
          </div>

          <SystemField label={`Type ${UPLOAD_CONFIRM_WORD} to confirm`} htmlFor={`${id}-confirm`}>
            <Input
              id={`${id}-confirm`}
              value={confirmText}
              onChange={(e) => setConfirmText(e.target.value)}
              disabled={submitting}
              placeholder={UPLOAD_CONFIRM_WORD}
              autoComplete="off"
            />
          </SystemField>

          {serverError !== undefined && (
            <p role="alert" className="text-xs text-status-error">
              {serverError} Paste the private key again to retry.
            </p>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={submitting}>
            Cancel
          </Button>
          <Button variant="destructive" onClick={() => void submit()} disabled={!canSubmit}>
            {submitting && <Loader2 className="size-4 animate-spin" />}
            Upload certificate
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export interface RemoveCertificateDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  node: string;
}

/** Typed `REMOVE` confirmation for deleting the custom certificate (Proxmox falls back to its
 * self-signed one and restarts its web proxy). A server error stays inline. Mount it fresh per
 * open. */
export function RemoveCertificateDialog({ open, onOpenChange, node }: RemoveCertificateDialogProps) {
  const id = useId();
  const mutation = useRemoveNodeCertificate();
  const [confirmText, setConfirmText] = useState('');
  const confirmed = confirmText === REMOVE_CONFIRM_WORD;

  function confirm() {
    if (!confirmed || mutation.isPending) return;
    mutation.mutate({ node, body: { restart: true } }, { onSuccess: () => onOpenChange(false) });
  }

  return (
    <AlertDialog
      open={open}
      onOpenChange={(next) => {
        if (!next && mutation.isPending) return;
        onOpenChange(next);
      }}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Remove the custom certificate on {node}?</AlertDialogTitle>
          <AlertDialogDescription>{REMOVE_WARNING}</AlertDialogDescription>
        </AlertDialogHeader>

        <div className="flex flex-col gap-1.5">
          <label htmlFor={`${id}-confirm`} className="text-sm text-muted-foreground">
            Type {REMOVE_CONFIRM_WORD} to confirm
          </label>
          <Input
            id={`${id}-confirm`}
            autoFocus
            value={confirmText}
            onChange={(e) => setConfirmText(e.target.value)}
            disabled={mutation.isPending}
            placeholder={REMOVE_CONFIRM_WORD}
            autoComplete="off"
          />
        </div>

        {mutation.isError && (
          <p role="alert" className="text-xs text-status-error">
            {nodeSystemErrorMessage(mutation.error, 'The custom certificate could not be removed.')}
          </p>
        )}

        <AlertDialogFooter>
          <AlertDialogCancel disabled={mutation.isPending}>Cancel</AlertDialogCancel>
          <AlertDialogAction
            variant="destructive"
            disabled={!confirmed || mutation.isPending}
            onClick={(event) => {
              // Radix closes an AlertDialogAction on click by default; wait for the request to be
              // accepted instead (and stay open on an error).
              event.preventDefault();
              confirm();
            }}
          >
            {mutation.isPending && <Loader2 className="size-4 animate-spin" />}
            Remove custom certificate
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
