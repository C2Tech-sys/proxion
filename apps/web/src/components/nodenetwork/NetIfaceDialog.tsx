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
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { NativeSelect } from '@/components/hardware/NativeSelect';
import { nodeNetworkErrorMessage, useCreateNodeIface, useUpdateNodeIface } from '@/api/nodeNetworkHooks';
import type { CreateNetBody, NodeNetIface, NodeNetType, UpdateNetBody } from '@/api/nodeNetwork';
import { isIPv4, isIPv4Cidr, isIPv6, isIPv6Cidr } from '@/lib/pve-config';
import { NET_KIND_LABEL, type NetCreateKind, type NetIfaceDialogMode } from '@/components/nodenetwork/netKinds';

export interface NetIfaceDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  node: string;
  /** Every interface on the node: names to avoid, and the candidates for ports/slaves/VLAN device. */
  ifaces: readonly NodeNetIface[];
  mode: NetIfaceDialogMode;
}

const BOND_MODES = [
  'balance-rr',
  'active-backup',
  'balance-xor',
  'broadcast',
  '802.3ad',
  'balance-tlb',
  'balance-alb',
] as const;
const HASH_POLICIES = ['layer2', 'layer2+3', 'layer3+4'] as const;
/** The bond modes that spread traffic by a hash, i.e. where the policy matters. */
const HASHED_MODES: readonly string[] = ['balance-xor', '802.3ad', 'balance-tlb'];

const IFACE_RE = /^[A-Za-z0-9._-]{1,15}$/;
const BRIDGE_NAME_RE = /^vmbr\d{1,4}$/;
const PORT_LIST_RE = /^[A-Za-z0-9._ -]*$/;
const MTU_RANGE = [576, 65520] as const;

/** The lowest unused `<prefix><n>`. */
function nextFreeName(prefix: string, ifaces: readonly NodeNetIface[]): string {
  const taken = new Set(ifaces.map((i) => i.iface));
  let n = 0;
  while (taken.has(`${prefix}${n}`)) n += 1;
  return `${prefix}${n}`;
}

function intFieldError(text: string, min: number, max: number, what: string): string | undefined {
  const trimmed = text.trim();
  if (trimmed === '') return undefined;
  if (!/^\d+$/.test(trimmed)) return `${what} must be a whole number.`;
  const n = Number(trimmed);
  return n >= min && n <= max ? undefined : `${what} must be between ${min} and ${max}.`;
}

function Field({
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

function CheckField({
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

/**
 * Creates a Linux bridge / bond / VLAN, or edits an existing interface. A physical interface
 * (`eth`) can only have its addressing, autostart, MTU and comment edited; bridge, bond and VLAN
 * fields appear only for their own type. An edit sends only the fields that changed -- clearing
 * a field that had a value sends `null`, which the server turns into PVE's `delete` list.
 *
 * PVE only stages the change; nothing reaches the live network until the pending configuration is
 * applied from the Network tab's banner. Validation mirrors the server's (`nodeNetworkRoutes.ts`),
 * shown inline; a server error stays inline and the dialog stays open.
 *
 * Mount it fresh per open (the tab renders it conditionally).
 */
export function NetIfaceDialog({ open, onOpenChange, node, ifaces, mode }: NetIfaceDialogProps) {
  const id = useId();
  const isNew = mode.kind === 'create';
  const original = mode.kind === 'edit' ? mode.iface : undefined;
  const type: NodeNetType = mode.kind === 'create' ? mode.type : mode.iface.type;
  const createMutation = useCreateNodeIface();
  const updateMutation = useUpdateNodeIface();
  const mutation = isNew ? createMutation : updateMutation;

  // `undefined` = untouched: the name shows its derived default.
  const [nameText, setNameText] = useState<string | undefined>(undefined);
  const [autostart, setAutostart] = useState(original?.autostart ?? true);
  const [cidrText, setCidrText] = useState(original?.cidr ?? '');
  const [gatewayText, setGatewayText] = useState(original?.gateway ?? '');
  const [cidr6Text, setCidr6Text] = useState(original?.cidr6 ?? '');
  const [gateway6Text, setGateway6Text] = useState(original?.gateway6 ?? '');
  const [mtuText, setMtuText] = useState(original?.mtu !== undefined ? String(original.mtu) : '');
  const [commentText, setCommentText] = useState(original?.comments ?? '');
  const [portsText, setPortsText] = useState(original?.bridgePorts ?? '');
  const [vlanAware, setVlanAware] = useState(original?.vlanAware ?? false);
  const [slavesText, setSlavesText] = useState(original?.slaves ?? '');
  const [bondMode, setBondMode] = useState(original?.bondMode ?? 'active-backup');
  const [hashPolicy, setHashPolicy] = useState(original?.bondXmitHashPolicy ?? '');
  const [primaryText, setPrimaryText] = useState(original?.bondPrimary ?? '');
  const [vlanIdText, setVlanIdText] = useState(original?.vlanId !== undefined ? String(original.vlanId) : '');
  const [rawDevice, setRawDevice] = useState<string | undefined>(original?.vlanRawDevice);

  const vlanDevices = ifaces.filter((i) => i.type !== 'vlan').map((i) => i.iface);
  const effectiveRaw = rawDevice ?? (vlanDevices.includes('vmbr0') ? 'vmbr0' : (vlanDevices[0] ?? ''));
  const derivedName =
    type === 'bridge'
      ? nextFreeName('vmbr', ifaces)
      : type === 'bond'
        ? nextFreeName('bond', ifaces)
        : effectiveRaw !== '' && vlanIdText.trim() !== ''
          ? `${effectiveRaw}.${vlanIdText.trim()}`
          : '';
  const name = original?.iface ?? nameText ?? derivedName;

  const taken = ifaces.some((i) => i.iface === name);
  const mtuNumber = mtuText.trim() === '' ? undefined : Number(mtuText.trim());
  const errors = {
    name: !isNew
      ? undefined
      : !IFACE_RE.test(name)
        ? 'Use 1-15 letters, digits, dots, dashes or underscores.'
        : type === 'bridge' && !BRIDGE_NAME_RE.test(name)
          ? 'A bridge must be named vmbr<number>, e.g. vmbr1.'
          : taken
            ? `${name} already exists.`
            : undefined,
    cidr: cidrText.trim() !== '' && !isIPv4Cidr(cidrText.trim()) ? 'Enter an address with prefix, e.g. 10.0.0.5/24.' : undefined,
    gateway:
      gatewayText.trim() !== '' && !isIPv4(gatewayText.trim())
        ? 'Enter a valid IPv4 gateway.'
        : gatewayText.trim() !== '' && cidrText.trim() === ''
          ? 'A gateway needs an IPv4/CIDR address.'
          : undefined,
    cidr6: cidr6Text.trim() !== '' && !isIPv6Cidr(cidr6Text.trim()) ? 'Enter an address with prefix, e.g. fd00::5/64.' : undefined,
    gateway6:
      gateway6Text.trim() !== '' && !isIPv6(gateway6Text.trim())
        ? 'Enter a valid IPv6 gateway.'
        : gateway6Text.trim() !== '' && cidr6Text.trim() === ''
          ? 'A gateway needs an IPv6/CIDR address.'
          : undefined,
    mtu: intFieldError(mtuText, MTU_RANGE[0], MTU_RANGE[1], 'MTU'),
    comment: commentText.length > 256 ? 'A comment can be at most 256 characters.' : undefined,
    ports: type === 'bridge' && !PORT_LIST_RE.test(portsText) ? 'Use interface names separated by spaces.' : undefined,
    slaves:
      type === 'bond' && (slavesText.trim() === '' || !PORT_LIST_RE.test(slavesText))
        ? 'Enter at least one interface, separated by spaces.'
        : undefined,
    primary: type === 'bond' && primaryText.trim() !== '' && !IFACE_RE.test(primaryText.trim()) ? 'Enter an interface name.' : undefined,
    vlanId: type === 'vlan' ? intFieldError(vlanIdText, 1, 4094, 'VLAN ID') ?? (vlanIdText.trim() === '' ? 'Enter a VLAN ID.' : undefined) : undefined,
    raw: type === 'vlan' && !IFACE_RE.test(effectiveRaw) ? 'Choose the underlying device.' : undefined,
  };
  const valid = Object.values(errors).every((e) => e === undefined);

  function buildCreateBody(): CreateNetBody {
    const body: CreateNetBody = { type: type as NetCreateKind, iface: name, autostart };
    if (cidrText.trim() !== '') body.cidr = cidrText.trim();
    if (gatewayText.trim() !== '') body.gateway = gatewayText.trim();
    if (cidr6Text.trim() !== '') body.cidr6 = cidr6Text.trim();
    if (gateway6Text.trim() !== '') body.gateway6 = gateway6Text.trim();
    if (mtuNumber !== undefined) body.mtu = mtuNumber;
    if (commentText.trim() !== '') body.comments = commentText.trim();
    if (type === 'bridge') {
      if (portsText.trim() !== '') body.bridge_ports = portsText.trim();
      if (vlanAware) body.bridge_vlan_aware = true;
    }
    if (type === 'bond') {
      body.slaves = slavesText.trim();
      body.bond_mode = bondMode;
      if (hashPolicy !== '' && HASHED_MODES.includes(bondMode)) body.bond_xmit_hash_policy = hashPolicy;
      if (primaryText.trim() !== '' && bondMode === 'active-backup') body['bond-primary'] = primaryText.trim();
    }
    if (type === 'vlan') {
      body['vlan-id'] = Number(vlanIdText.trim());
      body['vlan-raw-device'] = effectiveRaw;
    }
    return body;
  }

  /** Only the fields that differ from the interface as it is now; `null` clears one. */
  function buildUpdateBody(): UpdateNetBody {
    const body: UpdateNetBody = {};
    if (original === undefined) return body;
    if (autostart !== original.autostart) body.autostart = autostart;
    const text = (next: string, prev: string | undefined): string | null | undefined => {
      const trimmed = next.trim();
      if (trimmed === (prev ?? '')) return undefined;
      return trimmed === '' ? null : trimmed;
    };
    const cidr = text(cidrText, original.cidr);
    if (cidr !== undefined) body.cidr = cidr;
    const gateway = text(gatewayText, original.gateway);
    if (gateway !== undefined) body.gateway = gateway;
    const cidr6 = text(cidr6Text, original.cidr6);
    if (cidr6 !== undefined) body.cidr6 = cidr6;
    const gateway6 = text(gateway6Text, original.gateway6);
    if (gateway6 !== undefined) body.gateway6 = gateway6;
    const comments = text(commentText, original.comments);
    if (comments !== undefined) body.comments = comments;
    if (mtuNumber !== original.mtu) body.mtu = mtuNumber ?? null;
    if (type === 'bridge') {
      const ports = text(portsText, original.bridgePorts);
      if (ports !== undefined) body.bridge_ports = ports;
      if (vlanAware !== original.vlanAware) body.bridge_vlan_aware = vlanAware;
    }
    if (type === 'bond') {
      if (slavesText.trim() !== (original.slaves ?? '')) body.slaves = slavesText.trim();
      if (bondMode !== original.bondMode) body.bond_mode = bondMode;
      const policy = text(hashPolicy, original.bondXmitHashPolicy);
      if (policy !== undefined) body.bond_xmit_hash_policy = policy;
      const primary = text(primaryText, original.bondPrimary);
      if (primary !== undefined) body['bond-primary'] = primary;
    }
    if (type === 'vlan') {
      if (Number(vlanIdText.trim()) !== original.vlanId) body['vlan-id'] = Number(vlanIdText.trim());
      if (effectiveRaw !== (original.vlanRawDevice ?? '')) body['vlan-raw-device'] = effectiveRaw;
    }
    return body;
  }

  const updateBody = isNew ? undefined : buildUpdateBody();
  const changed = updateBody !== undefined && Object.keys(updateBody).length > 0;
  const busy = mutation.isPending;
  const canSave = valid && (isNew || changed) && !busy;

  const serverError = mutation.isError
    ? nodeNetworkErrorMessage(mutation.error, 'The interface could not be saved.')
    : undefined;

  function submit() {
    if (!canSave) return;
    if (isNew) {
      createMutation.mutate({ node, body: buildCreateBody() }, { onSuccess: () => onOpenChange(false) });
    } else if (original !== undefined && updateBody !== undefined) {
      updateMutation.mutate({ node, iface: original.iface, body: updateBody }, { onSuccess: () => onOpenChange(false) });
    }
  }

  function onKeyDown(event: KeyboardEvent<HTMLElement>) {
    if (event.key === 'Enter' && event.target instanceof HTMLInputElement) {
      event.preventDefault();
      submit();
    }
  }

  const candidatePorts = ifaces.filter((i) => i.type === 'eth').map((i) => i.iface);
  const title = isNew ? `Create: ${NET_KIND_LABEL[mode.type]}` : `Edit: ${original?.iface ?? ''}`;

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
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>
            The change is staged and shown as pending; it only takes effect on the node when you apply the
            configuration.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-4">
          <Field label="Name" htmlFor={`${id}-name`} error={errors.name}>
            <Input
              id={`${id}-name`}
              value={name}
              onChange={(e) => setNameText(e.target.value)}
              disabled={busy || !isNew}
              aria-invalid={errors.name !== undefined || undefined}
              autoComplete="off"
            />
          </Field>

          {type === 'vlan' && (
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <Field label="VLAN raw device" htmlFor={`${id}-raw`} error={errors.raw}>
                {vlanDevices.length > 0 ? (
                  <NativeSelect
                    id={`${id}-raw`}
                    value={effectiveRaw}
                    onChange={(e) => setRawDevice(e.target.value)}
                    disabled={busy}
                  >
                    {vlanDevices.map((d) => (
                      <option key={d} value={d}>
                        {d}
                      </option>
                    ))}
                  </NativeSelect>
                ) : (
                  <Input
                    id={`${id}-raw`}
                    value={effectiveRaw}
                    onChange={(e) => setRawDevice(e.target.value)}
                    disabled={busy}
                    autoComplete="off"
                  />
                )}
              </Field>
              <Field label="VLAN ID" htmlFor={`${id}-vlan-id`} error={errors.vlanId}>
                <Input
                  id={`${id}-vlan-id`}
                  value={vlanIdText}
                  onChange={(e) => setVlanIdText(e.target.value)}
                  disabled={busy}
                  inputMode="numeric"
                  aria-invalid={errors.vlanId !== undefined || undefined}
                  placeholder="20"
                  autoComplete="off"
                />
              </Field>
            </div>
          )}

          {type === 'bridge' && (
            <>
              <Field
                label="Bridge ports"
                htmlFor={`${id}-ports`}
                error={errors.ports}
                hint={candidatePorts.length > 0 ? `Space-separated. Available: ${candidatePorts.join(', ')}` : 'Space-separated.'}
              >
                <Input
                  id={`${id}-ports`}
                  value={portsText}
                  onChange={(e) => setPortsText(e.target.value)}
                  disabled={busy}
                  aria-invalid={errors.ports !== undefined || undefined}
                  placeholder="eno2"
                  autoComplete="off"
                />
              </Field>
              <CheckField id={`${id}-vlan-aware`} label="VLAN aware" checked={vlanAware} onChange={setVlanAware} disabled={busy} />
            </>
          )}

          {type === 'bond' && (
            <>
              <Field
                label="Slaves"
                htmlFor={`${id}-slaves`}
                error={errors.slaves}
                hint={candidatePorts.length > 0 ? `Space-separated. Available: ${candidatePorts.join(', ')}` : 'Space-separated.'}
              >
                <Input
                  id={`${id}-slaves`}
                  value={slavesText}
                  onChange={(e) => setSlavesText(e.target.value)}
                  disabled={busy}
                  aria-invalid={errors.slaves !== undefined || undefined}
                  placeholder="eno2 eno3"
                  autoComplete="off"
                />
              </Field>
              <Field label="Mode" htmlFor={`${id}-mode`}>
                <NativeSelect id={`${id}-mode`} value={bondMode} onChange={(e) => setBondMode(e.target.value)} disabled={busy}>
                  {(BOND_MODES as readonly string[]).includes(bondMode) ? null : <option value={bondMode}>{bondMode}</option>}
                  {BOND_MODES.map((m) => (
                    <option key={m} value={m}>
                      {m}
                    </option>
                  ))}
                </NativeSelect>
              </Field>
              {HASHED_MODES.includes(bondMode) && (
                <Field label="Hash policy" htmlFor={`${id}-hash`}>
                  <NativeSelect id={`${id}-hash`} value={hashPolicy} onChange={(e) => setHashPolicy(e.target.value)} disabled={busy}>
                    <option value="">Default</option>
                    {HASH_POLICIES.map((p) => (
                      <option key={p} value={p}>
                        {p}
                      </option>
                    ))}
                  </NativeSelect>
                </Field>
              )}
              {bondMode === 'active-backup' && (
                <Field label="Primary" htmlFor={`${id}-primary`} error={errors.primary}>
                  <Input
                    id={`${id}-primary`}
                    value={primaryText}
                    onChange={(e) => setPrimaryText(e.target.value)}
                    disabled={busy}
                    aria-invalid={errors.primary !== undefined || undefined}
                    autoComplete="off"
                  />
                </Field>
              )}
            </>
          )}

          <CheckField id={`${id}-autostart`} label="Autostart" checked={autostart} onChange={setAutostart} disabled={busy} />

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Field label="IPv4/CIDR" htmlFor={`${id}-cidr`} error={errors.cidr}>
              <Input
                id={`${id}-cidr`}
                value={cidrText}
                onChange={(e) => setCidrText(e.target.value)}
                disabled={busy}
                aria-invalid={errors.cidr !== undefined || undefined}
                placeholder="10.0.0.5/24"
                autoComplete="off"
              />
            </Field>
            <Field label="Gateway (IPv4)" htmlFor={`${id}-gateway`} error={errors.gateway}>
              <Input
                id={`${id}-gateway`}
                value={gatewayText}
                onChange={(e) => setGatewayText(e.target.value)}
                disabled={busy}
                aria-invalid={errors.gateway !== undefined || undefined}
                placeholder="10.0.0.1"
                autoComplete="off"
              />
            </Field>
            <Field label="IPv6/CIDR" htmlFor={`${id}-cidr6`} error={errors.cidr6}>
              <Input
                id={`${id}-cidr6`}
                value={cidr6Text}
                onChange={(e) => setCidr6Text(e.target.value)}
                disabled={busy}
                aria-invalid={errors.cidr6 !== undefined || undefined}
                placeholder="fd00::5/64"
                autoComplete="off"
              />
            </Field>
            <Field label="Gateway (IPv6)" htmlFor={`${id}-gateway6`} error={errors.gateway6}>
              <Input
                id={`${id}-gateway6`}
                value={gateway6Text}
                onChange={(e) => setGateway6Text(e.target.value)}
                disabled={busy}
                aria-invalid={errors.gateway6 !== undefined || undefined}
                placeholder="fd00::1"
                autoComplete="off"
              />
            </Field>
          </div>

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Field label="MTU" htmlFor={`${id}-mtu`} error={errors.mtu}>
              <Input
                id={`${id}-mtu`}
                value={mtuText}
                onChange={(e) => setMtuText(e.target.value)}
                disabled={busy}
                inputMode="numeric"
                aria-invalid={errors.mtu !== undefined || undefined}
                placeholder="1500"
                autoComplete="off"
              />
            </Field>
            <Field label="Comment" htmlFor={`${id}-comment`} error={errors.comment}>
              <Input
                id={`${id}-comment`}
                value={commentText}
                onChange={(e) => setCommentText(e.target.value)}
                disabled={busy}
                aria-invalid={errors.comment !== undefined || undefined}
                autoComplete="off"
              />
            </Field>
          </div>

          {serverError && (
            <p role="alert" className="text-xs text-status-error">
              {serverError}
            </p>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={!canSave}>
            {busy && <Loader2 className="size-4 animate-spin" />}
            {isNew ? 'Create' : 'Save'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
