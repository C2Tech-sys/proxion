import { useId, useState, type KeyboardEvent, type ReactNode } from 'react';
import { Loader2, Plus } from 'lucide-react';

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { NativeSelect } from '@/components/hardware/NativeSelect';
import { hardwareErrorMessage } from '@/api/hardwareHooks';
import { useBridges, useNextNicSlot, useUpsertNic } from '@/api/networkHooks';
import type { NicBody } from '@/api/network';
import {
  QEMU_NIC_MODELS,
  isIPv4,
  isIPv4Cidr,
  isIPv6,
  isIPv6Cidr,
  isUnicastMac,
  isValidBridgeName,
  isValidLxcIfName,
  type NicFields,
} from '@/lib/pve-config';
import type { GuestType } from '@/api/types';

export interface AddNicButtonProps {
  /** When set, the button is disabled and this is its tooltip (same wording as the edit pencils). */
  disabledReason?: string | undefined;
  onClick: () => void;
}

/** The "Add network device" button in the Hardware tab's network section header. */
export function AddNicButton({ disabledReason, onClick }: AddNicButtonProps) {
  const disabled = disabledReason !== undefined;
  return (
    <Button
      variant="outline"
      size="sm"
      className="shrink-0"
      disabled={disabled}
      aria-disabled={disabled || undefined}
      title={disabledReason}
      onClick={onClick}
    >
      <Plus className="size-3.5" />
      Add network device
    </Button>
  );
}

export interface EditNicDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  node: string;
  type: GuestType;
  vmid: number;
  /** The device being edited (its config key + parsed fields). Omit to add a new device: the
   * dialog then asks the server for the next free `net<n>` slot. */
  nic?: NicFields | undefined;
}

type Ipv4Mode = 'none' | 'dhcp' | 'static' | 'manual';
type Ipv6Mode = 'none' | 'auto' | 'dhcp' | 'static' | 'manual';

const DEFAULT_BRIDGE = 'vmbr0';

function ipv4ModeOf(ip: string | undefined): Ipv4Mode {
  if (ip === undefined || ip === '') return 'none';
  if (ip === 'dhcp' || ip === 'manual') return ip;
  return 'static';
}

function ipv6ModeOf(ip6: string | undefined): Ipv6Mode {
  if (ip6 === undefined || ip6 === '') return 'none';
  if (ip6 === 'auto' || ip6 === 'dhcp' || ip6 === 'manual') return ip6;
  return 'static';
}

/** Whole-number text within `[min, max]`; blank is fine (the field is optional). */
function intFieldError(text: string, min: number, max: number, what: string): string | undefined {
  const trimmed = text.trim();
  if (trimmed === '') return undefined;
  if (!/^\d+$/.test(trimmed)) return `${what} must be a whole number.`;
  const n = Number(trimmed);
  return n >= min && n <= max ? undefined : `${what} must be between ${min} and ${max}.`;
}

function rateFieldError(text: string): string | undefined {
  const trimmed = text.trim();
  if (trimmed === '') return undefined;
  if (!/^\d+(\.\d+)?$/.test(trimmed)) return 'Rate limit must be a number of MB/s.';
  const n = Number(trimmed);
  return n > 0 && n <= 100000 ? undefined : 'Rate limit must be greater than 0 and at most 100000 MB/s.';
}

function Field({ label, htmlFor, error, hint, children }: {
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

function CheckField({ id, label, checked, onChange, disabled }: {
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

/**
 * Adds or edits one network device (`net<n>`) on a qemu VM or an lxc container.
 *
 * qemu: model, bridge, VLAN tag, firewall, rate limit, disconnect (`link_down`) and MTU; lxc:
 * interface name, bridge, IPv4 (DHCP / static CIDR + gateway / manual), IPv6 (auto / DHCP /
 * static + gateway / manual), VLAN tag, firewall, rate limit and MTU. A new device defaults to
 * VirtIO on `vmbr0` with the firewall on and a Proxmox-generated MAC (an "override" toggle pins
 * one); an existing device shows its MAC read-only and never sends it, so an edit can't change it.
 *
 * The request is the device's FULL desired state: the server drops every field an edit leaves out.
 * Validation mirrors the server's (`networkRoutes.ts`), shown inline; a server error stays inline
 * and the dialog stays open.
 *
 * Mount it fresh per open (the Hardware tab renders it conditionally).
 */
export function EditNicDialog({ open, onOpenChange, node, type, vmid, nic }: EditNicDialogProps) {
  const id = useId();
  const isNew = nic === undefined;
  const mutation = useUpsertNic();
  const bridges = useBridges(node);
  const nextSlot = useNextNicSlot(node, type, vmid, isNew);

  const slot = nic?.key ?? nextSlot.data;
  const slotNumber = slot?.slice(3) ?? '0';
  const isQemu = type === 'qemu';

  // `undefined` = untouched: the field shows its derived default (which can depend on data that
  // loads after the dialog opens -- the bridge list, the next free slot).
  const [model, setModel] = useState(nic?.model ?? 'virtio');
  const [bridge, setBridge] = useState<string | undefined>(nic?.bridge);
  const [name, setName] = useState<string | undefined>(nic?.name);
  const [vlanText, setVlanText] = useState(nic?.vlan !== undefined ? String(nic.vlan) : '');
  const [firewall, setFirewall] = useState(nic?.firewall ?? true);
  const [overrideMac, setOverrideMac] = useState(false);
  const [macText, setMacText] = useState('');
  const [rateText, setRateText] = useState(nic?.rate !== undefined ? String(nic.rate) : '');
  const [linkDown, setLinkDown] = useState(nic?.linkDown ?? false);
  const [mtuText, setMtuText] = useState(nic?.mtu !== undefined ? String(nic.mtu) : '');
  const [ip4Mode, setIp4Mode] = useState<Ipv4Mode>(isNew ? 'dhcp' : ipv4ModeOf(nic?.ip));
  const [ip4Text, setIp4Text] = useState(ipv4ModeOf(nic?.ip) === 'static' ? (nic?.ip ?? '') : '');
  const [gw4Text, setGw4Text] = useState(nic?.gw ?? '');
  const [ip6Mode, setIp6Mode] = useState<Ipv6Mode>(ipv6ModeOf(nic?.ip6));
  const [ip6Text, setIp6Text] = useState(ipv6ModeOf(nic?.ip6) === 'static' ? (nic?.ip6 ?? '') : '');
  const [gw6Text, setGw6Text] = useState(nic?.gw6 ?? '');

  const bridgeNames = (bridges.data ?? []).map((b) => b.iface);
  const defaultBridge = bridgeNames.includes(DEFAULT_BRIDGE) ? DEFAULT_BRIDGE : (bridgeNames[0] ?? DEFAULT_BRIDGE);
  const effectiveBridge = bridge ?? defaultBridge;
  const effectiveName = name ?? `eth${slotNumber}`;
  // The device's current bridge/model is always an option, even if the lookup doesn't list it.
  const bridgeOptions = effectiveBridge !== '' && !bridgeNames.includes(effectiveBridge) && nic?.bridge !== undefined
    ? [...bridgeNames, nic.bridge]
    : bridgeNames;
  const modelOptions: string[] = (QEMU_NIC_MODELS as readonly string[]).includes(model)
    ? [...QEMU_NIC_MODELS]
    : [model, ...QEMU_NIC_MODELS];
  // No list (the lookup failed, or the node reports no bridges): fall back to a free-text field.
  const useBridgeSelect = bridges.isLoading || bridgeNames.length > 0;

  const errors = {
    bridge: isValidBridgeName(effectiveBridge) ? undefined : 'Enter a valid bridge name (e.g. vmbr0).',
    name: !isQemu && !isValidLxcIfName(effectiveName) ? 'The interface name must look like eth0.' : undefined,
    vlan: intFieldError(vlanText, 1, 4094, 'VLAN tag'),
    rate: rateFieldError(rateText),
    mtu: intFieldError(mtuText, 576, 65520, 'MTU'),
    mac: overrideMac && !isUnicastMac(macText.trim()) ? 'Enter a unicast MAC like BC:24:11:AA:BB:CC.' : undefined,
    ip4: !isQemu && ip4Mode === 'static' && !isIPv4Cidr(ip4Text.trim()) ? 'Enter an address with prefix, e.g. 10.0.0.5/24.' : undefined,
    gw4:
      !isQemu && ip4Mode === 'static' && gw4Text.trim() !== '' && !isIPv4(gw4Text.trim())
        ? 'Enter a valid IPv4 gateway.'
        : undefined,
    ip6: !isQemu && ip6Mode === 'static' && !isIPv6Cidr(ip6Text.trim()) ? 'Enter an address with prefix, e.g. fd00::5/64.' : undefined,
    gw6:
      !isQemu && ip6Mode === 'static' && gw6Text.trim() !== '' && !isIPv6(gw6Text.trim())
        ? 'Enter a valid IPv6 gateway.'
        : undefined,
  };
  const valid = Object.values(errors).every((e) => e === undefined);
  const canSave = valid && slot !== undefined && !mutation.isPending;

  const serverError = mutation.isError
    ? hardwareErrorMessage(mutation.error, 'The network device could not be saved.')
    : undefined;
  const slotError = isNew && nextSlot.isError ? hardwareErrorMessage(nextSlot.error, 'No free network slot was found.') : undefined;

  function buildBody(): NicBody {
    const body: NicBody = { bridge: effectiveBridge };
    if (isQemu) {
      body.model = model;
    } else {
      body.name = effectiveName;
      if (ip4Mode === 'dhcp' || ip4Mode === 'manual') body.ip = ip4Mode;
      if (ip4Mode === 'static') {
        body.ip = ip4Text.trim();
        if (gw4Text.trim() !== '') body.gw = gw4Text.trim();
      }
      if (ip6Mode === 'auto' || ip6Mode === 'dhcp' || ip6Mode === 'manual') body.ip6 = ip6Mode;
      if (ip6Mode === 'static') {
        body.ip6 = ip6Text.trim();
        if (gw6Text.trim() !== '') body.gw6 = gw6Text.trim();
      }
    }
    if (overrideMac) body.mac = macText.trim();
    if (vlanText.trim() !== '') body.vlan = Number(vlanText.trim());
    if (firewall) body.firewall = true;
    if (rateText.trim() !== '') body.rateMbps = Number(rateText.trim());
    if (isQemu && linkDown) body.linkDown = true;
    if (mtuText.trim() !== '') body.mtu = Number(mtuText.trim());
    return body;
  }

  function submit() {
    if (!canSave || slot === undefined) return;
    mutation.mutate({ node, type, vmid, slot, body: buildBody() }, { onSuccess: () => onOpenChange(false) });
  }

  function onKeyDown(event: KeyboardEvent<HTMLElement>) {
    if (event.key === 'Enter' && event.target instanceof HTMLInputElement) {
      event.preventDefault();
      submit();
    }
  }

  const busy = mutation.isPending;

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
          <DialogTitle>
            {isNew ? 'Add network device' : 'Edit network device'}
            {slot !== undefined ? ` (${slot})` : ''}
          </DialogTitle>
          <DialogDescription>
            {isNew
              ? 'Attach this guest to a bridge. The interface appears as a new network adapter.'
              : 'Changes replace the whole device configuration. Its MAC address stays the same.'}
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-4">
          {isQemu ? (
            <Field label="Model" htmlFor={`${id}-model`}>
              <NativeSelect id={`${id}-model`} value={model} onChange={(e) => setModel(e.target.value)} disabled={busy}>
                {modelOptions.map((m) => (
                  <option key={m} value={m}>
                    {m === 'virtio' ? 'VirtIO (paravirtualized)' : m}
                  </option>
                ))}
              </NativeSelect>
            </Field>
          ) : (
            <Field label="Interface name" htmlFor={`${id}-name`} error={errors.name}>
              <Input
                id={`${id}-name`}
                value={effectiveName}
                onChange={(e) => setName(e.target.value)}
                disabled={busy}
                aria-invalid={errors.name !== undefined || undefined}
                autoComplete="off"
              />
            </Field>
          )}

          <Field label="Bridge" htmlFor={`${id}-bridge`} error={errors.bridge}>
            {useBridgeSelect ? (
              <NativeSelect
                id={`${id}-bridge`}
                value={effectiveBridge}
                onChange={(e) => setBridge(e.target.value)}
                disabled={busy || bridges.isLoading}
              >
                {bridges.isLoading && <option value={effectiveBridge}>Loading bridges...</option>}
                {bridgeOptions.map((b) => {
                  const info = bridges.data?.find((x) => x.iface === b);
                  return (
                    <option key={b} value={b}>
                      {info?.comments ? `${b} (${info.comments})` : b}
                    </option>
                  );
                })}
              </NativeSelect>
            ) : (
              <Input
                id={`${id}-bridge`}
                value={effectiveBridge}
                onChange={(e) => setBridge(e.target.value)}
                disabled={busy}
                aria-invalid={errors.bridge !== undefined || undefined}
                placeholder={DEFAULT_BRIDGE}
                autoComplete="off"
              />
            )}
          </Field>

          {!isQemu && (
            <>
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
                  <option value="manual">Manual</option>
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
                  <option value="manual">Manual</option>
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
            </>
          )}

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Field label="VLAN tag" htmlFor={`${id}-vlan`} error={errors.vlan} hint="Optional, 1-4094.">
              <Input
                id={`${id}-vlan`}
                type="number"
                inputMode="numeric"
                min={1}
                max={4094}
                value={vlanText}
                onChange={(e) => setVlanText(e.target.value)}
                disabled={busy}
                aria-invalid={errors.vlan !== undefined || undefined}
              />
            </Field>
            <Field label="Rate limit (MB/s)" htmlFor={`${id}-rate`} error={errors.rate} hint="Optional; blank is unlimited.">
              <Input
                id={`${id}-rate`}
                type="number"
                inputMode="decimal"
                min={0}
                step="any"
                value={rateText}
                onChange={(e) => setRateText(e.target.value)}
                disabled={busy}
                aria-invalid={errors.rate !== undefined || undefined}
              />
            </Field>
            <Field label="MTU" htmlFor={`${id}-mtu`} error={errors.mtu} hint="Optional, 576-65520.">
              <Input
                id={`${id}-mtu`}
                type="number"
                inputMode="numeric"
                min={576}
                max={65520}
                value={mtuText}
                onChange={(e) => setMtuText(e.target.value)}
                disabled={busy}
                aria-invalid={errors.mtu !== undefined || undefined}
              />
            </Field>
            <div className="flex flex-col gap-1.5">
              <span className="text-sm font-medium">MAC address</span>
              {isNew ? (
                <>
                  <span className="text-sm text-muted-foreground" data-testid="nic-mac-display">
                    {overrideMac ? 'Custom' : 'Auto (generated by Proxmox)'}
                  </span>
                  <CheckField
                    id={`${id}-mac-override`}
                    label="Override"
                    checked={overrideMac}
                    onChange={setOverrideMac}
                    disabled={busy}
                  />
                </>
              ) : (
                <span className="text-sm" data-testid="nic-mac-display">
                  {nic?.mac ?? 'Auto'}
                </span>
              )}
            </div>
          </div>

          {isNew && overrideMac && (
            <Field label="Custom MAC address" htmlFor={`${id}-mac`} error={errors.mac}>
              <Input
                id={`${id}-mac`}
                value={macText}
                onChange={(e) => setMacText(e.target.value)}
                disabled={busy}
                aria-invalid={errors.mac !== undefined || undefined}
                placeholder="BC:24:11:AA:BB:CC"
                autoComplete="off"
              />
            </Field>
          )}

          <div className="flex flex-col gap-2">
            <CheckField id={`${id}-firewall`} label="Firewall" checked={firewall} onChange={setFirewall} disabled={busy} />
            {isQemu && (
              <CheckField
                id={`${id}-linkdown`}
                label="Disconnect"
                checked={linkDown}
                onChange={setLinkDown}
                disabled={busy}
              />
            )}
          </div>

          {(serverError ?? slotError) && (
            <p role="alert" className="text-xs text-status-error">
              {serverError ?? slotError}
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
