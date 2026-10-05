import { useState } from 'react';
import { toast } from 'sonner';

import { Panel } from '@/components/Panel';
import { NativeSelect } from '@/components/hardware/NativeSelect';
import { FirewallSwitch } from '@/components/firewall/FirewallSwitch';
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
import { hardwareErrorMessage } from '@/api/hardwareHooks';
import { useUpdateFirewallOptions } from '@/api/firewallHooks';
import {
  FIREWALL_LOG_LEVELS,
  FIREWALL_VERDICTS,
  type FirewallLogLevel,
  type FirewallOptions,
  type FirewallOptionsPatch,
  type FirewallVerdict,
} from '@/api/firewall';
import type { GuestType } from '@/api/types';

export interface FirewallOptionsCardProps {
  node: string;
  type: GuestType;
  vmid: number;
  options: FirewallOptions;
  /** When set, every control is disabled and this is its tooltip. */
  disabledReason?: string | undefined;
}

/** PVE's own default for an unset input policy (the datacenter's default, `DROP` out of the box). */
const DEFAULT_POLICY_IN: FirewallVerdict = 'DROP';

const SWITCHES: Array<{ key: 'dhcp' | 'ndp' | 'radv' | 'macfilter' | 'ipfilter'; label: string; hint: string }> = [
  { key: 'dhcp', label: 'DHCP', hint: 'Allow DHCP traffic' },
  { key: 'ndp', label: 'NDP', hint: 'Allow neighbour discovery' },
  { key: 'radv', label: 'Router Advertisement', hint: 'Allow sending router advertisements' },
  { key: 'macfilter', label: 'MAC filter', hint: 'Drop traffic with a foreign source MAC' },
  { key: 'ipfilter', label: 'IP filter', hint: 'Restrict source IPs to the guest\'s own' },
];

/**
 * The guest's firewall options as one card. Each control saves on its own (a single key per
 * request, with the digest of the last read, so a concurrent change is rejected rather than
 * overwritten); every control waits while a save and the re-read behind it are in flight.
 *
 * Turning the firewall on while the input policy is DROP (or REJECT) is the one change that can
 * cut off the caller's own access, so it asks first.
 */
export function FirewallOptionsCard({ node, type, vmid, options, disabledReason }: FirewallOptionsCardProps) {
  const mutation = useUpdateFirewallOptions();
  const [confirmEnable, setConfirmEnable] = useState(false);
  const locked = disabledReason !== undefined;
  const busy = mutation.isPending;
  const disabled = locked || busy;
  const policyIn = options.policy_in ?? DEFAULT_POLICY_IN;

  function save(patch: FirewallOptionsPatch) {
    mutation.mutate(
      { node, type, vmid, patch: { ...patch, ...(options.digest !== undefined ? { digest: options.digest } : {}) } },
      {
        onError: (error) => toast.error(hardwareErrorMessage(error, 'The firewall options could not be saved.')),
      },
    );
  }

  function toggleEnable(next: boolean) {
    if (next && policyIn !== 'ACCEPT') {
      setConfirmEnable(true);
      return;
    }
    save({ enable: next });
  }

  return (
    <Panel title="Options" className="mb-4">
      <div className="grid grid-cols-1 gap-x-8 gap-y-3 md:grid-cols-2">
        <FirewallSwitch
          label="Firewall"
          hint={options.enable ? 'Rules and policies are enforced' : 'Rules and policies are not enforced'}
          checked={options.enable}
          onCheckedChange={toggleEnable}
          disabled={disabled}
          title={disabledReason}
        />
        {SWITCHES.map((item) => (
          <FirewallSwitch
            key={item.key}
            label={item.label}
            hint={item.hint}
            checked={options[item.key]}
            onCheckedChange={(next) => save({ [item.key]: next })}
            disabled={disabled}
            title={disabledReason}
          />
        ))}
      </div>

      <div className="mt-4 grid grid-cols-1 gap-4 border-t border-border pt-4 sm:grid-cols-2 lg:grid-cols-4">
        <PolicySelect
          label="Input policy"
          value={options.policy_in}
          disabled={disabled}
          title={disabledReason}
          onChange={(value) => save({ policy_in: value })}
        />
        <PolicySelect
          label="Output policy"
          value={options.policy_out}
          disabled={disabled}
          title={disabledReason}
          onChange={(value) => save({ policy_out: value })}
        />
        <LogSelect
          label="Input log level"
          value={options.log_level_in}
          disabled={disabled}
          title={disabledReason}
          onChange={(value) => save({ log_level_in: value })}
        />
        <LogSelect
          label="Output log level"
          value={options.log_level_out}
          disabled={disabled}
          title={disabledReason}
          onChange={(value) => save({ log_level_out: value })}
        />
      </div>

      <AlertDialog open={confirmEnable} onOpenChange={setConfirmEnable}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Enable the firewall?</AlertDialogTitle>
            <AlertDialogDescription>
              The input policy is {policyIn}: traffic to this guest that no rule accepts will be blocked. That can cut
              your own access (for example SSH or the console). Make sure a rule accepts the ports you use first.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                setConfirmEnable(false);
                save({ enable: true });
              }}
            >
              Enable firewall
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Panel>
  );
}

function PolicySelect({
  label,
  value,
  disabled,
  title,
  onChange,
}: {
  label: string;
  value: FirewallVerdict | undefined;
  disabled: boolean;
  title: string | undefined;
  onChange: (value: FirewallVerdict) => void;
}) {
  return (
    <label className="flex flex-col gap-1.5 text-sm font-medium" title={disabled ? title : undefined}>
      {label}
      <NativeSelect
        value={value ?? ''}
        disabled={disabled}
        title={disabled ? title : undefined}
        onChange={(e) => onChange(e.target.value as FirewallVerdict)}
      >
        {value === undefined && (
          <option value="" disabled>
            Datacenter default
          </option>
        )}
        {FIREWALL_VERDICTS.map((v) => (
          <option key={v} value={v}>
            {v}
          </option>
        ))}
      </NativeSelect>
    </label>
  );
}

function LogSelect({
  label,
  value,
  disabled,
  title,
  onChange,
}: {
  label: string;
  value: FirewallLogLevel | undefined;
  disabled: boolean;
  title: string | undefined;
  onChange: (value: FirewallLogLevel) => void;
}) {
  return (
    <label className="flex flex-col gap-1.5 text-sm font-medium" title={disabled ? title : undefined}>
      {label}
      <NativeSelect
        value={value ?? 'nolog'}
        disabled={disabled}
        title={disabled ? title : undefined}
        onChange={(e) => onChange(e.target.value as FirewallLogLevel)}
      >
        {FIREWALL_LOG_LEVELS.map((level) => (
          <option key={level} value={level}>
            {level}
          </option>
        ))}
      </NativeSelect>
    </label>
  );
}
