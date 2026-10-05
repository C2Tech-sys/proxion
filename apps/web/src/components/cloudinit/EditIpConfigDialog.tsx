import { useId, useState, type KeyboardEvent, type ReactNode } from 'react';
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
import { NativeSelect } from '@/components/hardware/NativeSelect';
import { useUpdateCloudInit } from '@/api/cloudInitHooks';
import { hardwareErrorMessage } from '@/api/hardwareHooks';
import { isIPv4, isIPv4Cidr, isIPv6, isIPv6Cidr, parseIpConfig, type IpConfigFields } from '@/lib/pve-config';

export interface EditIpConfigDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  node: string;
  vmid: number;
  /** `net0`, `net1`, ... */
  slot: string;
  /** The current `ipconfig<n>` value, if the guest has one. */
  current: string | undefined;
}

type Ipv4Mode = 'none' | 'dhcp' | 'static';
type Ipv6Mode = 'none' | 'auto' | 'dhcp' | 'static';

function ipv4ModeOf(ip: string | undefined): Ipv4Mode {
  if (ip === undefined || ip === '') return 'none';
  return ip === 'dhcp' ? 'dhcp' : 'static';
}

function ipv6ModeOf(ip6: string | undefined): Ipv6Mode {
  if (ip6 === undefined || ip6 === '') return 'none';
  return ip6 === 'auto' || ip6 === 'dhcp' ? ip6 : 'static';
}

function Field({ label, htmlFor, error, children }: {
  label: string;
  htmlFor: string;
  error?: string | undefined;
  children: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={htmlFor} className="text-sm font-medium">
        {label}
      </label>
      {children}
      {error && <p className="text-xs text-status-error">{error}</p>}
    </div>
  );
}

/**
 * Edits one NIC's cloud-init address settings (`ipconfig<n>`): IPv4 (not configured / DHCP /
 * static + optional gateway) and IPv6 (not configured / SLAAC / DHCP / static + optional gateway).
 * Choosing "not configured" for both removes the `ipconfig<n>` entry. The request is the NIC's
 * FULL desired state: the server drops every field this leaves out.
 *
 * Mount it fresh per open (the Cloud-Init tab renders it conditionally).
 */
export function EditIpConfigDialog({ open, onOpenChange, node, vmid, slot, current }: EditIpConfigDialogProps) {
  const id = useId();
  const mutation = useUpdateCloudInit();
  const busy = mutation.isPending;
  const initial = parseIpConfig(current);

  const [ip4Mode, setIp4Mode] = useState<Ipv4Mode>(ipv4ModeOf(initial.ip));
  const [ip4Text, setIp4Text] = useState(ipv4ModeOf(initial.ip) === 'static' ? (initial.ip ?? '') : '');
  const [gw4Text, setGw4Text] = useState(initial.gw ?? '');
  const [ip6Mode, setIp6Mode] = useState<Ipv6Mode>(ipv6ModeOf(initial.ip6));
  const [ip6Text, setIp6Text] = useState(ipv6ModeOf(initial.ip6) === 'static' ? (initial.ip6 ?? '') : '');
  const [gw6Text, setGw6Text] = useState(initial.gw6 ?? '');

  const errors = {
    ip4: ip4Mode === 'static' && !isIPv4Cidr(ip4Text.trim()) ? 'Enter an address with prefix, e.g. 10.0.0.5/24.' : undefined,
    gw4:
      ip4Mode === 'static' && gw4Text.trim() !== '' && !isIPv4(gw4Text.trim()) ? 'Enter a valid IPv4 gateway.' : undefined,
    ip6: ip6Mode === 'static' && !isIPv6Cidr(ip6Text.trim()) ? 'Enter an address with prefix, e.g. fd00::5/64.' : undefined,
    gw6:
      ip6Mode === 'static' && gw6Text.trim() !== '' && !isIPv6(gw6Text.trim()) ? 'Enter a valid IPv6 gateway.' : undefined,
  };
  const valid = Object.values(errors).every((e) => e === undefined);

  function buildFields(): IpConfigFields {
    const fields: IpConfigFields = {};
    if (ip4Mode === 'dhcp') fields.ip = 'dhcp';
    if (ip4Mode === 'static') {
      fields.ip = ip4Text.trim();
      if (gw4Text.trim() !== '') fields.gw = gw4Text.trim();
    }
    if (ip6Mode === 'auto' || ip6Mode === 'dhcp') fields.ip6 = ip6Mode;
    if (ip6Mode === 'static') {
      fields.ip6 = ip6Text.trim();
      if (gw6Text.trim() !== '') fields.gw6 = gw6Text.trim();
    }
    return fields;
  }

  const fields = buildFields();
  const empty = Object.keys(fields).length === 0;
  // Nothing to remove and nothing chosen: there is nothing to save.
  const unchanged = empty && current === undefined;
  const canSave = valid && !unchanged && !busy;

  const serverError = mutation.isError
    ? hardwareErrorMessage(mutation.error, 'The IP configuration could not be saved.')
    : undefined;

  function submit() {
    if (!canSave) return;
    mutation.mutate(
      { node, vmid, body: { ipconfig: { [slot]: empty ? null : fields } } },
      { onSuccess: () => onOpenChange(false) },
    );
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
          <DialogTitle>Edit IP config ({slot})</DialogTitle>
          <DialogDescription>
            The address cloud-init configures on this network device. A gateway needs a static address.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-4">
          <Field label="IPv4" htmlFor={`${id}-ip4`}>
            <NativeSelect
              id={`${id}-ip4`}
              value={ip4Mode}
              onChange={(e) => setIp4Mode(e.target.value as Ipv4Mode)}
              disabled={busy}
            >
              <option value="none">Not configured</option>
              <option value="dhcp">DHCP</option>
              <option value="static">Static</option>
            </NativeSelect>
          </Field>
          {ip4Mode === 'static' && (
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <Field label="IPv4 address (CIDR)" htmlFor={`${id}-ip4-cidr`} error={errors.ip4}>
                <Input
                  id={`${id}-ip4-cidr`}
                  value={ip4Text}
                  onChange={(e) => setIp4Text(e.target.value)}
                  disabled={busy}
                  aria-invalid={errors.ip4 !== undefined || undefined}
                  placeholder="10.0.0.5/24"
                  autoComplete="off"
                />
              </Field>
              <Field label="IPv4 gateway" htmlFor={`${id}-gw4`} error={errors.gw4}>
                <Input
                  id={`${id}-gw4`}
                  value={gw4Text}
                  onChange={(e) => setGw4Text(e.target.value)}
                  disabled={busy}
                  aria-invalid={errors.gw4 !== undefined || undefined}
                  placeholder="10.0.0.1"
                  autoComplete="off"
                />
              </Field>
            </div>
          )}

          <Field label="IPv6" htmlFor={`${id}-ip6`}>
            <NativeSelect
              id={`${id}-ip6`}
              value={ip6Mode}
              onChange={(e) => setIp6Mode(e.target.value as Ipv6Mode)}
              disabled={busy}
            >
              <option value="none">Not configured</option>
              <option value="auto">SLAAC (auto)</option>
              <option value="dhcp">DHCP</option>
              <option value="static">Static</option>
            </NativeSelect>
          </Field>
          {ip6Mode === 'static' && (
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <Field label="IPv6 address (CIDR)" htmlFor={`${id}-ip6-cidr`} error={errors.ip6}>
                <Input
                  id={`${id}-ip6-cidr`}
                  value={ip6Text}
                  onChange={(e) => setIp6Text(e.target.value)}
                  disabled={busy}
                  aria-invalid={errors.ip6 !== undefined || undefined}
                  placeholder="fd00::5/64"
                  autoComplete="off"
                />
              </Field>
              <Field label="IPv6 gateway" htmlFor={`${id}-gw6`} error={errors.gw6}>
                <Input
                  id={`${id}-gw6`}
                  value={gw6Text}
                  onChange={(e) => setGw6Text(e.target.value)}
                  disabled={busy}
                  aria-invalid={errors.gw6 !== undefined || undefined}
                  placeholder="fd00::1"
                  autoComplete="off"
                />
              </Field>
            </div>
          )}

          {serverError && (
            <p role="alert" className="text-xs text-status-error">
              {serverError}
            </p>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" disabled={busy} onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button disabled={!canSave} onClick={submit}>
            {busy && <Loader2 className="size-4 animate-spin" />}
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
