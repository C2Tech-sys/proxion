import { useState } from 'react';
import { Loader2 } from 'lucide-react';

import { Panel } from '@/components/Panel';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { NativeSelect } from '@/components/hardware/NativeSelect';
import { FirewallSwitch } from '@/components/firewall/FirewallSwitch';
import { ConfirmDialog, Field } from '@/components/clusterfirewall/shared';
import { hardwareErrorMessage } from '@/api/hardwareHooks';
import { useUpdateClusterOptions } from '@/api/clusterFirewallHooks';
import { RATE_UNITS, type ClusterFirewallOptions, type ClusterOptionsPatch, type RateUnit } from '@/api/clusterFirewall';
import { FIREWALL_VERDICTS, type FirewallVerdict } from '@/api/firewall';

export interface ClusterOptionsCardProps {
  options: ClusterFirewallOptions;
  /** When set, every control is disabled and this is its tooltip. */
  disabledReason: string | undefined;
}

/** PVE's own defaults for an unset policy. */
const DEFAULT_POLICY_IN: FirewallVerdict = 'DROP';
const DEFAULT_POLICY_OUT: FirewallVerdict = 'ACCEPT';
const DEFAULT_BURST = 5;
const DEFAULT_RATE = 1;
const DEFAULT_UNIT: RateUnit = 'second';

export const ENABLE_CONFIRM_WORD = 'ENABLE';
export const ENABLE_LOCKOUT_WARNING =
  'Enabling the datacenter firewall with an inbound DROP policy can lock you out of every node; make sure a rule allows your management traffic first.';

interface OptionsForm {
  policyIn: FirewallVerdict;
  policyOut: FirewallVerdict;
  ebtables: boolean;
  limitEnabled: boolean;
  burst: string;
  rate: string;
  unit: RateUnit;
}

function parseRate(rate: string | undefined): { rate: string; unit: RateUnit } {
  const match = /^(\d+)\/(second|minute|hour|day)$/.exec(rate ?? '');
  return match ? { rate: match[1]!, unit: match[2] as RateUnit } : { rate: String(DEFAULT_RATE), unit: DEFAULT_UNIT };
}

function formFromOptions(options: ClusterFirewallOptions): OptionsForm {
  const { rate, unit } = parseRate(options.logRatelimit.rate);
  return {
    policyIn: options.policy_in ?? DEFAULT_POLICY_IN,
    policyOut: options.policy_out ?? DEFAULT_POLICY_OUT,
    ebtables: options.ebtables,
    limitEnabled: options.logRatelimit.enabled,
    burst: String(options.logRatelimit.burst ?? DEFAULT_BURST),
    rate,
    unit,
  };
}

const NUMBER_RE = /^\d+$/;

function validate(form: OptionsForm): { burst?: string; rate?: string } {
  const errors: { burst?: string; rate?: string } = {};
  if (!NUMBER_RE.test(form.burst)) errors.burst = 'A whole number, 0 or more.';
  if (!NUMBER_RE.test(form.rate) || Number(form.rate) < 1) errors.rate = 'A whole number, 1 or more.';
  return errors;
}

/** Only what differs from the options as read; the rate limit goes out whole when any part changed. */
function buildPatch(form: OptionsForm, options: ClusterFirewallOptions): ClusterOptionsPatch | undefined {
  const before = formFromOptions(options);
  const patch: ClusterOptionsPatch = {};
  if (form.policyIn !== before.policyIn) patch.policy_in = form.policyIn;
  if (form.policyOut !== before.policyOut) patch.policy_out = form.policyOut;
  if (form.ebtables !== before.ebtables) patch.ebtables = form.ebtables;
  if (
    form.limitEnabled !== before.limitEnabled ||
    form.burst !== before.burst ||
    form.rate !== before.rate ||
    form.unit !== before.unit
  ) {
    patch.log_ratelimit = {
      enabled: form.limitEnabled,
      burst: Number(form.burst),
      rate: `${Number(form.rate)}/${form.unit}`,
    };
  }
  if (Object.keys(patch).length === 0) return undefined;
  if (options.digest !== undefined) patch.digest = options.digest;
  return patch;
}

/**
 * The datacenter firewall options as one card. The master switch saves on its own; turning it ON
 * asks for the word ENABLE first, since an enabled firewall with an inbound DROP policy and no rule
 * for the caller's own traffic locks them out of every node. The policies, ebtables and the log
 * rate limit are edited together and saved with one button (only the keys that changed are sent,
 * with the digest of the last read, so a concurrent change is rejected rather than overwritten).
 */
export function ClusterOptionsCard({ options, disabledReason }: ClusterOptionsCardProps) {
  const mutation = useUpdateClusterOptions();
  const [confirmEnable, setConfirmEnable] = useState(false);
  const [form, setForm] = useState<OptionsForm>(() => formFromOptions(options));
  const locked = disabledReason !== undefined;
  const set = <K extends keyof OptionsForm>(key: K, value: OptionsForm[K]) => setForm((prev) => ({ ...prev, [key]: value }));

  const errors = validate(form);
  const patch = buildPatch(form, options);
  const canSave = !locked && !mutation.isPending && patch !== undefined && Object.keys(errors).length === 0;
  const busy = mutation.isPending;

  function toggleEnable(next: boolean) {
    if (next) {
      mutation.reset();
      setConfirmEnable(true);
      return;
    }
    mutation.mutate({
      patch: { enable: false, ...(options.digest !== undefined ? { digest: options.digest } : {}) },
      successMessage: 'Datacenter firewall disabled',
    });
  }

  function confirmEnabling() {
    mutation.mutate(
      {
        patch: { enable: true, ...(options.digest !== undefined ? { digest: options.digest } : {}) },
        successMessage: 'Datacenter firewall enabled',
      },
      { onSuccess: () => setConfirmEnable(false) },
    );
  }

  function save() {
    if (!canSave || patch === undefined) return;
    mutation.mutate({ patch });
  }

  return (
    <div data-testid="dc-fw-options">
      <Panel
        title="Options"
        action={
          <Button size="sm" disabled={!canSave} title={disabledReason} onClick={save}>
            {busy && !confirmEnable && <Loader2 className="size-4 animate-spin" />}
            Save options
          </Button>
        }
      >
        <div className="flex flex-col gap-4">
          <FirewallSwitch
            label="Enable firewall"
            hint="Switches the firewall on for the whole datacenter"
            checked={options.enable}
            disabled={locked || busy}
            title={disabledReason}
            onCheckedChange={toggleEnable}
          />

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Field label="Input policy" htmlFor="dc-fw-policy-in" hint="Applies to inbound traffic no rule matches.">
              <NativeSelect
                id="dc-fw-policy-in"
                value={form.policyIn}
                onChange={(e) => set('policyIn', e.target.value as FirewallVerdict)}
                disabled={locked || busy}
                title={disabledReason}
              >
                {FIREWALL_VERDICTS.map((v) => (
                  <option key={v} value={v}>
                    {v}
                  </option>
                ))}
              </NativeSelect>
            </Field>
            <Field label="Output policy" htmlFor="dc-fw-policy-out" hint="Applies to outbound traffic no rule matches.">
              <NativeSelect
                id="dc-fw-policy-out"
                value={form.policyOut}
                onChange={(e) => set('policyOut', e.target.value as FirewallVerdict)}
                disabled={locked || busy}
                title={disabledReason}
              >
                {FIREWALL_VERDICTS.map((v) => (
                  <option key={v} value={v}>
                    {v}
                  </option>
                ))}
              </NativeSelect>
            </Field>
          </div>

          <FirewallSwitch
            label="ebtables"
            hint="Filter layer-2 (bridge) traffic"
            checked={form.ebtables}
            disabled={locked || busy}
            title={disabledReason}
            onCheckedChange={(checked) => set('ebtables', checked)}
          />

          <FirewallSwitch
            label="Log rate limit"
            hint="Limit how fast firewall events are logged"
            checked={form.limitEnabled}
            disabled={locked || busy}
            title={disabledReason}
            onCheckedChange={(checked) => set('limitEnabled', checked)}
          />
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
            <Field label="Burst" htmlFor="dc-fw-burst" error={errors.burst}>
              <Input
                id="dc-fw-burst"
                inputMode="numeric"
                value={form.burst}
                onChange={(e) => set('burst', e.target.value.trim())}
                disabled={locked || busy || !form.limitEnabled}
                aria-invalid={errors.burst !== undefined || undefined}
                autoComplete="off"
              />
            </Field>
            <Field label="Rate" htmlFor="dc-fw-rate" error={errors.rate}>
              <Input
                id="dc-fw-rate"
                inputMode="numeric"
                value={form.rate}
                onChange={(e) => set('rate', e.target.value.trim())}
                disabled={locked || busy || !form.limitEnabled}
                aria-invalid={errors.rate !== undefined || undefined}
                autoComplete="off"
              />
            </Field>
            <Field label="Per" htmlFor="dc-fw-unit">
              <NativeSelect
                id="dc-fw-unit"
                value={form.unit}
                onChange={(e) => set('unit', e.target.value as RateUnit)}
                disabled={locked || busy || !form.limitEnabled}
              >
                {RATE_UNITS.map((u) => (
                  <option key={u} value={u}>
                    {u}
                  </option>
                ))}
              </NativeSelect>
            </Field>
          </div>

          {mutation.isError && !confirmEnable && (
            <p role="alert" className="text-xs text-status-error">
              {hardwareErrorMessage(mutation.error, 'The firewall options could not be saved.')}
            </p>
          )}
        </div>
      </Panel>

      {confirmEnable && (
        <ConfirmDialog
          open
          onOpenChange={(open) => !open && setConfirmEnable(false)}
          title="Enable the datacenter firewall?"
          description={ENABLE_LOCKOUT_WARNING}
          confirmLabel="Enable firewall"
          typedWord={ENABLE_CONFIRM_WORD}
          pending={mutation.isPending}
          error={mutation.isError ? hardwareErrorMessage(mutation.error, 'The firewall could not be enabled.') : undefined}
          onConfirm={confirmEnabling}
        />
      )}
    </div>
  );
}
