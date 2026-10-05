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
import { HOTPLUG_LABELS, OSTYPE_OPTIONS, type OptionFieldDef } from '@/components/options/optionFields';
import { hardwareErrorMessage } from '@/api/hardwareHooks';
import { useUpdateGuestOptions } from '@/api/optionsHooks';
import type { OptionsPatch } from '@/api/options';
import type { GuestConfig, GuestType } from '@/api/types';
import { isValidDnsName } from '@/lib/guestName';
import { HOTPLUG_ITEMS, isIPv4, isIPv6, parseGuestOptions, parseTags, type HotplugItem } from '@/lib/pve-config';

export interface EditOptionDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  node: string;
  type: GuestType;
  vmid: number;
  /** Which option the dialog edits (a row descriptor from `optionFields.ts`). */
  field: OptionFieldDef;
  /** The guest's current config -- the form is seeded from it at mount. */
  config: GuestConfig;
}

const TAG_RE = /^[a-z0-9_][a-z0-9_\-+.]*$/i;
const MAX_TAGS = 32;
const MAX_TAG_LENGTH = 64;
const MAX_NAMESERVERS = 3;
const MAX_SEARCHDOMAIN_LENGTH = 253;

/** A config flag (`1`, `"1"`, `on`, `true`); `fallback` when the key is absent. */
function flagValue(raw: string | number | undefined, fallback: boolean): boolean {
  if (raw === undefined) return fallback;
  return ['1', 'on', 'true', 'yes'].includes(String(raw).toLowerCase());
}

type TriState = 'default' | 'yes' | 'no';

/** Everything the form can hold; only the fields of the dialog's own kind are used. */
interface FormState {
  bool: boolean;
  tri: TriState;
  ostype: string;
  order: string;
  up: string;
  down: string;
  tags: string;
  agentEnabled: boolean;
  agentFstrim: boolean;
  hotplug: HotplugItem[];
  nameservers: string[];
  searchdomain: string;
}

function initialForm(field: OptionFieldDef, type: GuestType, config: GuestConfig): FormState {
  const options = parseGuestOptions(config, type);
  const servers = [...options.nameserver];
  while (servers.length < MAX_NAMESERVERS) servers.push('');
  return {
    bool: flagValue(config[field.id], field.defaultOn ?? false),
    tri: config.localtime === undefined ? 'default' : flagValue(config.localtime, false) ? 'yes' : 'no',
    ostype: typeof config.ostype === 'string' ? config.ostype : 'other',
    order: options.startup?.order !== undefined ? String(options.startup.order) : '',
    up: options.startup?.up !== undefined ? String(options.startup.up) : '',
    down: options.startup?.down !== undefined ? String(options.startup.down) : '',
    tags: options.tags.join(' '),
    agentEnabled: options.agent?.enabled ?? false,
    agentFstrim: options.agent?.fstrimClonedDisks ?? false,
    hotplug: [...(options.hotplug ?? [])],
    nameservers: servers.slice(0, MAX_NAMESERVERS),
    searchdomain: options.searchdomain ?? '',
  };
}

interface Built {
  /** The request body when the form is valid. */
  patch?: OptionsPatch;
  /** The validation message to show when it is not. */
  error?: string;
}

function parseCount(text: string): number | undefined | 'invalid' {
  const trimmed = text.trim();
  if (trimmed === '') return undefined;
  return /^\d+$/.test(trimmed) ? Number(trimmed) : 'invalid';
}

function build(field: OptionFieldDef, form: FormState): Built {
  switch (field.id) {
    case 'onboot':
    case 'protection':
    case 'tablet':
    case 'acpi':
    case 'kvm':
      return { patch: { [field.id]: form.bool } };
    case 'localtime':
      return { patch: { localtime: form.tri === 'default' ? null : form.tri === 'yes' } };
    case 'ostype':
      return { patch: { ostype: form.ostype } };
    case 'startup': {
      const order = parseCount(form.order);
      const up = parseCount(form.up);
      const down = parseCount(form.down);
      if (order === 'invalid' || up === 'invalid' || down === 'invalid') {
        return { error: 'Order and delays must be whole numbers, 0 or more.' };
      }
      if (order === undefined && up === undefined && down === undefined) return { patch: { startup: null } };
      return {
        patch: {
          startup: {
            ...(order !== undefined ? { order } : {}),
            ...(up !== undefined ? { up } : {}),
            ...(down !== undefined ? { down } : {}),
          },
        },
      };
    }
    case 'tags': {
      const tags = parseTags(form.tags);
      if (tags.length > MAX_TAGS) return { error: `At most ${MAX_TAGS} tags.` };
      const bad = tags.find((tag) => !TAG_RE.test(tag) || tag.length > MAX_TAG_LENGTH);
      if (bad !== undefined) {
        return { error: `"${bad}" is not a valid tag: letters, digits, "_", "-", "+" and "." only.` };
      }
      return { patch: { tags } };
    }
    case 'agent':
      return {
        patch: {
          agent: { enabled: form.agentEnabled, ...(form.agentFstrim ? { fstrimClonedDisks: true } : {}) },
        },
      };
    case 'hotplug':
      return { patch: { hotplug: HOTPLUG_ITEMS.filter((item) => form.hotplug.includes(item)) } };
    case 'nameserver': {
      const servers = form.nameservers.map((s) => s.trim()).filter((s) => s !== '');
      const bad = servers.find((s) => !isIPv4(s) && !isIPv6(s));
      if (bad !== undefined) return { error: `"${bad}" is not an IPv4 or IPv6 address.` };
      return { patch: { nameserver: servers } };
    }
    case 'searchdomain': {
      const domain = form.searchdomain.trim();
      if (domain === '') return { patch: { searchdomain: null } };
      if (!isValidDnsName(domain, MAX_SEARCHDOMAIN_LENGTH)) {
        return { error: 'Must be a valid domain name: letters, digits and hyphens, in dot-separated segments.' };
      }
      return { patch: { searchdomain: domain } };
    }
  }
}

function FieldRow({ label, htmlFor, children }: { label: string; htmlFor: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={htmlFor} className="text-sm font-medium">
        {label}
      </label>
      {children}
    </div>
  );
}

function CheckRow({
  id,
  label,
  checked,
  disabled,
  onChange,
}: {
  id: string;
  label: string;
  checked: boolean;
  disabled?: boolean | undefined;
  onChange: (value: boolean) => void;
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
 * One small dialog for every Options-tab row that is not a rename, driven by the row's descriptor
 * (`optionFields.ts`): a checkbox for plain flags, a confirmation for Protection, a select for the
 * OS type and local-time default, three delay fields for start/shutdown order, a tags field, the
 * guest-agent and hotplug checkbox groups, and the lxc DNS fields. Only the edited option is sent
 * (`PATCH .../options`); Save stays disabled until the form differs from the config it was seeded
 * from. A server error shows inline and the dialog stays open.
 *
 * The form is only ever seeded from `config` at mount -- mount it fresh per open (the Options tab
 * renders it conditionally).
 */
export function EditOptionDialog({ open, onOpenChange, node, type, vmid, field, config }: EditOptionDialogProps) {
  const mutation = useUpdateGuestOptions();
  const id = useId();
  const [initial] = useState(() => initialForm(field, type, config));
  // A confirmation acts on the flipped state, so it starts there (and is therefore "dirty").
  const isConfirm = field.kind === 'boolean' && field.confirm === true;
  const [form, setForm] = useState<FormState>(() => (isConfirm ? { ...initial, bool: !initial.bool } : initial));

  const set = <K extends keyof FormState>(key: K, value: FormState[K]) => setForm((f) => ({ ...f, [key]: value }));

  const built = build(field, form);
  const dirty = JSON.stringify(form) !== JSON.stringify(initial);
  const busy = mutation.isPending;
  const canSave = built.patch !== undefined && dirty && !busy;
  const serverError = mutation.isError ? hardwareErrorMessage(mutation.error, 'The option could not be saved.') : undefined;

  function submit() {
    if (!canSave || !built.patch) return;
    mutation.mutate({ node, type, vmid, patch: built.patch }, { onSuccess: () => onOpenChange(false) });
  }

  function onKeyDown(event: KeyboardEvent<HTMLElement>) {
    if (event.key === 'Enter' && event.target instanceof HTMLInputElement) {
      event.preventDefault();
      submit();
    }
  }

  const protectionTarget = !initial.bool;
  let body: ReactNode = null;
  switch (field.kind) {
    case 'boolean':
      body = isConfirm ? null : (
        <CheckRow id={`${id}-bool`} label={field.label} checked={form.bool} disabled={busy} onChange={(v) => set('bool', v)} />
      );
      break;
    case 'tristate':
      body = (
        <FieldRow label={field.label} htmlFor={`${id}-tri`}>
          <NativeSelect
            id={`${id}-tri`}
            value={form.tri}
            disabled={busy}
            onChange={(e) => set('tri', e.target.value as TriState)}
          >
            <option value="default">Default (based on the OS type)</option>
            <option value="yes">Yes</option>
            <option value="no">No</option>
          </NativeSelect>
        </FieldRow>
      );
      break;
    case 'select': {
      const known = OSTYPE_OPTIONS.some((o) => o.value === initial.ostype);
      body = (
        <FieldRow label={field.label} htmlFor={`${id}-ostype`}>
          <NativeSelect
            id={`${id}-ostype`}
            value={form.ostype}
            disabled={busy}
            onChange={(e) => set('ostype', e.target.value)}
          >
            {!known && <option value={initial.ostype}>{initial.ostype}</option>}
            {OSTYPE_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </NativeSelect>
        </FieldRow>
      );
      break;
    }
    case 'startup':
      body = (
        <div className="grid grid-cols-3 gap-3">
          <FieldRow label="Start order" htmlFor={`${id}-order`}>
            <Input
              id={`${id}-order`}
              type="number"
              inputMode="numeric"
              min={0}
              value={form.order}
              placeholder="any"
              disabled={busy}
              onChange={(e) => set('order', e.target.value)}
            />
          </FieldRow>
          <FieldRow label="Startup delay (s)" htmlFor={`${id}-up`}>
            <Input
              id={`${id}-up`}
              type="number"
              inputMode="numeric"
              min={0}
              value={form.up}
              placeholder="default"
              disabled={busy}
              onChange={(e) => set('up', e.target.value)}
            />
          </FieldRow>
          <FieldRow label="Shutdown timeout (s)" htmlFor={`${id}-down`}>
            <Input
              id={`${id}-down`}
              type="number"
              inputMode="numeric"
              min={0}
              value={form.down}
              placeholder="default"
              disabled={busy}
              onChange={(e) => set('down', e.target.value)}
            />
          </FieldRow>
        </div>
      );
      break;
    case 'tags':
      body = (
        <FieldRow label="Tags" htmlFor={`${id}-tags`}>
          <Input
            id={`${id}-tags`}
            value={form.tags}
            placeholder="prod web"
            disabled={busy}
            aria-invalid={built.error !== undefined || undefined}
            onChange={(e) => set('tags', e.target.value)}
          />
          <p className="text-xs text-muted-foreground">Separate tags with spaces, commas or semicolons. Clear the field to remove all tags.</p>
        </FieldRow>
      );
      break;
    case 'agent':
      body = (
        <div className="flex flex-col gap-3">
          <CheckRow
            id={`${id}-agent`}
            label="Use QEMU Guest Agent"
            checked={form.agentEnabled}
            disabled={busy}
            onChange={(v) => set('agentEnabled', v)}
          />
          <CheckRow
            id={`${id}-fstrim`}
            label="Trim cloned disks (fstrim)"
            checked={form.agentFstrim}
            disabled={busy || !form.agentEnabled}
            onChange={(v) => set('agentFstrim', v)}
          />
        </div>
      );
      break;
    case 'hotplug':
      body = (
        <div className="grid grid-cols-2 gap-3">
          {HOTPLUG_ITEMS.map((item) => (
            <CheckRow
              key={item}
              id={`${id}-hp-${item}`}
              label={HOTPLUG_LABELS[item]}
              checked={form.hotplug.includes(item)}
              disabled={busy}
              onChange={(v) =>
                set('hotplug', v ? [...form.hotplug.filter((i) => i !== item), item] : form.hotplug.filter((i) => i !== item))
              }
            />
          ))}
        </div>
      );
      break;
    case 'nameservers':
      body = (
        <div className="flex flex-col gap-3">
          {form.nameservers.map((server, index) => (
            <FieldRow key={index} label={`DNS server ${index + 1}`} htmlFor={`${id}-ns${index}`}>
              <Input
                id={`${id}-ns${index}`}
                value={server}
                placeholder={index === 0 ? '1.1.1.1' : 'optional'}
                disabled={busy}
                onChange={(e) => set('nameservers', form.nameservers.map((s, i) => (i === index ? e.target.value : s)))}
              />
            </FieldRow>
          ))}
          <p className="text-xs text-muted-foreground">Leave all blank to use the host&apos;s DNS settings.</p>
        </div>
      );
      break;
    case 'searchdomain':
      body = (
        <FieldRow label="DNS search domain" htmlFor={`${id}-sd`}>
          <Input
            id={`${id}-sd`}
            value={form.searchdomain}
            placeholder="example.com"
            disabled={busy}
            aria-invalid={built.error !== undefined || undefined}
            onChange={(e) => set('searchdomain', e.target.value)}
          />
          <p className="text-xs text-muted-foreground">Leave blank to use the host&apos;s setting.</p>
        </FieldRow>
      );
      break;
  }

  const description = isConfirm
    ? protectionTarget
      ? 'Protection stops the guest and its disks from being removed, and blocks a rollback or a restore over it, until it is turned off again.'
      : 'Without protection, the guest and its disks can be removed or overwritten by a restore or a rollback.'
    : field.kind === 'tags'
      ? 'Tags are labels shown in the inventory tree. The datacenter tag policy may limit which ones you can set.'
      : 'If the guest is running, PVE may apply some changes after its next restart.';

  const saveLabel = isConfirm ? (protectionTarget ? 'Turn on protection' : 'Turn off protection') : 'Save';

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next && busy) return;
        onOpenChange(next);
      }}
    >
      <DialogContent onKeyDown={onKeyDown}>
        <DialogHeader>
          <DialogTitle>{isConfirm ? (protectionTarget ? 'Turn on protection?' : 'Turn off protection?') : `Edit ${field.label}`}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>

        {body !== null && <div className="flex flex-col gap-4">{body}</div>}

        {built.error !== undefined ? (
          <p role="alert" className="text-xs text-status-error">
            {built.error}
          </p>
        ) : serverError ? (
          <p role="alert" className="text-xs text-status-error">
            {serverError}
          </p>
        ) : null}

        <DialogFooter>
          <Button variant="outline" disabled={busy} onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button variant={isConfirm && !protectionTarget ? 'destructive' : 'default'} disabled={!canSave} onClick={submit}>
            {busy && <Loader2 className="size-4 animate-spin" />}
            {saveLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
