import { useId } from 'react';

import { NativeSelect } from '@/components/hardware/NativeSelect';
import { OSTYPE_OPTIONS } from '@/components/options/optionFields';
import { CheckRow, Field, StorageSelect, type StepProps } from '@/components/create/vm/fields';
import { UNSAFE_ISO_NAME_MESSAGE, isoFileName } from '@/components/create/vm/wizardState';
import { isSafeIsoName } from '@/lib/pve-config';
import { formatBytes } from '@/lib/format';

const OS_GROUPS: Array<{ label: string; values: readonly string[] }> = [
  { label: 'Linux', values: ['l26', 'l24'] },
  { label: 'Windows', values: ['win11', 'win10', 'win8', 'win7', 'w2k8', 'wvista', 'w2k3', 'wxp', 'w2k'] },
  { label: 'Other', values: ['solaris', 'other'] },
];

/** Step 2: install media (an ISO image or none), OS type, QEMU guest agent. */
export function StepOs({ form, patch, errors, data, disabled }: StepProps) {
  const isoName = useId();
  const noneName = useId();
  const iso = form.mediaKind === 'iso';
  const labelOf = (value: string) => OSTYPE_OPTIONS.find((o) => o.value === value)?.label ?? value;

  return (
    <div className="flex flex-col gap-4">
      <fieldset className="flex flex-col gap-2">
        <legend className="mb-1 text-sm font-medium">Install media</legend>
        <div className="flex items-center gap-2">
          <input
            id={isoName}
            type="radio"
            name="create-vm-media"
            checked={iso}
            onChange={() => patch({ mediaKind: 'iso' })}
            disabled={disabled}
          />
          <label htmlFor={isoName} className="text-sm">
            Use CD/DVD disc image file (iso)
          </label>
        </div>
        <div className="flex items-center gap-2">
          <input
            id={noneName}
            type="radio"
            name="create-vm-media"
            checked={!iso}
            onChange={() => patch({ mediaKind: 'none', isoVolid: '' })}
            disabled={disabled}
          />
          <label htmlFor={noneName} className="text-sm">
            Do not use any media
          </label>
        </div>
      </fieldset>

      {iso && (
        <>
          <Field
            label="ISO storage"
            hint={data.isoStorages.length === 0 ? 'No storage on this node holds ISO images.' : undefined}
          >
            {(id) => (
              <StorageSelect
                id={id}
                value={form.isoStorage}
                onChange={(isoStorage) => patch({ isoStorage, isoVolid: '' })}
                storages={data.isoStorages}
                disabled={disabled}
              />
            )}
          </Field>
          <Field
            label="ISO image"
            hint={
              form.isoStorage !== '' && data.isos !== undefined && data.isos.length === 0
                ? `No ISO images on ${form.isoStorage}. Upload one from the storage page first.`
                : undefined
            }
            error={errors.isoVolid === UNSAFE_ISO_NAME_MESSAGE ? errors.isoVolid : undefined}
          >
            {(id) => (
              <NativeSelect
                id={id}
                value={form.isoVolid}
                onChange={(e) => patch({ isoVolid: e.target.value })}
                disabled={disabled || form.isoStorage === '' || !data.isos || data.isos.length === 0}
              >
                <option value="">{data.isos === undefined && form.isoStorage !== '' ? 'Loading…' : 'Select an ISO image'}</option>
                {(data.isos ?? []).map((m) => {
                  const safe = isSafeIsoName(isoFileName(m.volid));
                  return (
                    <option
                      key={m.volid}
                      value={m.volid}
                      disabled={!safe}
                      title={safe ? undefined : UNSAFE_ISO_NAME_MESSAGE}
                    >
                      {isoFileName(m.volid)}
                      {m.size > 0 ? ` (${formatBytes(m.size)})` : ''}
                    </option>
                  );
                })}
              </NativeSelect>
            )}
          </Field>
        </>
      )}

      <Field label="Guest OS type">
        {(id) => (
          <NativeSelect id={id} value={form.ostype} onChange={(e) => patch({ ostype: e.target.value })} disabled={disabled}>
            {OS_GROUPS.map((group) => (
              <optgroup key={group.label} label={group.label}>
                {group.values.map((value) => (
                  <option key={value} value={value}>
                    {labelOf(value)}
                  </option>
                ))}
              </optgroup>
            ))}
          </NativeSelect>
        )}
      </Field>

      <CheckRow
        label="QEMU guest agent"
        checked={form.agent}
        onChange={(agent) => patch({ agent, agentTouched: true })}
        disabled={disabled}
        hint="Needs the agent installed inside the guest. On by default for Linux."
      />
    </div>
  );
}
