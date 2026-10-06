import type { CreateCtBody, CreateCtNet } from '@/api/createCt';
import { isValidDnsName, MAX_HOSTNAME_LENGTH } from '@/lib/guestName';
import {
  isIPv4,
  isIPv4Cidr,
  isIPv6,
  isIPv6Cidr,
  isUnicastMac,
  isValidBridgeName,
  isValidLxcIfName,
} from '@/lib/pve-config';

/**
 * The Create CT wizard's form model: every field as the user typed it (text stays text until the
 * request body is built), the per-step validation and the body builder. Pure -- no React -- so the
 * rules are testable and the steps stay thin. The rules mirror the server route
 * (`apps/server/src/actions/createCtRoutes.ts`), which is what actually protects PVE.
 */

export type Ip4Mode = 'dhcp' | 'static' | 'manual';
export type Ip6Mode = 'none' | 'auto' | 'dhcp' | 'static' | 'manual';

export interface CtForm {
  // General
  node: string;
  vmidText: string;
  hostname: string;
  unprivileged: boolean;
  nesting: boolean;
  pool: string;
  tagsText: string;
  password: string;
  passwordConfirm: string;
  sshKeysText: string;
  startAfter: boolean;
  // Template
  templateStorage: string;
  templateVolid: string;
  // Disks
  rootStorage: string;
  sizeText: string;
  acl: boolean;
  quota: boolean;
  // CPU
  coresText: string;
  cpulimitText: string;
  cpuunitsText: string;
  // Memory
  memoryText: string;
  swapText: string;
  // Network
  noNetwork: boolean;
  netName: string;
  bridge: string;
  ip4Mode: Ip4Mode;
  ip4: string;
  gw4: string;
  ip6Mode: Ip6Mode;
  ip6: string;
  gw6: string;
  vlanText: string;
  firewall: boolean;
  overrideMac: boolean;
  macText: string;
  // DNS
  nameserverText: string;
  searchdomain: string;
}

export function defaultCtForm(node: string): CtForm {
  return {
    node,
    vmidText: '',
    hostname: '',
    unprivileged: true,
    nesting: true,
    pool: '',
    tagsText: '',
    password: '',
    passwordConfirm: '',
    sshKeysText: '',
    startAfter: false,
    templateStorage: '',
    templateVolid: '',
    rootStorage: '',
    sizeText: '8',
    acl: false,
    quota: false,
    coresText: '1',
    cpulimitText: '',
    cpuunitsText: '',
    memoryText: '512',
    swapText: '512',
    noNetwork: false,
    netName: 'eth0',
    bridge: '',
    ip4Mode: 'dhcp',
    ip4: '',
    gw4: '',
    ip6Mode: 'none',
    ip6: '',
    gw6: '',
    vlanText: '',
    firewall: true,
    overrideMac: false,
    macText: '',
    nameserverText: '',
    searchdomain: '',
  };
}

export const STEPS = ['General', 'Template', 'Disks', 'CPU', 'Memory', 'Network', 'DNS', 'Confirm'] as const;
export type CtStep = (typeof STEPS)[number];

export type StepErrors = Record<string, string | undefined>;

export interface StepCheck {
  /** Inline messages, keyed by field. A required field that is simply empty has no message (the
   * step is just not `ok` yet). */
  errors: StepErrors;
  ok: boolean;
}

// These mirror the server route's own schema (`createCtRoutes.ts`).
const SSH_KEY_RE =
  /^(ssh-(rsa|ed25519|dss)|ecdsa-sha2-nistp(256|384|521)|sk-ssh-ed25519@openssh\.com|sk-ecdsa-sha2-nistp256@openssh\.com) [A-Za-z0-9+/=]+( [^\r\n]{0,256})?$/;
const POOL_RE = /^[A-Za-z0-9._-]{1,64}$/;
const TAG_RE = /^[a-z0-9_][a-z0-9_\-+.]*$/i;
const MAX_TAGS = 32;
const MAX_TAG_LENGTH = 64;
const MAX_SSH_KEYS = 64;
const MAX_NAMESERVERS = 3;

/** Whole-number text within `[min, max]`. */
export function intInRange(text: string, min: number, max: number): boolean {
  const t = text.trim();
  return /^\d+$/.test(t) && Number(t) >= min && Number(t) <= max;
}

/** A decimal number text within `[min, max]`. */
function numberInRange(text: string, min: number, max: number): boolean {
  const t = text.trim();
  return /^\d+(\.\d+)?$/.test(t) && Number(t) >= min && Number(t) <= max;
}

export function parseVmid(text: string): number | undefined {
  return intInRange(text, 100, 999999999) ? Number(text.trim()) : undefined;
}

/** One key per line, blank lines dropped. */
export function parseSshKeys(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l !== '');
}

/** Tags separated by commas, semicolons or whitespace. */
export function parseTagList(text: string): string[] {
  return text
    .split(/[\s,;]+/)
    .map((t) => t.trim())
    .filter((t) => t !== '');
}

/** Name servers separated by commas, semicolons or whitespace. */
export function parseNameservers(text: string): string[] {
  return text
    .split(/[\s,;]+/)
    .map((t) => t.trim())
    .filter((t) => t !== '');
}

function checkGeneral(f: CtForm): StepCheck {
  const errors: StepErrors = {};
  const vmid = f.vmidText.trim();
  if (vmid !== '' && parseVmid(vmid) === undefined) errors.vmid = 'The CT ID must be a whole number from 100 to 999999999.';
  const hostname = f.hostname.trim();
  if (hostname !== '' && !isValidDnsName(hostname, MAX_HOSTNAME_LENGTH)) {
    errors.hostname = 'Use letters, digits and hyphens; dots separate labels.';
  }
  if (f.pool.trim() !== '' && !POOL_RE.test(f.pool.trim())) errors.pool = 'Enter a valid pool name.';
  const tags = parseTagList(f.tagsText);
  if (tags.length > MAX_TAGS || tags.some((t) => t.length > MAX_TAG_LENGTH || !TAG_RE.test(t))) {
    errors.tags = 'Tags may contain letters, digits and _ - + . only.';
  }
  if (f.password !== '' && f.password.length < 5) errors.password = 'The password must be at least 5 characters.';
  else if (f.password.length > 256) errors.password = 'The password must be at most 256 characters.';
  if (f.passwordConfirm !== '' && f.password !== f.passwordConfirm) errors.passwordConfirm = 'The passwords do not match.';
  const keys = parseSshKeys(f.sshKeysText);
  if (keys.length > MAX_SSH_KEYS || keys.some((k) => !SSH_KEY_RE.test(k))) {
    errors.sshKeys = 'Enter OpenSSH public keys, one per line.';
  }
  const hasPassword = f.password !== '';
  const passwordOk = hasPassword && errors.password === undefined && f.password === f.passwordConfirm;
  const keysOk = keys.length > 0 && errors.sshKeys === undefined;
  // A root password OR an SSH key is required; a password that is started must be valid and confirmed.
  const credentialOk = hasPassword ? passwordOk && errors.sshKeys === undefined : keysOk;
  const ok =
    f.node !== '' &&
    parseVmid(vmid) !== undefined &&
    hostname !== '' &&
    errors.hostname === undefined &&
    errors.pool === undefined &&
    errors.tags === undefined &&
    credentialOk &&
    errors.passwordConfirm === undefined;
  return { errors, ok };
}

function checkTemplate(f: CtForm): StepCheck {
  return { errors: {}, ok: f.templateStorage !== '' && f.templateVolid.startsWith(`${f.templateStorage}:vztmpl/`) };
}

function checkDisks(f: CtForm): StepCheck {
  const errors: StepErrors = {};
  if (f.sizeText.trim() !== '' && !intInRange(f.sizeText, 1, 65536)) errors.size = 'The size must be 1 to 65536 GiB.';
  return { errors, ok: f.rootStorage !== '' && intInRange(f.sizeText, 1, 65536) };
}

function checkCpu(f: CtForm): StepCheck {
  const errors: StepErrors = {};
  if (f.coresText.trim() !== '' && !intInRange(f.coresText, 1, 128)) errors.cores = 'Cores must be 1 to 128.';
  if (f.cpulimitText.trim() !== '' && !numberInRange(f.cpulimitText, 0, 128)) errors.cpulimit = 'The CPU limit must be 0 to 128.';
  if (f.cpuunitsText.trim() !== '' && !intInRange(f.cpuunitsText, 0, 100000)) errors.cpuunits = 'CPU units must be 0 to 100000.';
  const ok =
    intInRange(f.coresText, 1, 128) && errors.cpulimit === undefined && errors.cpuunits === undefined;
  return { errors, ok };
}

function checkMemory(f: CtForm): StepCheck {
  const errors: StepErrors = {};
  if (f.memoryText.trim() !== '' && !intInRange(f.memoryText, 16, 4194304)) errors.memory = 'Memory must be 16 to 4194304 MiB.';
  if (f.swapText.trim() !== '' && !intInRange(f.swapText, 0, 4194304)) errors.swap = 'Swap must be 0 to 4194304 MiB.';
  return { errors, ok: intInRange(f.memoryText, 16, 4194304) && intInRange(f.swapText, 0, 4194304) };
}

function checkNetwork(f: CtForm): StepCheck {
  const errors: StepErrors = {};
  if (f.noNetwork) return { errors, ok: true };
  if (!isValidLxcIfName(f.netName.trim())) errors.name = 'The interface name must look like eth0.';
  if (f.bridge !== '' && !isValidBridgeName(f.bridge.trim())) errors.bridge = 'Enter a valid bridge name (e.g. vmbr0).';
  if (f.ip4Mode === 'static') {
    if (f.ip4.trim() !== '' && !isIPv4Cidr(f.ip4.trim())) errors.ip4 = 'Enter an address with prefix, e.g. 10.0.0.5/24.';
    if (f.gw4.trim() !== '' && !isIPv4(f.gw4.trim())) errors.gw4 = 'Enter a valid IPv4 gateway.';
  }
  if (f.ip6Mode === 'static') {
    if (f.ip6.trim() !== '' && !isIPv6Cidr(f.ip6.trim())) errors.ip6 = 'Enter an address with prefix, e.g. fd00::5/64.';
    if (f.gw6.trim() !== '' && !isIPv6(f.gw6.trim())) errors.gw6 = 'Enter a valid IPv6 gateway.';
  }
  if (f.vlanText.trim() !== '' && !intInRange(f.vlanText, 1, 4094)) errors.vlan = 'The VLAN tag must be 1 to 4094.';
  if (f.overrideMac && f.macText.trim() !== '' && !isUnicastMac(f.macText.trim())) {
    errors.mac = 'Enter a unicast MAC like BC:24:11:AA:BB:CC.';
  }
  const ok =
    isValidBridgeName(f.bridge.trim()) &&
    Object.values(errors).every((e) => e === undefined) &&
    (f.ip4Mode !== 'static' || isIPv4Cidr(f.ip4.trim())) &&
    (f.ip6Mode !== 'static' || isIPv6Cidr(f.ip6.trim())) &&
    (!f.overrideMac || isUnicastMac(f.macText.trim()));
  return { errors, ok };
}

function checkDns(f: CtForm): StepCheck {
  const errors: StepErrors = {};
  const servers = parseNameservers(f.nameserverText);
  if (servers.length > MAX_NAMESERVERS) errors.nameserver = 'At most three name servers.';
  else if (servers.some((s) => !isIPv4(s) && !isIPv6(s))) errors.nameserver = 'Enter IP addresses separated by commas or spaces.';
  const domain = f.searchdomain.trim();
  if (domain !== '' && !isValidDnsName(domain, MAX_HOSTNAME_LENGTH)) errors.searchdomain = 'Enter a valid DNS domain.';
  return { errors, ok: errors.nameserver === undefined && errors.searchdomain === undefined };
}

export function checkStep(step: CtStep, f: CtForm): StepCheck {
  switch (step) {
    case 'General':
      return checkGeneral(f);
    case 'Template':
      return checkTemplate(f);
    case 'Disks':
      return checkDisks(f);
    case 'CPU':
      return checkCpu(f);
    case 'Memory':
      return checkMemory(f);
    case 'Network':
      return checkNetwork(f);
    case 'DNS':
      return checkDns(f);
    case 'Confirm':
      return { errors: {}, ok: true };
  }
}

/** Whether every step before Confirm is complete (what the Create button needs). */
export function allStepsOk(f: CtForm): boolean {
  return STEPS.slice(0, -1).every((s) => checkStep(s, f).ok);
}

/** The NIC part of the request, or `null` for "no network". */
function buildNet(f: CtForm): CreateCtNet | null {
  if (f.noNetwork) return null;
  const net: CreateCtNet = { name: f.netName.trim(), bridge: f.bridge.trim(), firewall: f.firewall };
  if (f.ip4Mode === 'static') {
    net.ip = f.ip4.trim();
    if (f.gw4.trim() !== '') net.gw = f.gw4.trim();
  } else {
    net.ip = f.ip4Mode;
  }
  if (f.ip6Mode === 'static') {
    net.ip6 = f.ip6.trim();
    if (f.gw6.trim() !== '') net.gw6 = f.gw6.trim();
  } else if (f.ip6Mode !== 'none') {
    net.ip6 = f.ip6Mode;
  }
  if (f.vlanText.trim() !== '') net.tag = Number(f.vlanText.trim());
  if (f.overrideMac && f.macText.trim() !== '') net.hwaddr = f.macText.trim();
  return net;
}

/**
 * The request body for a complete form (call only once `allStepsOk`). Optional parts the user left
 * alone (pool, tags, SSH keys, ACL/quota, CPU limit/units, DNS) are left OUT, so PVE's own defaults
 * apply and the container inherits the host's resolver settings.
 */
export function buildCreateCtBody(f: CtForm): CreateCtBody {
  const body: CreateCtBody = {
    vmid: Number(f.vmidText.trim()),
    hostname: f.hostname.trim(),
    start: f.startAfter,
    unprivileged: f.unprivileged,
    nesting: f.nesting,
    template: { storage: f.templateStorage, volid: f.templateVolid },
    rootfs: { storage: f.rootStorage, sizeGiB: Number(f.sizeText.trim()) },
    cpu: { cores: Number(f.coresText.trim()) },
    memory: { memoryMiB: Number(f.memoryText.trim()), swapMiB: Number(f.swapText.trim()) },
    net: buildNet(f),
  };
  if (f.pool.trim() !== '') body.pool = f.pool.trim();
  const tags = parseTagList(f.tagsText);
  if (tags.length > 0) body.tags = tags;
  if (f.password !== '') body.password = f.password;
  const keys = parseSshKeys(f.sshKeysText);
  if (keys.length > 0) body.sshKeys = keys;
  if (f.acl) body.rootfs.acl = true;
  if (f.quota) body.rootfs.quota = true;
  if (f.cpulimitText.trim() !== '') body.cpu.cpulimit = Number(f.cpulimitText.trim());
  if (f.cpuunitsText.trim() !== '') body.cpu.cpuunits = Number(f.cpuunitsText.trim());
  const servers = parseNameservers(f.nameserverText);
  const domain = f.searchdomain.trim();
  if (servers.length > 0 || domain !== '') {
    body.dns = {
      ...(servers.length > 0 ? { nameserver: servers } : {}),
      ...(domain !== '' ? { searchdomain: domain } : {}),
    };
  }
  return body;
}

/** `eth0: vmbr0, DHCP, SLAAC, VLAN 20` -- the Confirm step's one-line network summary. */
export function describeNetwork(f: CtForm): string {
  if (f.noNetwork) return 'No network device';
  const parts = [`${f.netName.trim()} on ${f.bridge.trim()}`];
  parts.push(
    f.ip4Mode === 'dhcp'
      ? 'IPv4 DHCP'
      : f.ip4Mode === 'manual'
        ? 'IPv4 manual'
        : `IPv4 ${f.ip4.trim()}${f.gw4.trim() !== '' ? ` via ${f.gw4.trim()}` : ''}`,
  );
  if (f.ip6Mode !== 'none') {
    parts.push(
      f.ip6Mode === 'auto'
        ? 'IPv6 SLAAC'
        : f.ip6Mode === 'dhcp'
          ? 'IPv6 DHCP'
          : f.ip6Mode === 'manual'
            ? 'IPv6 manual'
            : `IPv6 ${f.ip6.trim()}${f.gw6.trim() !== '' ? ` via ${f.gw6.trim()}` : ''}`,
    );
  }
  if (f.vlanText.trim() !== '') parts.push(`VLAN ${f.vlanText.trim()}`);
  parts.push(f.firewall ? 'firewall on' : 'firewall off');
  return parts.join(', ');
}
