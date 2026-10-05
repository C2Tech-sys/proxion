import {
  FIREWALL_LOG_LEVELS,
  FIREWALL_VERDICTS,
  type ClearableRuleField,
  type FirewallLogLevel,
  type FirewallRule,
  type FirewallRuleBody,
  type FirewallRulePatch,
  type FirewallRuleType,
} from '@/api/firewall';

/**
 * The firewall rule dialog's form model and its request builders. Validation mirrors the server's
 * (`firewallRoutes.ts`) so a typo is caught inline; PVE still validates the real grammar of
 * source/destination (IPs, CIDRs, ranges, aliases, `+ipset`, comma lists).
 */

export const RULE_TYPES: readonly FirewallRuleType[] = ['in', 'out', 'group'];
export const NAMED_PROTOCOLS = ['tcp', 'udp', 'icmp', 'icmpv6', 'ipv6-icmp'] as const;

const GROUP_NAME_RE = /^[A-Za-z][A-Za-z0-9_-]{1,19}$/;
const MACRO_RE = /^[A-Za-z0-9_-]{1,64}$/;
const ADDRESS_RE = /^[A-Za-z0-9_.:+/\-, ]+$/;
const PORT_ITEM = String.raw`(?:\d{1,5}(?::\d{1,5})?|[a-z][a-z0-9-]{1,30})`;
const PORTS_RE = new RegExp(`^${PORT_ITEM}(?:,${PORT_ITEM})*$`);
const MAX_ADDRESS_LENGTH = 512;
const MAX_COMMENT_LENGTH = 1024;

export interface RuleForm {
  type: FirewallRuleType;
  /** A verdict for in/out, a security-group name for group. */
  action: string;
  enable: boolean;
  macro: string;
  proto: string;
  source: string;
  dest: string;
  sport: string;
  dport: string;
  iface: string;
  /** `''` = not set (PVE's default applies). */
  log: FirewallLogLevel | '';
  comment: string;
}

export type RuleFormErrors = Partial<Record<'action' | 'macro' | 'proto' | 'source' | 'dest' | 'sport' | 'dport' | 'comment', string>>;

/** Fields a security-group rule cannot carry (PVE takes only the group, interface, comment and the
 * enable flag for it). */
const NON_GROUP_FIELDS = ['macro', 'proto', 'source', 'dest', 'sport', 'dport', 'log'] as const;
const STRING_FIELDS = ['macro', 'proto', 'source', 'dest', 'sport', 'dport', 'iface', 'log', 'comment'] as const;

export function isRuleType(value: string): value is FirewallRuleType {
  return (RULE_TYPES as readonly string[]).includes(value);
}

export function isVerdict(value: string): boolean {
  return (FIREWALL_VERDICTS as readonly string[]).includes(value);
}

function isLogLevel(value: string | undefined): value is FirewallLogLevel {
  return value !== undefined && (FIREWALL_LOG_LEVELS as readonly string[]).includes(value);
}

/** The form for an existing rule, or a blank one (of `initialType`) for a new rule. */
export function formFromRule(rule: FirewallRule | undefined, initialType: FirewallRuleType = 'in'): RuleForm {
  if (rule === undefined) {
    return {
      type: initialType,
      action: initialType === 'group' ? '' : 'ACCEPT',
      enable: true,
      macro: '',
      proto: '',
      source: '',
      dest: '',
      sport: '',
      dport: '',
      iface: '',
      log: '',
      comment: '',
    };
  }
  return {
    type: isRuleType(rule.type) ? rule.type : 'in',
    action: rule.action,
    enable: rule.enable !== 0,
    macro: rule.macro ?? '',
    proto: rule.proto ?? '',
    source: rule.source ?? '',
    dest: rule.dest ?? '',
    sport: rule.sport ?? '',
    dport: rule.dport ?? '',
    iface: rule.iface ?? '',
    log: isLogLevel(rule.log) ? rule.log : '',
    comment: rule.comment ?? '',
  };
}

function portsInRange(value: string): boolean {
  return value.split(/[,:]/).every((part) => !/^\d+$/.test(part) || Number(part) <= 65535);
}

function validProto(value: string): boolean {
  return (NAMED_PROTOCOLS as readonly string[]).includes(value) || (/^\d{1,3}$/.test(value) && Number(value) <= 255);
}

/** The form's values as the request will carry them: trimmed, with a group rule's inapplicable
 * fields dropped. */
export function effectiveForm(form: RuleForm): RuleForm {
  const trimmed: RuleForm = {
    ...form,
    action: form.action.trim(),
    macro: form.macro.trim(),
    proto: form.proto.trim(),
    source: form.source.trim(),
    dest: form.dest.trim(),
    sport: form.sport.trim(),
    dport: form.dport.trim(),
    comment: form.comment.trim(),
  };
  if (trimmed.type === 'group') {
    for (const field of NON_GROUP_FIELDS) trimmed[field] = '';
  }
  return trimmed;
}

export function validateRuleForm(form: RuleForm): RuleFormErrors {
  const f = effectiveForm(form);
  const errors: RuleFormErrors = {};
  if (f.type === 'group') {
    if (!GROUP_NAME_RE.test(f.action) || isVerdict(f.action)) errors.action = 'Choose or enter a security group name.';
  } else if (!isVerdict(f.action)) {
    errors.action = 'Choose ACCEPT, DROP or REJECT.';
  }
  if (f.macro !== '' && !MACRO_RE.test(f.macro)) errors.macro = 'A macro name is letters, digits, "-" and "_".';
  if (f.proto !== '' && !validProto(f.proto)) errors.proto = 'Use tcp, udp, icmp, icmpv6, ipv6-icmp or a number 0-255.';
  for (const field of ['source', 'dest'] as const) {
    const value = f[field];
    if (value !== '' && (value.length > MAX_ADDRESS_LENGTH || !ADDRESS_RE.test(value))) {
      errors[field] = 'Use an IP, CIDR, range, alias or +ipset (comma-separated).';
    }
  }
  for (const field of ['sport', 'dport'] as const) {
    const value = f[field];
    if (value !== '' && !(PORTS_RE.test(value) && portsInRange(value))) {
      errors[field] = 'Use ports (80), ranges (8000:8100), service names or a comma-separated list.';
    }
  }
  if (f.comment.length > MAX_COMMENT_LENGTH) errors.comment = `A comment is at most ${MAX_COMMENT_LENGTH} characters.`;
  return errors;
}

/** The `POST .../firewall/rules` body for a new rule, inserted at `pos` (the end of the list). */
export function buildCreateBody(form: RuleForm, pos: number): FirewallRuleBody {
  const f = effectiveForm(form);
  const body: FirewallRuleBody = { type: f.type, action: f.action, enable: f.enable };
  if (f.macro !== '') body.macro = f.macro;
  if (f.proto !== '') body.proto = f.proto;
  if (f.source !== '') body.source = f.source;
  if (f.dest !== '') body.dest = f.dest;
  if (f.sport !== '') body.sport = f.sport;
  if (f.dport !== '') body.dport = f.dport;
  if (f.iface !== '') body.iface = f.iface;
  if (f.log !== '') body.log = f.log;
  if (f.comment !== '') body.comment = f.comment;
  body.pos = pos;
  return body;
}

/** The `PUT .../firewall/rules/:pos` body: only what differs from `rule`, cleared fields in the
 * `delete` list. `undefined` when nothing changed. */
export function buildUpdatePatch(form: RuleForm, rule: FirewallRule, digest: string | undefined): FirewallRulePatch | undefined {
  const f = effectiveForm(form);
  const before = formFromRule(rule);
  const patch: FirewallRulePatch = {};
  const clear: ClearableRuleField[] = [];

  if (f.type !== before.type) patch.type = f.type;
  if (f.action !== before.action || f.type !== before.type) patch.action = f.action;
  if (f.enable !== before.enable) patch.enable = f.enable;
  for (const field of STRING_FIELDS) {
    const next = f[field];
    if (next === before[field]) continue;
    if (next === '') clear.push(field);
    else (patch as Record<string, unknown>)[field] = next;
  }
  if (clear.length > 0) patch.delete = clear;
  if (Object.keys(patch).length === 0) return undefined;
  if (digest !== undefined) patch.digest = digest;
  return patch;
}
