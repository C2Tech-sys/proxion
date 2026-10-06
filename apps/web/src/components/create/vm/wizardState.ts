import type { DiskBus, DiskCache, DiskFormat } from '@/api/disks';
import type {
  CreateVmBios,
  CreateVmBody,
  CreateVmDisk,
  CreateVmMachine,
  CreateVmNet,
  CreateVmNicModel,
  CreateVmScsiHw,
  CreateVmVga,
} from '@/api/createVm';
import { isValidDnsName } from '@/lib/guestName';

/**
 * The Create VM wizard's form state, per-step validation and the request body it builds. Pure (no
 * React): the step components read/patch `VmForm`, `stepErrors` says what blocks "Next", and
 * `buildCreateVmBody` is the one place the form becomes the server's strict body.
 */

export type StepId = 'general' | 'os' | 'system' | 'disks' | 'cpu' | 'memory' | 'network' | 'confirm';

export const STEPS: ReadonlyArray<{ id: StepId; label: string }> = [
  { id: 'general', label: 'General' },
  { id: 'os', label: 'OS' },
  { id: 'system', label: 'System' },
  { id: 'disks', label: 'Disks' },
  { id: 'cpu', label: 'CPU' },
  { id: 'memory', label: 'Memory' },
  { id: 'network', label: 'Network' },
  { id: 'confirm', label: 'Confirm' },
];

/** `name` is capped at 63 characters, same as the server route. */
export const MAX_NAME_LENGTH = 63;
export const MIN_VMID = 100;
export const MAX_VMID = 999999999;
export const MAX_DISK_GIB = 65536;
export const MAX_MEMORY_MIB = 4194304;
export const DEFAULT_CPU_TYPE = 'x86-64-v2-AES';

const POOL_RE = /^[A-Za-z][A-Za-z0-9_-]{0,62}$/;
const TAG_RE = /^[a-z0-9_][a-z0-9_\-+.]*$/i;
const MAX_TAGS = 32;
const MAX_TAG_LENGTH = 64;
const CPU_TYPE_RE = /^[A-Za-z0-9._+-]{1,64}$/;

export interface VmForm {
  // General
  node: string;
  vmidText: string;
  /** Set once the user edits the VM ID, so a late `nextid` answer never overwrites it. */
  vmidTouched: boolean;
  name: string;
  pool: string;
  tagsText: string;
  start: boolean;
  // OS
  mediaKind: 'iso' | 'none';
  isoStorage: string;
  isoVolid: string;
  ostype: string;
  agent: boolean;
  /** Set once the user toggles the agent box, so changing the OS type stops re-defaulting it. */
  agentTouched: boolean;
  // System
  machine: CreateVmMachine;
  bios: CreateVmBios;
  efiStorage: string;
  tpm: boolean;
  tpmTouched: boolean;
  tpmStorage: string;
  scsihw: CreateVmScsiHw;
  /** `''` = PVE's default display. */
  vga: CreateVmVga | '';
  // Disks
  noDisk: boolean;
  bus: DiskBus;
  diskStorage: string;
  sizeText: string;
  /** `''` = the storage's default format. */
  format: DiskFormat | '';
  discard: boolean;
  ssd: boolean;
  iothread: boolean;
  /** `''` = PVE's default cache mode. */
  cache: DiskCache | '';
  // CPU
  socketsText: string;
  coresText: string;
  cpuType: string;
  // Memory
  memoryText: string;
  balloonText: string;
  // Network
  noNet: boolean;
  bridge: string;
  nicModel: CreateVmNicModel;
  vlanText: string;
  firewall: boolean;
}

export const isLinuxOs = (ostype: string): boolean => ostype === 'l26' || ostype === 'l24';
export const isWindowsOs = (ostype: string): boolean => ostype.startsWith('win') || ostype.startsWith('w2k') || ostype === 'wxp' || ostype === 'wvista';

export function initialForm(node: string): VmForm {
  return {
    node,
    vmidText: '',
    vmidTouched: false,
    name: '',
    pool: '',
    tagsText: '',
    start: false,
    mediaKind: 'iso',
    isoStorage: '',
    isoVolid: '',
    ostype: 'l26',
    agent: true,
    agentTouched: false,
    machine: 'q35',
    bios: 'seabios',
    efiStorage: '',
    tpm: false,
    tpmTouched: false,
    tpmStorage: '',
    scsihw: 'virtio-scsi-single',
    vga: '',
    noDisk: false,
    bus: 'scsi',
    diskStorage: '',
    sizeText: '32',
    format: '',
    discard: false,
    ssd: false,
    iothread: false,
    cache: '',
    socketsText: '1',
    coresText: '2',
    cpuType: DEFAULT_CPU_TYPE,
    memoryText: '2048',
    balloonText: '',
    noNet: false,
    bridge: '',
    nicModel: 'virtio',
    vlanText: '',
    firewall: true,
  };
}

/** An error to show under a text field only once the user has typed something (an empty required
 * field just keeps "Next" disabled instead of shouting). */
export function typedError(value: string, error: string | undefined): string | undefined {
  return value.trim() === '' ? undefined : error;
}

/** What the wizard's lookups have produced so far (`undefined` = still loading / not available). */
export interface FormDefaults {
  nextVmid: number | undefined;
  /** Node names in the cluster, with the first online one preferred as the default. */
  nodes: ReadonlyArray<{ name: string; status: string }> | undefined;
  isoStorageIds: readonly string[] | undefined;
  imageStorageIds: readonly string[] | undefined;
  bridgeIds: readonly string[] | undefined;
}

/**
 * The form as the user sees it: their own choices (`raw`), with every "not chosen yet" value filled
 * in from what the lookups returned -- the next free VM id, the first online node, the first
 * storage of each kind, the first bridge. Derived during render instead of copied into state by
 * effects, so a late lookup can never overwrite a choice: a choice that is no longer valid for the
 * node's lists (the node changed) simply falls back to the first entry.
 */
export function resolveForm(raw: VmForm, defaults: FormDefaults): VmForm {
  const pick = (current: string, ids: readonly string[] | undefined): string =>
    ids === undefined ? current : ids.includes(current) ? current : (ids[0] ?? '');
  const firstNode = defaults.nodes?.find((n) => n.status === 'online') ?? defaults.nodes?.[0];
  return {
    ...raw,
    node: raw.node !== '' ? raw.node : (firstNode?.name ?? ''),
    vmidText: raw.vmidTouched || defaults.nextVmid === undefined ? raw.vmidText : String(defaults.nextVmid),
    isoStorage: pick(raw.isoStorage, defaults.isoStorageIds),
    diskStorage: pick(raw.diskStorage, defaults.imageStorageIds),
    efiStorage: pick(raw.efiStorage, defaults.imageStorageIds),
    tpmStorage: pick(raw.tpmStorage, defaults.imageStorageIds),
    // An empty bridge list means the node's bridges could not be listed: the field is free text.
    bridge: defaults.bridgeIds !== undefined && defaults.bridgeIds.length > 0 ? pick(raw.bridge, defaults.bridgeIds) : raw.bridge,
  };
}

/** A whole number of digits only, within `[min, max]`; `undefined` otherwise (incl. empty). */
export function parseIntIn(text: string, min: number, max: number): number | undefined {
  const trimmed = text.trim();
  if (!/^\d+$/.test(trimmed)) return undefined;
  const n = Number(trimmed);
  return n >= min && n <= max ? n : undefined;
}

/** The tags the text field holds: split on whitespace, `,` and `;`, deduped, order kept. */
export function parseTagList(text: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const tag of text.split(/[\s,;]+/)) {
    if (tag === '' || seen.has(tag)) continue;
    seen.add(tag);
    out.push(tag);
  }
  return out;
}

export type FieldErrors = Partial<Record<string, string>>;

/** What blocks "Next" on `step`, keyed by field; an empty object means the step is valid. */
export function stepErrors(step: StepId, form: VmForm): FieldErrors {
  const errors: FieldErrors = {};
  switch (step) {
    case 'general': {
      if (form.node === '') errors.node = 'Choose a node.';
      if (parseIntIn(form.vmidText, MIN_VMID, MAX_VMID) === undefined) {
        errors.vmid = `Enter a whole number between ${MIN_VMID} and ${MAX_VMID}.`;
      }
      if (form.name === '') errors.name = 'Enter a name.';
      else if (!isValidDnsName(form.name, MAX_NAME_LENGTH)) {
        errors.name = 'Use letters, digits and hyphens (dot-separated labels, up to 63 characters).';
      }
      if (form.pool !== '' && !POOL_RE.test(form.pool)) {
        errors.pool = 'A pool name starts with a letter and uses letters, digits, _ and -.';
      }
      const tags = parseTagList(form.tagsText);
      if (tags.length > MAX_TAGS || tags.some((t) => t.length > MAX_TAG_LENGTH || !TAG_RE.test(t))) {
        errors.tags = 'Tags use letters, digits and _ - + . only.';
      }
      break;
    }
    case 'os': {
      if (form.mediaKind === 'iso') {
        if (form.isoStorage === '') errors.isoStorage = 'Choose a storage that holds ISO images.';
        else if (!form.isoVolid.startsWith(`${form.isoStorage}:iso/`)) errors.isoVolid = 'Choose an ISO image.';
      }
      break;
    }
    case 'system': {
      if (form.bios === 'ovmf' && form.efiStorage === '') errors.efiStorage = 'Choose a storage for the EFI disk.';
      if (form.tpm && form.tpmStorage === '') errors.tpmStorage = 'Choose a storage for the TPM state.';
      break;
    }
    case 'disks': {
      if (!form.noDisk) {
        if (form.diskStorage === '') errors.diskStorage = 'Choose a storage for the disk.';
        if (parseIntIn(form.sizeText, 1, MAX_DISK_GIB) === undefined) {
          errors.size = `Enter a whole number of GiB between 1 and ${MAX_DISK_GIB}.`;
        }
      }
      break;
    }
    case 'cpu': {
      if (parseIntIn(form.socketsText, 1, 4) === undefined) errors.sockets = 'Enter 1 to 4 sockets.';
      if (parseIntIn(form.coresText, 1, 128) === undefined) errors.cores = 'Enter 1 to 128 cores.';
      if (!CPU_TYPE_RE.test(form.cpuType)) errors.cpuType = 'Choose a CPU type.';
      break;
    }
    case 'memory': {
      const memory = parseIntIn(form.memoryText, 16, MAX_MEMORY_MIB);
      if (memory === undefined) errors.memory = `Enter a whole number of MiB between 16 and ${MAX_MEMORY_MIB}.`;
      if (form.balloonText.trim() !== '') {
        const balloon = parseIntIn(form.balloonText, 0, MAX_MEMORY_MIB);
        if (balloon === undefined) errors.balloon = 'Enter a whole number of MiB (0 disables ballooning).';
        else if (memory !== undefined && balloon > memory) errors.balloon = 'The minimum memory cannot exceed the memory.';
      }
      break;
    }
    case 'network': {
      if (!form.noNet) {
        if (form.bridge === '') errors.bridge = 'Choose a bridge.';
        if (form.vlanText.trim() !== '' && parseIntIn(form.vlanText, 1, 4094) === undefined) {
          errors.vlan = 'A VLAN tag is 1 to 4094.';
        }
      }
      break;
    }
    case 'confirm':
      break;
  }
  return errors;
}

export function stepValid(step: StepId, form: VmForm): boolean {
  return Object.keys(stepErrors(step, form)).length === 0;
}

/** The first step (in order) that is invalid, or `undefined` when the whole form is valid. */
export function firstInvalidStep(form: VmForm): StepId | undefined {
  return STEPS.find((s) => !stepValid(s.id, form))?.id;
}

/**
 * The server's request body for `form`, or `undefined` while any step is invalid. Options left at
 * their defaults are omitted so PVE applies its own defaults (`format`, `cache`, `vga`, `pool`,
 * `tags`, `balloon`); `ssd`/`iothread` are dropped on a bus that doesn't support them.
 */
export function buildCreateVmBody(form: VmForm): CreateVmBody | undefined {
  if (firstInvalidStep(form) !== undefined) return undefined;
  const vmid = parseIntIn(form.vmidText, MIN_VMID, MAX_VMID);
  const sockets = parseIntIn(form.socketsText, 1, 4);
  const cores = parseIntIn(form.coresText, 1, 128);
  const memoryMiB = parseIntIn(form.memoryText, 16, MAX_MEMORY_MIB);
  if (vmid === undefined || sockets === undefined || cores === undefined || memoryMiB === undefined) return undefined;

  const body: CreateVmBody = {
    vmid,
    name: form.name,
    start: form.start,
    os:
      form.mediaKind === 'iso'
        ? { media: 'iso', storage: form.isoStorage, volid: form.isoVolid }
        : { media: 'none' },
    ostype: form.ostype,
    agent: form.agent,
    system: { machine: form.machine, bios: form.bios, scsihw: form.scsihw },
    disk: null,
    cpu: { sockets, cores, type: form.cpuType },
    memory: { memoryMiB },
    net: null,
  };

  if (form.pool !== '') body.pool = form.pool;
  const tags = parseTagList(form.tagsText);
  if (tags.length > 0) body.tags = tags;
  if (form.bios === 'ovmf') body.system.efiStorage = form.efiStorage;
  if (form.tpm) {
    body.system.tpm = true;
    body.system.tpmStorage = form.tpmStorage;
  }
  if (form.vga !== '') body.system.vga = form.vga;

  if (!form.noDisk) {
    const sizeGiB = parseIntIn(form.sizeText, 1, MAX_DISK_GIB);
    if (sizeGiB === undefined) return undefined;
    const disk: CreateVmDisk = { bus: form.bus, storage: form.diskStorage, sizeGiB };
    if (form.format !== '') disk.format = form.format;
    if (form.discard) disk.discard = true;
    if (form.ssd && form.bus !== 'virtio') disk.ssd = true;
    if (form.iothread && (form.bus === 'scsi' || form.bus === 'virtio')) disk.iothread = true;
    if (form.cache !== '') disk.cache = form.cache;
    body.disk = disk;
  }

  if (form.balloonText.trim() !== '') {
    const balloon = parseIntIn(form.balloonText, 0, MAX_MEMORY_MIB);
    if (balloon !== undefined) body.memory.balloonMiB = balloon;
  }

  if (!form.noNet) {
    const net: CreateVmNet = { model: form.nicModel, bridge: form.bridge, firewall: form.firewall };
    const tag = form.vlanText.trim() === '' ? undefined : parseIntIn(form.vlanText, 1, 4094);
    if (tag !== undefined) net.tag = tag;
    body.net = net;
  }
  return body;
}

/** The ISO file name of a volid (`local:iso/debian.iso` -> `debian.iso`). */
export function isoFileName(volid: string): string {
  const slash = volid.indexOf('/');
  return slash === -1 ? volid : volid.slice(slash + 1);
}

export interface SummaryRow {
  label: string;
  value: string;
}

/** The Confirm step's key/value summary of everything the request will carry. */
export function summaryRows(body: CreateVmBody, node: string): SummaryRow[] {
  const rows: SummaryRow[] = [
    { label: 'Node', value: node },
    { label: 'VM ID', value: String(body.vmid) },
    { label: 'Name', value: body.name },
  ];
  if (body.pool !== undefined) rows.push({ label: 'Resource pool', value: body.pool });
  if (body.tags !== undefined) rows.push({ label: 'Tags', value: body.tags.join(', ') });
  rows.push({ label: 'Start after created', value: body.start ? 'Yes' : 'No' });
  rows.push({
    label: 'Install media',
    value: body.os.media === 'iso' ? body.os.volid : 'None',
  });
  rows.push({ label: 'OS type', value: body.ostype });
  rows.push({ label: 'QEMU guest agent', value: body.agent ? 'Enabled' : 'Disabled' });
  rows.push({ label: 'Machine', value: body.system.machine === 'q35' ? 'q35' : 'i440fx (default)' });
  rows.push({ label: 'BIOS', value: body.system.bios === 'ovmf' ? 'OVMF (UEFI)' : 'SeaBIOS' });
  if (body.system.efiStorage !== undefined) rows.push({ label: 'EFI disk storage', value: body.system.efiStorage });
  if (body.system.tpm === true) rows.push({ label: 'TPM state storage', value: body.system.tpmStorage ?? '' });
  rows.push({ label: 'SCSI controller', value: body.system.scsihw });
  if (body.system.vga !== undefined) rows.push({ label: 'Display', value: body.system.vga });
  if (body.disk === null) {
    rows.push({ label: 'Disk', value: 'None' });
  } else {
    const extras = [
      body.disk.format,
      body.disk.discard === true ? 'discard' : undefined,
      body.disk.ssd === true ? 'ssd' : undefined,
      body.disk.iothread === true ? 'iothread' : undefined,
      body.disk.cache !== undefined ? `cache ${body.disk.cache}` : undefined,
    ].filter((x): x is string => x !== undefined);
    rows.push({
      label: 'Disk',
      value: `${body.disk.bus}0: ${body.disk.sizeGiB} GiB on ${body.disk.storage}${extras.length > 0 ? ` (${extras.join(', ')})` : ''}`,
    });
  }
  rows.push({
    label: 'CPU',
    value: `${body.cpu.sockets} socket${body.cpu.sockets === 1 ? '' : 's'} x ${body.cpu.cores} core${body.cpu.cores === 1 ? '' : 's'}, ${body.cpu.type}`,
  });
  rows.push({ label: 'Memory', value: `${body.memory.memoryMiB} MiB` });
  if (body.memory.balloonMiB !== undefined) {
    rows.push({
      label: 'Minimum memory',
      value: body.memory.balloonMiB === 0 ? 'Ballooning disabled' : `${body.memory.balloonMiB} MiB`,
    });
  }
  if (body.net === null) {
    rows.push({ label: 'Network', value: 'None' });
  } else {
    rows.push({
      label: 'Network',
      value: [
        `net0: ${body.net.model} on ${body.net.bridge}`,
        body.net.tag !== undefined ? `VLAN ${body.net.tag}` : undefined,
        body.net.firewall ? 'firewall on' : 'firewall off',
        'MAC automatic',
      ]
        .filter((x): x is string => x !== undefined)
        .join(', '),
    });
  }
  return rows;
}
