import { useState, type KeyboardEvent } from 'react';
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
import { hardwareErrorMessage } from '@/api/hardwareHooks';
import { useEditStorage } from '@/api/storageConfigHooks';
import { STORAGE_TYPE_LABELS, STORAGE_TYPES, type StorageConfig, type StorageType } from '@/api/storageConfig';
import { StorageFormFields } from '@/components/storageconfig/fields';
import { buildEditBody, formFromConfig, validateForm, type StorageForm } from '@/components/storageconfig/form';

export interface EditStorageDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  config: StorageConfig;
  clusterNodes: string[];
}

/**
 * Edits an existing storage definition: content, nodes, enable, the type's own options and the
 * retention policy. What the storage points at (path, server, share, pool, ...) is read-only. The
 * request is the full desired state of the editable fields; a cleared field is sent as `null` (the
 * server turns it into PVE's delete list), and a blank password is `{ keep: true }`, so the stored
 * secret is never re-sent or shown.
 *
 * Storage types this panel cannot create (Ceph, iSCSI, ...) are not offered an Edit action at all
 * (see the tab), so this dialog only ever sees the seven types the Add menu creates.
 *
 * Mount it fresh per open (the Storage tab renders it conditionally).
 */
export function EditStorageDialog({ open, onOpenChange, config, clusterNodes }: EditStorageDialogProps) {
  const mutation = useEditStorage();
  const type = config.type as StorageType;
  const [form, setFormState] = useState<StorageForm>(() => formFromConfig(config));
  const setForm = (patch: Partial<StorageForm>) => setFormState((current) => ({ ...current, ...patch }));

  const errors = validateForm(type, form, 'edit');
  const busy = mutation.isPending;
  const canSave = STORAGE_TYPES.includes(type) && Object.keys(errors).length === 0 && !busy;

  function submit() {
    if (!canSave) return;
    mutation.mutate({ storage: config.storage, body: buildEditBody(type, form) }, { onSuccess: () => onOpenChange(false) });
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
          <DialogTitle>Edit: {config.storage}</DialogTitle>
          <DialogDescription>
            {STORAGE_TYPE_LABELS[type]} storage. What it points at cannot be changed here; remove it and add it again to
            repoint it.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-4">
          <StorageFormFields
            type={type}
            form={form}
            setForm={setForm}
            errors={errors}
            mode="edit"
            clusterNodes={clusterNodes}
            disabled={busy}
          />
        </div>

        {mutation.isError && (
          <p role="alert" className="text-xs text-status-error">
            {hardwareErrorMessage(mutation.error, 'The storage could not be saved.')}
          </p>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={!canSave}>
            {busy && <Loader2 className="size-4 animate-spin" />}
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
