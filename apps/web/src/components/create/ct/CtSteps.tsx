import { useEffect, type ReactNode } from 'react';

import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { NativeSelect } from '@/components/hardware/NativeSelect';
import { CheckField, Field } from '@/components/create/ct/Field';
import {
  describeNetwork,
  parseNameservers,
  parseSshKeys,
  parseTagList,
  type CtForm,
  type Ip4Mode,
  type Ip6Mode,
  type StepErrors,
} from '@/components/create/ct/ctForm';
import { useCreateNodes, useCreateStorages, useContainerTemplates } from '@/api/createCtHooks';
import { useBridges } from '@/api/networkHooks';
import { formatBytes } from '@/lib/format';

/** What every step panel is handed. */
export interface StepProps {
  form: CtForm;
  set: <K extends keyof CtForm>(key: K, value: CtForm[K]) => void;
  errors: StepErrors;
  busy: boolean;
  /** A per-dialog id prefix so label/control pairs stay unique. */
  id: string;
}

const FALLBACK_BRIDGE = 'vmbr0';

function Section({ children }: { children: ReactNode }) {
  return <div className="flex flex-col gap-4">{children}</div>;
}

function Grid({ children }: { children: ReactNode }) {
  return <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">{children}</div>;
}

// --- General ----------------------------------------------------------------------------------

export function GeneralStep({ form, set, errors, busy, id, onNodeChange }: StepProps & { onNodeChange: (node: string) => void }) {
  const nodes = useCreateNodes();
  const nodeNames = (nodes.data ?? []).map((n) => n.name);
  // A node the lookup does not list (a stale launch point) stays selectable.
  const options = form.node !== '' && !nodeNames.includes(form.node) ? [form.node, ...nodeNames] : nodeNames;
  const firstNode = nodeNames[0];

  useEffect(() => {
    if (form.node === '' && firstNode !== undefined) onNodeChange(firstNode);
  }, [form.node, firstNode, onNodeChange]);

  const hasCredential = form.password !== '' || parseSshKeys(form.sshKeysText).length > 0;

  return (
    <Section>
      <Grid>
        <Field label="Node" htmlFor={`${id}-node`}>
          <NativeSelect
            id={`${id}-node`}
            value={form.node}
            onChange={(e) => onNodeChange(e.target.value)}
            disabled={busy || nodes.isLoading}
          >
            {options.map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </NativeSelect>
        </Field>
        <Field label="CT ID" htmlFor={`${id}-vmid`} error={errors.vmid}>
          <Input
            id={`${id}-vmid`}
            inputMode="numeric"
            value={form.vmidText}
            onChange={(e) => set('vmidText', e.target.value)}
            disabled={busy}
            aria-invalid={errors.vmid !== undefined || undefined}
            autoComplete="off"
          />
        </Field>
      </Grid>
      <Field label="Hostname" htmlFor={`${id}-hostname`} error={errors.hostname}>
        <Input
          id={`${id}-hostname`}
          value={form.hostname}
          onChange={(e) => set('hostname', e.target.value)}
          disabled={busy}
          aria-invalid={errors.hostname !== undefined || undefined}
          placeholder="web01"
          autoComplete="off"
        />
      </Field>
      <div className="flex flex-wrap gap-x-6 gap-y-2">
        <CheckField
          id={`${id}-unprivileged`}
          label="Unprivileged container"
          checked={form.unprivileged}
          onChange={(v) => set('unprivileged', v)}
          disabled={busy}
        />
        <CheckField
          id={`${id}-nesting`}
          label="Nesting"
          checked={form.nesting}
          onChange={(v) => set('nesting', v)}
          disabled={busy}
        />
      </div>
      <Grid>
        <Field label="Resource pool" htmlFor={`${id}-pool`} error={errors.pool} hint="Optional.">
          <Input
            id={`${id}-pool`}
            value={form.pool}
            onChange={(e) => set('pool', e.target.value)}
            disabled={busy}
            aria-invalid={errors.pool !== undefined || undefined}
            autoComplete="off"
          />
        </Field>
        <Field label="Tags" htmlFor={`${id}-tags`} error={errors.tags} hint="Optional; separate with commas or spaces.">
          <Input
            id={`${id}-tags`}
            value={form.tagsText}
            onChange={(e) => set('tagsText', e.target.value)}
            disabled={busy}
            aria-invalid={errors.tags !== undefined || undefined}
            autoComplete="off"
          />
        </Field>
      </Grid>
      <Grid>
        <Field label="Password" htmlFor={`${id}-password`} error={errors.password}>
          <Input
            id={`${id}-password`}
            type="password"
            value={form.password}
            onChange={(e) => set('password', e.target.value)}
            disabled={busy}
            aria-invalid={errors.password !== undefined || undefined}
            autoComplete="new-password"
          />
        </Field>
        <Field label="Confirm password" htmlFor={`${id}-password-confirm`} error={errors.passwordConfirm}>
          <Input
            id={`${id}-password-confirm`}
            type="password"
            value={form.passwordConfirm}
            onChange={(e) => set('passwordConfirm', e.target.value)}
            disabled={busy}
            aria-invalid={errors.passwordConfirm !== undefined || undefined}
            autoComplete="new-password"
          />
        </Field>
      </Grid>
      <Field
        label="SSH public keys"
        htmlFor={`${id}-ssh-keys`}
        error={errors.sshKeys}
        hint={hasCredential ? 'Optional; one key per line.' : 'Set a root password or add an SSH public key (one per line).'}
      >
        <Textarea
          id={`${id}-ssh-keys`}
          rows={3}
          value={form.sshKeysText}
          onChange={(e) => set('sshKeysText', e.target.value)}
          disabled={busy}
          aria-invalid={errors.sshKeys !== undefined || undefined}
          spellCheck={false}
          className="font-mono text-xs"
        />
      </Field>
      <CheckField
        id={`${id}-start`}
        label="Start after created"
        checked={form.startAfter}
        onChange={(v) => set('startAfter', v)}
        disabled={busy}
      />
    </Section>
  );
}

// --- Template ---------------------------------------------------------------------------------

/** The file name of a `<storage>:vztmpl/<file>` volume id. */
function templateName(volid: string): string {
  const slash = volid.indexOf('/');
  return slash === -1 ? volid : volid.slice(slash + 1);
}

export function TemplateStep({ form, set, busy, id }: StepProps) {
  const storages = useCreateStorages(form.node, 'vztmpl');
  const storageIds = (storages.data ?? []).map((s) => s.id);
  const firstStorage = storageIds[0];
  const templates = useContainerTemplates(form.node, form.templateStorage);
  const sorted = [...(templates.data ?? [])].sort((a, b) => templateName(a.volid).localeCompare(templateName(b.volid)));

  useEffect(() => {
    if (form.templateStorage === '' && firstStorage !== undefined) set('templateStorage', firstStorage);
  }, [form.templateStorage, firstStorage, set]);

  return (
    <Section>
      <Field
        label="Storage"
        htmlFor={`${id}-tpl-storage`}
        error={storages.isError ? 'The storages on this node could not be loaded.' : undefined}
        hint={storages.data?.length === 0 ? 'No storage on this node holds container templates.' : undefined}
      >
        <NativeSelect
          id={`${id}-tpl-storage`}
          value={form.templateStorage}
          onChange={(e) => {
            set('templateStorage', e.target.value);
            set('templateVolid', '');
          }}
          disabled={busy || storages.isLoading}
        >
          {storageIds.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </NativeSelect>
      </Field>
      <Field
        label="Template"
        htmlFor={`${id}-tpl`}
        error={templates.isError ? 'The templates on this storage could not be loaded.' : undefined}
        hint={
          templates.isSuccess && sorted.length === 0
            ? 'This storage has no container templates; download one from the storage page first.'
            : undefined
        }
      >
        <NativeSelect
          id={`${id}-tpl`}
          value={form.templateVolid}
          onChange={(e) => set('templateVolid', e.target.value)}
          disabled={busy || templates.isLoading}
        >
          <option value="">{templates.isLoading ? 'Loading templates...' : 'Select a template...'}</option>
          {sorted.map((t) => (
            <option key={t.volid} value={t.volid}>
              {templateName(t.volid)}
              {t.size > 0 ? ` (${formatBytes(t.size)})` : ''}
            </option>
          ))}
        </NativeSelect>
      </Field>
    </Section>
  );
}

// --- Disks ------------------------------------------------------------------------------------

export function DisksStep({ form, set, errors, busy, id }: StepProps) {
  const storages = useCreateStorages(form.node, 'rootdir');
  const list = storages.data ?? [];
  const firstStorage = list[0]?.id;

  useEffect(() => {
    if (form.rootStorage === '' && firstStorage !== undefined) set('rootStorage', firstStorage);
  }, [form.rootStorage, firstStorage, set]);

  return (
    <Section>
      <Grid>
        <Field
          label="Storage"
          htmlFor={`${id}-root-storage`}
          error={storages.isError ? 'The storages on this node could not be loaded.' : undefined}
          hint={storages.isSuccess && list.length === 0 ? 'No storage on this node can hold container volumes.' : undefined}
        >
          <NativeSelect
            id={`${id}-root-storage`}
            value={form.rootStorage}
            onChange={(e) => set('rootStorage', e.target.value)}
            disabled={busy || storages.isLoading}
          >
            {list.map((s) => (
              <option key={s.id} value={s.id}>
                {s.freeBytes !== undefined ? `${s.id} (${formatBytes(s.freeBytes)} free)` : s.id}
              </option>
            ))}
          </NativeSelect>
        </Field>
        <Field label="Disk size (GiB)" htmlFor={`${id}-size`} error={errors.size}>
          <Input
            id={`${id}-size`}
            type="number"
            inputMode="numeric"
            min={1}
            max={65536}
            value={form.sizeText}
            onChange={(e) => set('sizeText', e.target.value)}
            disabled={busy}
            aria-invalid={errors.size !== undefined || undefined}
          />
        </Field>
      </Grid>
      <div className="flex flex-col gap-2">
        <span className="text-sm font-medium">Advanced</span>
        <CheckField
          id={`${id}-acl`}
          label="ACL"
          hint="Enable POSIX access control lists on the root volume."
          checked={form.acl}
          onChange={(v) => set('acl', v)}
          disabled={busy}
        />
        <CheckField
          id={`${id}-quota`}
          label="Quota"
          hint="Enable user quotas on the root volume."
          checked={form.quota}
          onChange={(v) => set('quota', v)}
          disabled={busy}
        />
      </div>
    </Section>
  );
}

// --- CPU / Memory -----------------------------------------------------------------------------

export function CpuStep({ form, set, errors, busy, id }: StepProps) {
  return (
    <Section>
      <Field label="Cores" htmlFor={`${id}-cores`} error={errors.cores}>
        <Input
          id={`${id}-cores`}
          type="number"
          inputMode="numeric"
          min={1}
          max={128}
          value={form.coresText}
          onChange={(e) => set('coresText', e.target.value)}
          disabled={busy}
          aria-invalid={errors.cores !== undefined || undefined}
        />
      </Field>
      <Grid>
        <Field label="CPU limit" htmlFor={`${id}-cpulimit`} error={errors.cpulimit} hint="Optional; blank is unlimited.">
          <Input
            id={`${id}-cpulimit`}
            type="number"
            inputMode="decimal"
            min={0}
            max={128}
            step="any"
            value={form.cpulimitText}
            onChange={(e) => set('cpulimitText', e.target.value)}
            disabled={busy}
            aria-invalid={errors.cpulimit !== undefined || undefined}
          />
        </Field>
        <Field label="CPU units" htmlFor={`${id}-cpuunits`} error={errors.cpuunits} hint="Optional; the relative CPU weight.">
          <Input
            id={`${id}-cpuunits`}
            type="number"
            inputMode="numeric"
            min={0}
            max={100000}
            value={form.cpuunitsText}
            onChange={(e) => set('cpuunitsText', e.target.value)}
            disabled={busy}
            aria-invalid={errors.cpuunits !== undefined || undefined}
          />
        </Field>
      </Grid>
    </Section>
  );
}

export function MemoryStep({ form, set, errors, busy, id }: StepProps) {
  return (
    <Grid>
      <Field label="Memory (MiB)" htmlFor={`${id}-memory`} error={errors.memory}>
        <Input
          id={`${id}-memory`}
          type="number"
          inputMode="numeric"
          min={16}
          value={form.memoryText}
          onChange={(e) => set('memoryText', e.target.value)}
          disabled={busy}
          aria-invalid={errors.memory !== undefined || undefined}
        />
      </Field>
      <Field label="Swap (MiB)" htmlFor={`${id}-swap`} error={errors.swap}>
        <Input
          id={`${id}-swap`}
          type="number"
          inputMode="numeric"
          min={0}
          value={form.swapText}
          onChange={(e) => set('swapText', e.target.value)}
          disabled={busy}
          aria-invalid={errors.swap !== undefined || undefined}
        />
      </Field>
    </Grid>
  );
}

// --- Network ----------------------------------------------------------------------------------

export function NetworkStep({ form, set, errors, busy, id }: StepProps) {
  const bridges = useBridges(form.node);
  const bridgeNames = (bridges.data ?? []).map((b) => b.iface);
  const lookupDone = !bridges.isLoading;
  const defaultBridge = bridgeNames.includes(FALLBACK_BRIDGE) ? FALLBACK_BRIDGE : (bridgeNames[0] ?? FALLBACK_BRIDGE);

  useEffect(() => {
    if (form.bridge === '' && lookupDone) set('bridge', defaultBridge);
  }, [form.bridge, lookupDone, defaultBridge, set]);

  // No list (the lookup failed, or the node reports no bridges): fall back to a free-text field.
  const useSelect = bridges.isLoading || bridgeNames.length > 0;
  const dis = busy || form.noNetwork;

  return (
    <Section>
      <CheckField
        id={`${id}-no-net`}
        label="No network device"
        hint="The container is created without a network interface."
        checked={form.noNetwork}
        onChange={(v) => set('noNetwork', v)}
        disabled={busy}
      />
      <Grid>
        <Field label="Interface name" htmlFor={`${id}-net-name`} error={errors.name}>
          <Input
            id={`${id}-net-name`}
            value={form.netName}
            onChange={(e) => set('netName', e.target.value)}
            disabled={dis}
            aria-invalid={errors.name !== undefined || undefined}
            autoComplete="off"
          />
        </Field>
        <Field label="Bridge" htmlFor={`${id}-bridge`} error={errors.bridge}>
          {useSelect ? (
            <NativeSelect
              id={`${id}-bridge`}
              value={form.bridge}
              onChange={(e) => set('bridge', e.target.value)}
              disabled={dis || bridges.isLoading}
            >
              {bridges.isLoading && <option value={form.bridge}>Loading bridges...</option>}
              {bridgeNames.map((b) => {
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
              value={form.bridge}
              onChange={(e) => set('bridge', e.target.value)}
              disabled={dis}
              aria-invalid={errors.bridge !== undefined || undefined}
              placeholder={FALLBACK_BRIDGE}
              autoComplete="off"
            />
          )}
        </Field>
      </Grid>

      <Field label="IPv4" htmlFor={`${id}-ip4-mode`}>
        <NativeSelect
          id={`${id}-ip4-mode`}
          value={form.ip4Mode}
          onChange={(e) => set('ip4Mode', e.target.value as Ip4Mode)}
          disabled={dis}
        >
          <option value="dhcp">DHCP</option>
          <option value="static">Static</option>
          <option value="manual">Manual</option>
        </NativeSelect>
      </Field>
      {form.ip4Mode === 'static' && (
        <Grid>
          <Field label="IPv4 address (CIDR)" htmlFor={`${id}-ip4`} error={errors.ip4}>
            <Input
              id={`${id}-ip4`}
              value={form.ip4}
              onChange={(e) => set('ip4', e.target.value)}
              disabled={dis}
              aria-invalid={errors.ip4 !== undefined || undefined}
              placeholder="10.0.0.5/24"
              autoComplete="off"
            />
          </Field>
          <Field label="IPv4 gateway" htmlFor={`${id}-gw4`} error={errors.gw4}>
            <Input
              id={`${id}-gw4`}
              value={form.gw4}
              onChange={(e) => set('gw4', e.target.value)}
              disabled={dis}
              aria-invalid={errors.gw4 !== undefined || undefined}
              placeholder="10.0.0.1"
              autoComplete="off"
            />
          </Field>
        </Grid>
      )}

      <Field label="IPv6" htmlFor={`${id}-ip6-mode`}>
        <NativeSelect
          id={`${id}-ip6-mode`}
          value={form.ip6Mode}
          onChange={(e) => set('ip6Mode', e.target.value as Ip6Mode)}
          disabled={dis}
        >
          <option value="none">Not configured</option>
          <option value="auto">SLAAC (auto)</option>
          <option value="dhcp">DHCP</option>
          <option value="static">Static</option>
          <option value="manual">Manual</option>
        </NativeSelect>
      </Field>
      {form.ip6Mode === 'static' && (
        <Grid>
          <Field label="IPv6 address (CIDR)" htmlFor={`${id}-ip6`} error={errors.ip6}>
            <Input
              id={`${id}-ip6`}
              value={form.ip6}
              onChange={(e) => set('ip6', e.target.value)}
              disabled={dis}
              aria-invalid={errors.ip6 !== undefined || undefined}
              placeholder="fd00::5/64"
              autoComplete="off"
            />
          </Field>
          <Field label="IPv6 gateway" htmlFor={`${id}-gw6`} error={errors.gw6}>
            <Input
              id={`${id}-gw6`}
              value={form.gw6}
              onChange={(e) => set('gw6', e.target.value)}
              disabled={dis}
              aria-invalid={errors.gw6 !== undefined || undefined}
              placeholder="fd00::1"
              autoComplete="off"
            />
          </Field>
        </Grid>
      )}

      <Grid>
        <Field label="VLAN tag" htmlFor={`${id}-vlan`} error={errors.vlan} hint="Optional, 1-4094.">
          <Input
            id={`${id}-vlan`}
            type="number"
            inputMode="numeric"
            min={1}
            max={4094}
            value={form.vlanText}
            onChange={(e) => set('vlanText', e.target.value)}
            disabled={dis}
            aria-invalid={errors.vlan !== undefined || undefined}
          />
        </Field>
        <div className="flex flex-col gap-2">
          <span className="text-sm font-medium">Options</span>
          <CheckField
            id={`${id}-firewall`}
            label="Firewall"
            checked={form.firewall}
            onChange={(v) => set('firewall', v)}
            disabled={dis}
          />
          <CheckField
            id={`${id}-mac-override`}
            label="Override MAC address"
            hint="Otherwise Proxmox generates one."
            checked={form.overrideMac}
            onChange={(v) => set('overrideMac', v)}
            disabled={dis}
          />
        </div>
      </Grid>
      {form.overrideMac && (
        <Field label="MAC address" htmlFor={`${id}-mac`} error={errors.mac}>
          <Input
            id={`${id}-mac`}
            value={form.macText}
            onChange={(e) => set('macText', e.target.value)}
            disabled={dis}
            aria-invalid={errors.mac !== undefined || undefined}
            placeholder="BC:24:11:AA:BB:CC"
            autoComplete="off"
          />
        </Field>
      )}
    </Section>
  );
}

// --- DNS --------------------------------------------------------------------------------------

export function DnsStep({ form, set, errors, busy, id }: StepProps) {
  return (
    <Section>
      <p className="text-sm text-muted-foreground">
        Leave both fields empty to use the host&apos;s DNS settings.
      </p>
      <Field label="DNS domain" htmlFor={`${id}-searchdomain`} error={errors.searchdomain}>
        <Input
          id={`${id}-searchdomain`}
          value={form.searchdomain}
          onChange={(e) => set('searchdomain', e.target.value)}
          disabled={busy}
          aria-invalid={errors.searchdomain !== undefined || undefined}
          placeholder="lab.example.com"
          autoComplete="off"
        />
      </Field>
      <Field
        label="DNS servers"
        htmlFor={`${id}-nameserver`}
        error={errors.nameserver}
        hint="Up to three addresses, separated by commas or spaces."
      >
        <Input
          id={`${id}-nameserver`}
          value={form.nameserverText}
          onChange={(e) => set('nameserverText', e.target.value)}
          disabled={busy}
          aria-invalid={errors.nameserver !== undefined || undefined}
          placeholder="1.1.1.1 9.9.9.9"
          autoComplete="off"
        />
      </Field>
    </Section>
  );
}

// --- Confirm ----------------------------------------------------------------------------------

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid grid-cols-[8rem_1fr] gap-2 text-sm">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="min-w-0 break-words">{children}</dd>
    </div>
  );
}

/** The summary of everything entered. The password is never shown, only that one is set. */
export function ConfirmStep({ form }: { form: CtForm }) {
  const keys = parseSshKeys(form.sshKeysText);
  const tags = parseTagList(form.tagsText);
  const servers = parseNameservers(form.nameserverText);
  return (
    <dl className="flex flex-col gap-1.5" data-testid="ct-summary">
      <Row label="Node">{form.node}</Row>
      <Row label="CT ID">{form.vmidText.trim()}</Row>
      <Row label="Hostname">{form.hostname.trim()}</Row>
      <Row label="Container">
        {form.unprivileged ? 'Unprivileged' : 'Privileged'}
        {form.nesting ? ', nesting on' : ''}
      </Row>
      {form.pool.trim() !== '' && <Row label="Resource pool">{form.pool.trim()}</Row>}
      {tags.length > 0 && <Row label="Tags">{tags.join(', ')}</Row>}
      <Row label="Password">{form.password !== '' ? '••••••' : 'Not set'}</Row>
      {keys.length > 0 && <Row label="SSH keys">{keys.length === 1 ? '1 key' : `${keys.length} keys`}</Row>}
      <Row label="Template">{templateName(form.templateVolid)}</Row>
      <Row label="Root disk">
        {form.rootStorage}: {form.sizeText.trim()} GiB
        {form.acl ? ', ACL' : ''}
        {form.quota ? ', quota' : ''}
      </Row>
      <Row label="CPU">
        {form.coresText.trim()} {form.coresText.trim() === '1' ? 'core' : 'cores'}
        {form.cpulimitText.trim() !== '' ? `, limit ${form.cpulimitText.trim()}` : ''}
        {form.cpuunitsText.trim() !== '' ? `, units ${form.cpuunitsText.trim()}` : ''}
      </Row>
      <Row label="Memory">
        {form.memoryText.trim()} MiB, swap {form.swapText.trim()} MiB
      </Row>
      <Row label="Network">{describeNetwork(form)}</Row>
      <Row label="DNS">
        {servers.length === 0 && form.searchdomain.trim() === ''
          ? 'Use host settings'
          : [form.searchdomain.trim(), servers.join(' ')].filter((s) => s !== '').join('; ')}
      </Row>
      <Row label="Start">{form.startAfter ? 'After created' : 'No'}</Row>
    </dl>
  );
}
