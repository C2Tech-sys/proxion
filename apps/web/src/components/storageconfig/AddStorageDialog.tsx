import { useId, useState, type KeyboardEvent } from 'react';
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
import { hardwareErrorMessage } from '@/api/hardwareHooks';
import { useAddStorage } from '@/api/storageConfigHooks';
import { STORAGE_TYPE_LABELS, type StorageType } from '@/api/storageConfig';
import { Field, StorageFormFields } from '@/components/storageconfig/fields';
import { buildAddBody, emptyForm, validateForm, type StorageForm } from '@/components/storageconfig/form';

export interface AddStorageDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  type: StorageType;
  /** The cluster's node names, for the node picker and the scan helpers. */
  clusterNodes: string[];
}

/**
 * Adds a storage definition of one type (the "Add" menu picks the type). Per-type fields, content
 * limited to what the type can hold, a node picker (none = all nodes), enable, and the keep-*
 * retention for backup-capable types. NFS exports, SMB shares, ZFS pools, volume groups and thin
 * pools can be filled from a scan; a PBS datastore is typed in (the scan would need the password in
 * a URL). Validation mirrors the server's, shown inline; a server error stays inline and the dialog
 * stays open. The CIFS/PBS password is sent once, in the request, and never kept.
 *
 * Mount it fresh per open (the Storage tab renders it conditionally).
 */
export function AddStorageDialog({ open, onOpenChange, type, clusterNodes }: AddStorageDialogProps) {
  const id = useId();
  const mutation = useAddStorage();
  const [form, setFormState] = useState<StorageForm>(() => emptyForm(type));
  const setForm = (patch: Partial<StorageForm>) => setFormState((current) => ({ ...current, ...patch }));

  const errors = validateForm(type, form, 'add');
  // Only show a message once the field has content; the button stays disabled until all pass.
  const shownErrors = Object.fromEntries(
    Object.entries(errors).filter(([key]) => key === 'content' || key.startsWith('keep.') || String(form[key as keyof StorageForm] ?? '') !== ''),
  );
  const canSave = Object.keys(errors).length === 0 && !mutation.isPending;
  const busy = mutation.isPending;

  function submit() {
    if (!canSave) return;
    mutation.mutate(buildAddBody(type, form), { onSuccess: () => onOpenChange(false) });
  }

  function onKeyDown(event: KeyboardEvent<HTMLElement>) {
    if (event.key === 'Enter' && event.target instanceof HTMLInputElement) {
      event.preventDefault();
      submit();
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next && busy) return;
        onOpenChange(next);
      }}
    >
      <DialogContent onKeyDown={onKeyDown} className="max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Add: {STORAGE_TYPE_LABELS[type]}</DialogTitle>
          <DialogDescription>Defines a new storage in Proxmox VE. It becomes available on the selected nodes.</DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-4">
          <Field label="ID" htmlFor={`${id}-storage`} error={shownErrors.storage}>
            <Input
              id={`${id}-storage`}
              autoFocus
              value={form.storage}
              disabled={busy}
              autoComplete="off"
              aria-invalid={shownErrors.storage !== undefined || undefined}
              onChange={(e) => setForm({ storage: e.target.value })}
            />
          </Field>
          <StorageFormFields
            type={type}
            form={form}
            setForm={setForm}
            errors={shownErrors}
            mode="add"
            clusterNodes={clusterNodes}
            disabled={busy}
          />
        </div>

        {mutation.isError && (
          <p role="alert" className="text-xs text-status-error">
            {hardwareErrorMessage(mutation.error, 'The storage could not be added.')}
          </p>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={!canSave}>
            {busy && <Loader2 className="size-4 animate-spin" />}
            Add
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
