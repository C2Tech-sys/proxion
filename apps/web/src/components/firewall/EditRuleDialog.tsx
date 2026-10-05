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
import {
  RULE_TYPES,
  NAMED_PROTOCOLS,
  buildCreateBody,
  buildUpdatePatch,
  formFromRule,
  isRuleType,
  validateRuleForm,
  type RuleForm,
} from '@/components/firewall/ruleForm';
import { hardwareErrorMessage } from '@/api/hardwareHooks';
import {
  useAddFirewallRule,
  useFirewallMacros,
  useSecurityGroups,
  useUpdateFirewallRule,
} from '@/api/firewallHooks';
import { FIREWALL_LOG_LEVELS, FIREWALL_VERDICTS, type FirewallRule, type FirewallRuleType } from '@/api/firewall';
import type { GuestType } from '@/api/types';

export interface EditRuleDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  node: string;
  type: GuestType;
  vmid: number;
  /** The rule being edited. Omit to add a new rule (appended to the end of the list). */
  rule?: FirewallRule | undefined;
  /** The type a new rule starts as: `group` for the "Add security group" button. */
  initialType?: FirewallRuleType | undefined;
  /** How many rules the guest has now: a new rule is inserted at this position (the end). */
  ruleCount: number;
  /** The guest's `net<n>` config keys, for the interface picker. */
  netKeys: string[];
  /** The digest of the last rules read, forwarded on edits for optimistic concurrency. */
  digest?: string | undefined;
}

const TYPE_LABELS: Record<FirewallRuleType, string> = {
  in: 'in (incoming)',
  out: 'out (outgoing)',
  group: 'group (security group)',
};

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

/**
 * Adds or edits one guest firewall rule. A rule is `in` or `out` with a verdict (ACCEPT / DROP /
 * REJECT), or a `group` rule that applies a cluster security group; a group rule only carries the
 * group, an optional interface, a comment and the enabled flag. Every other field is optional and
 * blank means "any". An edit sends only what changed (a cleared field goes in PVE's `delete`
 * list) and forwards the digest of the last read so a concurrent change is rejected rather than
 * overwritten. A new rule is appended after the existing ones.
 *
 * Validation mirrors the server's (`firewallRoutes.ts`), shown inline; a server error stays inline
 * and the dialog stays open. Mount it fresh per open (the Firewall tab renders it conditionally).
 */
export function EditRuleDialog({
  open,
  onOpenChange,
  node,
  type,
  vmid,
  rule,
  initialType,
  ruleCount,
  netKeys,
  digest,
}: EditRuleDialogProps) {
  const id = useId();
  const isNew = rule === undefined;
  const add = useAddFirewallRule();
  const update = useUpdateFirewallRule();
  const mutation = isNew ? add : update;
  const groups = useSecurityGroups();
  const macros = useFirewallMacros();

  const [form, setForm] = useState<RuleForm>(() => formFromRule(rule, initialType ?? 'in'));
  const set = <K extends keyof RuleForm>(key: K, value: RuleForm[K]) => setForm((prev) => ({ ...prev, [key]: value }));

  const errors = validateRuleForm(form);
  const valid = Object.keys(errors).length === 0;
  const patch = rule !== undefined ? buildUpdatePatch(form, rule, digest) : undefined;
  const changed = isNew || patch !== undefined;
  const canSave = valid && changed && !mutation.isPending;
  const isGroup = form.type === 'group';
  const busy = mutation.isPending;

  const groupNames = (groups.data ?? []).map((g) => g.group);
  // The rule's current group is always an option, even if the lookup doesn't list it.
  const groupOptions = form.action !== '' && !groupNames.includes(form.action) && rule?.type === 'group'
    ? [...groupNames, form.action]
    : groupNames;
  const useGroupSelect = groups.isLoading || groupNames.length > 0;
  const ifaceOptions = form.iface !== '' && !netKeys.includes(form.iface) ? [...netKeys, form.iface] : netKeys;

  const serverError = mutation.isError ? hardwareErrorMessage(mutation.error, 'The firewall rule could not be saved.') : undefined;

  function changeType(next: string) {
    if (!isRuleType(next)) return;
    setForm((prev) => {
      // A verdict and a group name do not carry over to the other kind of rule.
      const wasGroup = prev.type === 'group';
      const nowGroup = next === 'group';
      return {
        ...prev,
        type: next,
        action: wasGroup === nowGroup ? prev.action : nowGroup ? '' : 'ACCEPT',
      };
    });
  }

  function submit() {
    if (!canSave) return;
    if (isNew) {
      add.mutate({ node, type, vmid, body: buildCreateBody(form, ruleCount) }, { onSuccess: () => onOpenChange(false) });
    } else if (rule !== undefined && patch !== undefined) {
      update.mutate({ node, type, vmid, pos: rule.pos, patch }, { onSuccess: () => onOpenChange(false) });
    }
  }

  function onKeyDown(event: KeyboardEvent<HTMLElement>) {
    if (event.key === 'Enter' && event.target instanceof HTMLInputElement) {
      event.preventDefault();
      submit();
    }
  }

  const title = isNew
    ? initialType === 'group'
      ? 'Add security group'
      : 'Add firewall rule'
    : `Edit firewall rule (${rule.pos})`;

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
            {isNew
              ? 'The rule is added after the existing ones; rules are evaluated top to bottom.'
              : 'Only the fields you change are sent. Leave a field empty to clear it.'}
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-4">
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Field label="Type" htmlFor={`${id}-type`}>
              <NativeSelect id={`${id}-type`} value={form.type} onChange={(e) => changeType(e.target.value)} disabled={busy}>
                {RULE_TYPES.map((t) => (
                  <option key={t} value={t}>
                    {TYPE_LABELS[t]}
                  </option>
                ))}
              </NativeSelect>
            </Field>

            {isGroup ? (
              <Field label="Security group" htmlFor={`${id}-group`} error={errors.action}>
                {useGroupSelect ? (
                  <NativeSelect
                    id={`${id}-group`}
                    value={form.action}
                    onChange={(e) => set('action', e.target.value)}
                    disabled={busy || groups.isLoading}
                    aria-invalid={errors.action !== undefined || undefined}
                  >
                    <option value="" disabled>
                      {groups.isLoading ? 'Loading groups...' : 'Select a group...'}
                    </option>
                    {groupOptions.map((g) => {
                      const info = groups.data?.find((x) => x.group === g);
                      return (
                        <option key={g} value={g}>
                          {info?.comment ? `${g} (${info.comment})` : g}
                        </option>
                      );
                    })}
                  </NativeSelect>
                ) : (
                  <Input
                    id={`${id}-group`}
                    value={form.action}
                    onChange={(e) => set('action', e.target.value)}
                    disabled={busy}
                    aria-invalid={errors.action !== undefined || undefined}
                    placeholder="webservers"
                    autoComplete="off"
                  />
                )}
              </Field>
            ) : (
              <Field label="Action" htmlFor={`${id}-action`} error={errors.action}>
                <NativeSelect
                  id={`${id}-action`}
                  value={form.action}
                  onChange={(e) => set('action', e.target.value)}
                  disabled={busy}
                >
                  {FIREWALL_VERDICTS.map((v) => (
                    <option key={v} value={v}>
                      {v}
                    </option>
                  ))}
                </NativeSelect>
              </Field>
            )}
          </div>

          {!isGroup && (
            <>
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <Field label="Macro" htmlFor={`${id}-macro`} error={errors.macro} hint="Optional, e.g. SSH or HTTPS.">
                  <Input
                    id={`${id}-macro`}
                    list={`${id}-macros`}
                    value={form.macro}
                    onChange={(e) => set('macro', e.target.value)}
                    disabled={busy}
                    aria-invalid={errors.macro !== undefined || undefined}
                    autoComplete="off"
                  />
                  <datalist id={`${id}-macros`}>
                    {(macros.data ?? []).map((m) => (
                      <option key={m.macro} value={m.macro}>
                        {m.descr}
                      </option>
                    ))}
                  </datalist>
                </Field>
                <Field label="Protocol" htmlFor={`${id}-proto`} error={errors.proto} hint="Blank is any protocol.">
                  <Input
                    id={`${id}-proto`}
                    list={`${id}-protos`}
                    value={form.proto}
                    onChange={(e) => set('proto', e.target.value)}
                    disabled={busy}
                    aria-invalid={errors.proto !== undefined || undefined}
                    autoComplete="off"
                  />
                  <datalist id={`${id}-protos`}>
                    {NAMED_PROTOCOLS.map((p) => (
                      <option key={p} value={p} />
                    ))}
                  </datalist>
                </Field>
                <Field label="Source" htmlFor={`${id}-source`} error={errors.source} hint="IP, CIDR, range, alias or +ipset.">
                  <Input
                    id={`${id}-source`}
                    value={form.source}
                    onChange={(e) => set('source', e.target.value)}
                    disabled={busy}
                    aria-invalid={errors.source !== undefined || undefined}
                    placeholder="10.0.0.0/24"
                    autoComplete="off"
                  />
                </Field>
                <Field label="Destination" htmlFor={`${id}-dest`} error={errors.dest} hint="IP, CIDR, range, alias or +ipset.">
                  <Input
                    id={`${id}-dest`}
                    value={form.dest}
                    onChange={(e) => set('dest', e.target.value)}
                    disabled={busy}
                    aria-invalid={errors.dest !== undefined || undefined}
                    autoComplete="off"
                  />
                </Field>
                <Field label="Source port" htmlFor={`${id}-sport`} error={errors.sport} hint="80, 8000:8100, a service name or a list.">
                  <Input
                    id={`${id}-sport`}
                    value={form.sport}
                    onChange={(e) => set('sport', e.target.value)}
                    disabled={busy}
                    aria-invalid={errors.sport !== undefined || undefined}
                    autoComplete="off"
                  />
                </Field>
                <Field label="Destination port" htmlFor={`${id}-dport`} error={errors.dport} hint="80, 8000:8100, a service name or a list.">
                  <Input
                    id={`${id}-dport`}
                    value={form.dport}
                    onChange={(e) => set('dport', e.target.value)}
                    disabled={busy}
                    aria-invalid={errors.dport !== undefined || undefined}
                    placeholder="22"
                    autoComplete="off"
                  />
                </Field>
              </div>
            </>
          )}

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Field label="Interface" htmlFor={`${id}-iface`}>
              <NativeSelect id={`${id}-iface`} value={form.iface} onChange={(e) => set('iface', e.target.value)} disabled={busy}>
                <option value="">Any</option>
                {ifaceOptions.map((n) => (
                  <option key={n} value={n}>
                    {n}
                  </option>
                ))}
              </NativeSelect>
            </Field>
            {!isGroup && (
              <Field label="Log level" htmlFor={`${id}-log`}>
                <NativeSelect
                  id={`${id}-log`}
                  value={form.log}
                  onChange={(e) => set('log', e.target.value as RuleForm['log'])}
                  disabled={busy}
                >
                  <option value="">Default (nolog)</option>
                  {FIREWALL_LOG_LEVELS.map((level) => (
                    <option key={level} value={level}>
                      {level}
                    </option>
                  ))}
                </NativeSelect>
              </Field>
            )}
          </div>

          <Field label="Comment" htmlFor={`${id}-comment`} error={errors.comment}>
            <Input
              id={`${id}-comment`}
              value={form.comment}
              onChange={(e) => set('comment', e.target.value)}
              disabled={busy}
              aria-invalid={errors.comment !== undefined || undefined}
              autoComplete="off"
            />
          </Field>

          <div className="flex items-center gap-2">
            <Checkbox
              id={`${id}-enable`}
              checked={form.enable}
              onCheckedChange={(c) => set('enable', c === true)}
              disabled={busy}
            />
            <label htmlFor={`${id}-enable`} className="text-sm">
              Enabled
            </label>
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
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
