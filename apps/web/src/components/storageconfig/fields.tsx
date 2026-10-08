import { useId, type ReactNode } from 'react';
import { Loader2, Search } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { NativeSelect } from '@/components/hardware/NativeSelect';
import { hardwareErrorMessage } from '@/api/hardwareHooks';
import { useStorageScan } from '@/api/storageConfigHooks';
import {
  CONTENT_BY_TYPE,
  CONTENT_LABELS,
  PRUNE_FIELDS,
  SMB_VERSIONS,
  type ContentType,
  type ScanRequest,
  type StorageType,
} from '@/api/storageConfig';
import { showsRetention, type FormErrors, type StorageForm } from '@/components/storageconfig/form';

export function Field({
  label,
  htmlFor,
  error,
  hint,
  children,
}: {
  label: string;
  htmlFor: string;
  error?: string | undefined;
  hint?: string | undefined;
  children: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={htmlFor} className="text-sm font-medium">
        {label}
      </label>
      {children}
      {error ? (
        <p className="text-xs text-status-error">{error}</p>
      ) : hint ? (
        <p className="text-xs text-muted-foreground">{hint}</p>
      ) : null}
    </div>
  );
}

export function CheckField({
  id,
  label,
  checked,
  onChange,
  disabled,
}: {
  id: string;
  label: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled: boolean;
}) {
  return (
    <div className="flex items-center gap-2">
      <Checkbox id={id} checked={checked} onCheckedChange={(c) => onChange(c === true)} disabled={disabled} />
      <label htmlFor={id} className="text-sm">
        {label}
      </label>
    </div>
  );
}

/** The content-type checkboxes, limited to what `type` can hold. */
export function ContentField({
  type,
  value,
  onChange,
  error,
  disabled,
}: {
  type: StorageType;
  value: ContentType[];
  onChange: (next: ContentType[]) => void;
  error?: string | undefined;
  disabled: boolean;
}) {
  const id = useId();
  return (
    <fieldset className="flex flex-col gap-1.5" disabled={disabled}>
      <legend className="mb-1.5 text-sm font-medium">Content</legend>
      <div className="grid grid-cols-1 gap-1.5 sm:grid-cols-2">
        {CONTENT_BY_TYPE[type].map((content) => (
          <CheckField
            key={content}
            id={`${id}-${content}`}
            label={CONTENT_LABELS[content]}
            checked={value.includes(content)}
            disabled={disabled}
            onChange={(checked) =>
              onChange(checked ? [...value, content] : value.filter((existing) => existing !== content))
            }
          />
        ))}
      </div>
      {error && <p className="text-xs text-status-error">{error}</p>}
    </fieldset>
  );
}

/** The node multi-select: none ticked = the storage is available on every node. */
export function NodesField({
  nodes,
  value,
  onChange,
  disabled,
}: {
  nodes: string[];
  value: string[];
  onChange: (next: string[]) => void;
  disabled: boolean;
}) {
  const id = useId();
  // A node the definition names but the cluster no longer lists stays visible (and removable).
  const options = [...nodes, ...value.filter((n) => !nodes.includes(n))];
  return (
    <fieldset className="flex flex-col gap-1.5" disabled={disabled}>
      <legend className="mb-1.5 text-sm font-medium">Nodes</legend>
      <div className="flex flex-wrap gap-x-4 gap-y-1.5">
        {options.map((node) => (
          <CheckField
            key={node}
            id={`${id}-${node}`}
            label={node}
            checked={value.includes(node)}
            disabled={disabled}
            onChange={(checked) => onChange(checked ? [...value, node] : value.filter((n) => n !== node))}
          />
        ))}
      </div>
      <p className="text-xs text-muted-foreground">
        {value.length === 0 ? 'Available on all nodes.' : 'Available on the selected nodes only.'}
      </p>
    </fieldset>
  );
}

/** The keep-* retention fields (backup-capable storage that holds backups). */
export function RetentionFields({
  form,
  setForm,
  errors,
  disabled,
}: {
  form: StorageForm;
  setForm: (patch: Partial<StorageForm>) => void;
  errors: FormErrors;
  disabled: boolean;
}) {
  const id = useId();
  return (
    <fieldset className="flex flex-col gap-2" disabled={disabled}>
      <legend className="mb-1 text-sm font-medium">Backup retention</legend>
      <CheckField
        id={`${id}-keep-all`}
        label="Keep all backups"
        checked={form.keepAll}
        disabled={disabled}
        onChange={(checked) => setForm({ keepAll: checked })}
      />
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
        {PRUNE_FIELDS.map(([key, , label]) => (
          <Field key={key} label={label} htmlFor={`${id}-${key}`} error={errors[`keep.${key}`]}>
            <Input
              id={`${id}-${key}`}
              inputMode="numeric"
              value={form.keep[key]}
              disabled={disabled || form.keepAll}
              onChange={(e) => setForm({ keep: { ...form.keep, [key]: e.target.value } })}
            />
          </Field>
        ))}
      </div>
      <p className="text-xs text-muted-foreground">PVE keeps every backup when nothing is set.</p>
    </fieldset>
  );
}

/** A "Scan" button plus the list of what it found; picking an entry fills the field. */
function ScanPicker({
  label,
  request,
  disabledReason,
  onPick,
  disabled,
}: {
  label: string;
  /** `undefined` while the inputs the scan needs (e.g. the server) are not filled in. */
  request: ScanRequest | undefined;
  disabledReason?: string | undefined;
  onPick: (value: string) => void;
  disabled: boolean;
}) {
  const scan = useStorageScan();
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center gap-2">
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={disabled || request === undefined || scan.isPending}
          title={request === undefined ? disabledReason : undefined}
          onClick={() => request && scan.mutate(request)}
        >
          {scan.isPending ? <Loader2 className="size-3.5 animate-spin" /> : <Search className="size-3.5" />}
          Scan {label}
        </Button>
        {scan.isSuccess && scan.data.length === 0 && (
          <span className="text-xs text-muted-foreground">Nothing found. Enter the value by hand.</span>
        )}
      </div>
      {scan.isError && (
        <p role="alert" className="text-xs text-status-error">
          {hardwareErrorMessage(scan.error, 'The scan failed. Enter the value by hand.')}
        </p>
      )}
      {scan.isSuccess && scan.data.length > 0 && (
        <NativeSelect
          aria-label={`Found ${label}`}
          defaultValue=""
          disabled={disabled}
          onChange={(e) => e.target.value !== '' && onPick(e.target.value)}
        >
          <option value="">Select a result...</option>
          {scan.data.map((value) => (
            <option key={value} value={value}>
              {value}
            </option>
          ))}
        </NativeSelect>
      )}
    </div>
  );
}

export interface TypeFieldsProps {
  type: StorageType;
  form: StorageForm;
  setForm: (patch: Partial<StorageForm>) => void;
  errors: FormErrors;
  mode: 'add' | 'edit';
  /** The node the scan helpers run on. */
  scanNode: string;
  disabled: boolean;
}

/** The per-type fields. In edit mode the identity of the storage (path, server, share, volume
 * group, pool, datastore ...) is shown but read-only: PVE does not allow changing it. */
export function TypeFields({ type, form, setForm, errors, mode, scanNode, disabled }: TypeFieldsProps) {
  const id = useId();
  const locked = mode === 'edit';
  const lockedHint = locked ? 'Cannot be changed after the storage is created.' : undefined;
  const text = (key: keyof StorageForm, label: string, opts: { hint?: string; type?: string; placeholder?: string; autoComplete?: string; locked?: boolean } = {}) => (
    <Field label={label} htmlFor={`${id}-${key}`} error={errors[key]} hint={opts.hint ?? (opts.locked ? lockedHint : undefined)}>
      <Input
        id={`${id}-${key}`}
        type={opts.type ?? 'text'}
        value={form[key] as string}
        placeholder={opts.placeholder}
        autoComplete={opts.autoComplete ?? 'off'}
        disabled={disabled || opts.locked === true}
        onChange={(e) => setForm({ [key]: e.target.value } as Partial<StorageForm>)}
      />
    </Field>
  );

  switch (type) {
    case 'dir':
      return (
        <>
          {text('path', 'Directory', { placeholder: '/mnt/data', locked })}
          <CheckField id={`${id}-shared`} label="Shared" checked={form.shared} disabled={disabled} onChange={(shared) => setForm({ shared })} />
        </>
      );
    case 'nfs':
      return (
        <>
          {text('server', 'Server', { placeholder: '10.0.0.5', locked })}
          {!locked && (
            <ScanPicker
              label="NFS exports"
              request={form.server !== '' && !errors.server ? { kind: 'nfs', node: scanNode, server: form.server } : undefined}
              disabledReason="Enter the server first"
              disabled={disabled}
              onPick={(value) => setForm({ export: value })}
            />
          )}
          {text('export', 'Export', { placeholder: '/srv/pve', locked })}
          {text('options', 'NFS options', { hint: 'For example vers=4.2,soft' })}
        </>
      );
    case 'cifs':
      return (
        <>
          {text('server', 'Server', { placeholder: 'nas.example.lan', locked })}
          {!locked && (
            <ScanPicker
              label="SMB shares"
              request={form.server !== '' && !errors.server ? { kind: 'cifs', node: scanNode, server: form.server } : undefined}
              disabledReason="Enter the server first"
              disabled={disabled}
              onPick={(value) => setForm({ share: value })}
            />
          )}
          {text('share', 'Share', { locked })}
          {text('username', 'Username')}
          <Field
            label="Password"
            htmlFor={`${id}-password`}
            error={errors.password}
            hint={locked ? 'Leave blank to keep the current password.' : 'Sent to Proxmox once and never stored or logged by Proxion.'}
          >
            <Input
              id={`${id}-password`}
              type="password"
              value={form.password}
              autoComplete="new-password"
              disabled={disabled}
              onChange={(e) => setForm({ password: e.target.value })}
            />
          </Field>
          {text('domain', 'Domain')}
          {text('subdir', 'Sub directory', { placeholder: '/backups' })}
          <Field label="SMB version" htmlFor={`${id}-smbversion`}>
            <NativeSelect
              id={`${id}-smbversion`}
              value={form.smbversion}
              disabled={disabled}
              onChange={(e) => setForm({ smbversion: e.target.value })}
            >
              {SMB_VERSIONS.map((v) => (
                <option key={v} value={v}>
                  {v === 'default' ? 'Default' : v}
                </option>
              ))}
            </NativeSelect>
          </Field>
        </>
      );
    case 'lvm':
      return (
        <>
          {!locked && (
            <ScanPicker
              label="volume groups"
              request={{ kind: 'lvm', node: scanNode }}
              disabled={disabled}
              onPick={(value) => setForm({ vgname: value })}
            />
          )}
          {text('vgname', 'Volume group', { locked })}
          <CheckField id={`${id}-shared`} label="Shared" checked={form.shared} disabled={disabled} onChange={(shared) => setForm({ shared })} />
        </>
      );
    case 'lvmthin':
      return (
        <>
          {!locked && (
            <ScanPicker
              label="volume groups"
              request={{ kind: 'lvm', node: scanNode }}
              disabled={disabled}
              onPick={(value) => setForm({ vgname: value })}
            />
          )}
          {text('vgname', 'Volume group', { locked })}
          {!locked && (
            <ScanPicker
              label="thin pools"
              request={form.vgname !== '' ? { kind: 'lvmthin', node: scanNode, vg: form.vgname } : undefined}
              disabledReason="Enter the volume group first"
              disabled={disabled}
              onPick={(value) => setForm({ thinpool: value })}
            />
          )}
          {text('thinpool', 'Thin pool', { locked })}
        </>
      );
    case 'zfspool':
      return (
        <>
          {!locked && (
            <ScanPicker
              label="ZFS pools"
              request={{ kind: 'zfs', node: scanNode }}
              disabled={disabled}
              onPick={(value) => setForm({ pool: value })}
            />
          )}
          {text('pool', 'ZFS pool', { locked })}
          <CheckField id={`${id}-sparse`} label="Thin provision" checked={form.sparse} disabled={disabled} onChange={(sparse) => setForm({ sparse })} />
          {text('blocksize', 'Block size', { hint: 'For example 16k. Leave blank for the ZFS default.', locked })}
        </>
      );
    case 'pbs':
      return (
        <>
          {text('server', 'Server', { placeholder: 'pbs.example.lan', locked })}
          {text('username', 'Username', { placeholder: 'backup@pbs' })}
          <Field
            label="Password"
            htmlFor={`${id}-password`}
            error={errors.password}
            hint={locked ? 'Leave blank to keep the current password.' : 'Sent to Proxmox once and never stored or logged by Proxion.'}
          >
            <Input
              id={`${id}-password`}
              type="password"
              value={form.password}
              autoComplete="new-password"
              disabled={disabled}
              onChange={(e) => setForm({ password: e.target.value })}
            />
          </Field>
          {text('datastore', 'Datastore', { locked })}
          {text('namespace', 'Namespace', { hint: 'Optional.' })}
          {text('fingerprint', 'Fingerprint', { hint: 'SHA-256 certificate fingerprint; needed for a self-signed certificate.' })}
        </>
      );
  }
}

/** Everything a dialog shows besides the id: the per-type fields, content, nodes, enable,
 * retention. */
export function StorageFormFields({
  type,
  form,
  setForm,
  errors,
  mode,
  clusterNodes,
  disabled,
}: {
  type: StorageType;
  form: StorageForm;
  setForm: (patch: Partial<StorageForm>) => void;
  errors: FormErrors;
  mode: 'add' | 'edit';
  clusterNodes: string[];
  disabled: boolean;
}) {
  const id = useId();
  const scanNode = form.nodes[0] ?? clusterNodes[0] ?? '';
  return (
    <>
      <TypeFields type={type} form={form} setForm={setForm} errors={errors} mode={mode} scanNode={scanNode} disabled={disabled} />
      <ContentField type={type} value={form.content} onChange={(content) => setForm({ content })} error={errors.content} disabled={disabled} />
      <NodesField nodes={clusterNodes} value={form.nodes} onChange={(nodes) => setForm({ nodes })} disabled={disabled} />
      <CheckField id={`${id}-enabled`} label="Enable" checked={form.enabled} disabled={disabled} onChange={(enabled) => setForm({ enabled })} />
      {showsRetention(type, form.content) && <RetentionFields form={form} setForm={setForm} errors={errors} disabled={disabled} />}
    </>
  );
}
