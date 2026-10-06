import { Input } from '@/components/ui/input';
import { NativeSelect } from '@/components/hardware/NativeSelect';
import { CheckRow, Field, type StepProps } from '@/components/create/vm/fields';
import { typedError } from '@/components/create/vm/wizardState';
import type { CreateVmNicModel } from '@/api/createVm';

const NIC_MODELS: Array<{ value: CreateVmNicModel; label: string }> = [
  { value: 'virtio', label: 'VirtIO (paravirtualized)' },
  { value: 'e1000', label: 'Intel E1000' },
  { value: 'e1000e', label: 'Intel E1000e' },
  { value: 'vmxnet3', label: 'VMware vmxnet3' },
  { value: 'rtl8139', label: 'Realtek RTL8139' },
];

/** Step 7: one network device (bridge, model, VLAN tag, firewall), or none. The MAC is automatic. */
export function StepNetwork({ form, patch, errors, data, disabled }: StepProps) {
  const vlanError = typedError(form.vlanText, errors.vlan);
  const bridges = data.bridges;

  return (
    <div className="flex flex-col gap-4">
      <CheckRow
        label="No network device"
        checked={form.noNet}
        onChange={(noNet) => patch({ noNet })}
        disabled={disabled}
        hint="Create the VM without a NIC; add one later from the Hardware tab."
      />

      {!form.noNet && (
        <>
          <Field label="Bridge" hint={bridges !== undefined && bridges.length === 0 ? 'The node\'s bridges could not be listed; type the bridge name.' : undefined}>
            {(id) =>
              bridges !== undefined && bridges.length === 0 ? (
                <Input
                  id={id}
                  value={form.bridge}
                  onChange={(e) => patch({ bridge: e.target.value })}
                  placeholder="vmbr0"
                  autoComplete="off"
                  spellCheck={false}
                  disabled={disabled}
                />
              ) : (
                <NativeSelect
                  id={id}
                  value={form.bridge}
                  onChange={(e) => patch({ bridge: e.target.value })}
                  disabled={disabled || bridges === undefined}
                >
                  {form.bridge === '' && <option value="">Select a bridge</option>}
                  {(bridges ?? []).map((b) => (
                    <option key={b.iface} value={b.iface}>
                      {b.iface}
                      {b.comments ? ` (${b.comments})` : ''}
                    </option>
                  ))}
                </NativeSelect>
              )
            }
          </Field>

          <Field label="Model">
            {(id) => (
              <NativeSelect
                id={id}
                value={form.nicModel}
                onChange={(e) => patch({ nicModel: e.target.value as CreateVmNicModel })}
                disabled={disabled}
              >
                {NIC_MODELS.map((m) => (
                  <option key={m.value} value={m.value}>
                    {m.label}
                  </option>
                ))}
              </NativeSelect>
            )}
          </Field>

          <Field label="VLAN tag (optional)" error={vlanError}>
            {(id) => (
              <Input
                id={id}
                type="number"
                inputMode="numeric"
                min={1}
                max={4094}
                value={form.vlanText}
                onChange={(e) => patch({ vlanText: e.target.value })}
                placeholder="no VLAN"
                disabled={disabled}
                aria-invalid={Boolean(vlanError) || undefined}
              />
            )}
          </Field>

          <CheckRow
            label="Firewall"
            checked={form.firewall}
            onChange={(firewall) => patch({ firewall })}
            disabled={disabled}
          />
          <p className="text-xs text-muted-foreground">The MAC address is generated automatically.</p>
        </>
      )}
    </div>
  );
}
