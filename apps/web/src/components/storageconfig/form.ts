import {
  CONTENT_BY_TYPE,
  DEFAULT_CONTENT_BY_TYPE,
  PRUNE_CAPABLE,
  PRUNE_FIELDS,
  SMB_VERSIONS,
  type ContentType,
  type PruneKeep,
  type StorageAddBody,
  type StorageConfig,
  type StorageEditBody,
  type StorageType,
} from '@/api/storageConfig';

/**
 * The Add/Edit storage dialogs' form state, validation and request-body builders. Validation
 * mirrors the server's schemas (`storageConfigRoutes.ts`) so the dialog can explain a problem
 * before sending; the server stays the authority.
 */

export const STORAGE_ID_RE = /^[A-Za-z][A-Za-z0-9._-]{1,63}$/;
const NODE_RE = /^[A-Za-z0-9][A-Za-z0-9.-]{0,62}$/;
const HOSTNAME_RE = /^[A-Za-z0-9]([A-Za-z0-9.-]{0,251}[A-Za-z0-9])?$/;
const IPV4_RE = /^(\d{1,3})(\.\d{1,3}){3}$/;
const IPV6_RE = /^[0-9A-Fa-f:]+$/;
const ABS_PATH_RE = /^\/[A-Za-z0-9._/-]+$/;
const EXPORT_RE = /^\/[A-Za-z0-9._/+@:=-]*$/;
const NFS_OPTIONS_RE = /^[A-Za-z0-9=,._-]+$/;
const SHARE_RE = /^[A-Za-z0-9._$-][A-Za-z0-9._$ -]{0,79}$/;
const SUBDIR_RE = /^\/[A-Za-z0-9._/ -]*$/;
const CIFS_USER_RE = /^[A-Za-z0-9._@\\-]{1,128}$/;
const DOMAIN_RE = /^[A-Za-z0-9._-]{1,255}$/;
const VG_RE = /^[A-Za-z0-9._+-]+$/;
const ZFS_POOL_RE = /^[A-Za-z0-9._/-]+$/;
const BLOCKSIZE_RE = /^\d+[kKmM]?$/;
const PBS_DATASTORE_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const PBS_USER_RE = /^[^\s@]+@[^\s@]+$/;
const PBS_NAMESPACE_RE = /^[A-Za-z0-9._/-]{1,256}$/;
const FINGERPRINT_RE = /^([0-9A-Fa-f]{2}:){31}[0-9A-Fa-f]{2}$/;

export interface StorageForm {
  storage: string;
  content: ContentType[];
  /** Empty = every node. */
  nodes: string[];
  enabled: boolean;
  path: string;
  shared: boolean;
  server: string;
  export: string;
  options: string;
  share: string;
  username: string;
  password: string;
  domain: string;
  subdir: string;
  smbversion: string;
  vgname: string;
  thinpool: string;
  pool: string;
  sparse: boolean;
  blocksize: string;
  datastore: string;
  fingerprint: string;
  namespace: string;
  keepAll: boolean;
  /** keep-* counts as typed text, blank = unset. */
  keep: Record<Exclude<keyof PruneKeep, 'keepAll'>, string>;
}

export function emptyForm(type: StorageType): StorageForm {
  return {
    storage: '',
    content: [...DEFAULT_CONTENT_BY_TYPE[type]],
    nodes: [],
    enabled: true,
    path: '',
    shared: false,
    server: '',
    export: '',
    options: '',
    share: '',
    username: '',
    password: '',
    domain: '',
    subdir: '',
    smbversion: 'default',
    vgname: '',
    thinpool: '',
    pool: '',
    sparse: false,
    blocksize: '',
    datastore: '',
    fingerprint: '',
    namespace: '',
    keepAll: false,
    keep: { keepLast: '', keepHourly: '', keepDaily: '', keepWeekly: '', keepMonthly: '', keepYearly: '' },
  };
}

/** The edit dialog's initial state from an existing definition (never a password). */
export function formFromConfig(config: StorageConfig): StorageForm {
  const raw = config.raw;
  const text = (key: string) => (typeof raw[key] === 'string' ? (raw[key] as string) : '');
  const form = emptyForm((config.type as StorageType) in CONTENT_BY_TYPE ? (config.type as StorageType) : 'dir');
  const allowed = CONTENT_BY_TYPE[config.type as StorageType] as readonly string[] | undefined;
  form.storage = config.storage;
  form.content = config.content.filter((c): c is ContentType => (allowed ?? []).includes(c));
  form.nodes = [...config.nodes];
  form.enabled = !config.disabled;
  form.path = text('path');
  form.shared = config.shared;
  form.server = text('server');
  form.export = text('export');
  form.options = text('options');
  form.share = text('share');
  form.username = text('username');
  form.domain = text('domain');
  form.subdir = text('subdir');
  form.smbversion = text('smbversion') || 'default';
  form.vgname = text('vgname');
  form.thinpool = text('thinpool');
  form.pool = text('pool');
  form.sparse = raw.sparse === 1 || raw.sparse === true;
  form.blocksize = text('blocksize');
  form.datastore = text('datastore');
  form.fingerprint = text('fingerprint');
  form.namespace = text('namespace');
  if (config.prune?.keepAll) form.keepAll = true;
  for (const [key] of PRUNE_FIELDS) {
    const value = config.prune?.[key];
    if (value !== undefined) form.keep[key] = String(value);
  }
  return form;
}

export type FormErrors = Partial<Record<string, string>>;

function isHost(value: string): boolean {
  return IPV4_RE.test(value) || (value.includes(':') && IPV6_RE.test(value)) || HOSTNAME_RE.test(value);
}

/** The retention policy typed into the form, or `undefined` when nothing is set. */
export function pruneFromForm(form: StorageForm): PruneKeep | undefined {
  if (form.keepAll) return { keepAll: true };
  const prune: PruneKeep = {};
  for (const [key] of PRUNE_FIELDS) {
    const text = form.keep[key].trim();
    if (text !== '' && /^\d+$/.test(text)) prune[key] = Number(text);
  }
  return Object.keys(prune).length > 0 ? prune : undefined;
}

function pruneErrors(form: StorageForm, errors: FormErrors): void {
  if (form.keepAll) return;
  for (const [key, , label] of PRUNE_FIELDS) {
    const text = form.keep[key].trim();
    if (text === '') continue;
    if (!/^\d+$/.test(text) || Number(text) > 365) errors[`keep.${key}`] = `${label} must be a whole number from 0 to 365.`;
  }
}

/** Whether the retention fields apply: a backup-capable type that holds backups. */
export function showsRetention(type: StorageType, content: readonly ContentType[]): boolean {
  return PRUNE_CAPABLE.includes(type) && content.includes('backup');
}

/** Problems with the fields that apply to `type`; empty when the form is ready to send. */
export function validateForm(type: StorageType, form: StorageForm, mode: 'add' | 'edit'): FormErrors {
  const errors: FormErrors = {};
  if (mode === 'add' && !STORAGE_ID_RE.test(form.storage)) {
    errors.storage = 'Use 2-64 characters: a letter first, then letters, digits, dots, dashes or underscores.';
  }
  if (form.content.length === 0) errors.content = 'Select at least one content type.';
  if (form.nodes.some((n) => !NODE_RE.test(n))) errors.nodes = 'Invalid node name.';

  switch (type) {
    case 'dir':
      if (mode === 'add' && (!ABS_PATH_RE.test(form.path) || form.path.split('/').includes('..'))) {
        errors.path = 'Enter an absolute path such as /mnt/data.';
      }
      break;
    case 'nfs':
      if (mode === 'add') {
        if (!isHost(form.server)) errors.server = 'Enter a host name or IP address.';
        if (!EXPORT_RE.test(form.export) || form.export === '') errors.export = 'Enter the export path, starting with /.';
      }
      if (form.options !== '' && !NFS_OPTIONS_RE.test(form.options)) {
        errors.options = 'Use letters, digits and = , . _ - only.';
      }
      break;
    case 'cifs':
      if (mode === 'add') {
        if (!isHost(form.server)) errors.server = 'Enter a host name or IP address.';
        if (!SHARE_RE.test(form.share)) errors.share = 'Enter the share name.';
      }
      if (form.username !== '' && !CIFS_USER_RE.test(form.username)) errors.username = 'Invalid user name.';
      if (form.domain !== '' && !DOMAIN_RE.test(form.domain)) errors.domain = 'Invalid domain.';
      if (form.subdir !== '' && !SUBDIR_RE.test(form.subdir)) errors.subdir = 'Enter a sub-directory starting with /.';
      break;
    case 'lvm':
      if (mode === 'add' && !VG_RE.test(form.vgname)) errors.vgname = 'Enter the volume group.';
      break;
    case 'lvmthin':
      if (mode === 'add') {
        if (!VG_RE.test(form.vgname)) errors.vgname = 'Enter the volume group.';
        if (!VG_RE.test(form.thinpool)) errors.thinpool = 'Enter the thin pool.';
      }
      break;
    case 'zfspool':
      if (mode === 'add' && !ZFS_POOL_RE.test(form.pool)) errors.pool = 'Enter the ZFS pool.';
      if (form.blocksize !== '' && !BLOCKSIZE_RE.test(form.blocksize)) errors.blocksize = 'Use a number with an optional k or M, such as 16k.';
      break;
    case 'pbs':
      if (mode === 'add') {
        if (!isHost(form.server)) errors.server = 'Enter a host name or IP address.';
        if (!PBS_DATASTORE_RE.test(form.datastore)) errors.datastore = 'Enter the datastore name.';
        if (form.password === '') errors.password = 'Enter the password or API token secret.';
      }
      if (!PBS_USER_RE.test(form.username)) errors.username = 'Use user@realm, for example backup@pbs.';
      if (form.fingerprint !== '' && !FINGERPRINT_RE.test(form.fingerprint)) {
        errors.fingerprint = 'Use 32 colon-separated hex pairs (SHA-256).';
      }
      if (form.namespace !== '' && !PBS_NAMESPACE_RE.test(form.namespace)) errors.namespace = 'Invalid namespace.';
      break;
  }
  if (showsRetention(type, form.content)) pruneErrors(form, errors);
  return errors;
}

/** The exact request body for adding a storage of `type` from a valid form. Optional fields that
 * are blank/false are left out; a new storage with no node chosen applies to every node. */
export function buildAddBody(type: StorageType, form: StorageForm): StorageAddBody {
  const common = {
    storage: form.storage,
    content: form.content,
    ...(form.nodes.length > 0 ? { nodes: form.nodes } : {}),
    ...(form.enabled ? {} : { disable: true }),
  };
  const prune = showsRetention(type, form.content) ? pruneFromForm(form) : undefined;
  const pruneKey = prune !== undefined ? { prune } : {};
  switch (type) {
    case 'dir':
      return { type, ...common, path: form.path, ...(form.shared ? { shared: true } : {}), ...pruneKey };
    case 'nfs':
      return {
        type,
        ...common,
        server: form.server,
        export: form.export,
        ...(form.options !== '' ? { options: form.options } : {}),
        ...pruneKey,
      };
    case 'cifs':
      return {
        type,
        ...common,
        server: form.server,
        share: form.share,
        ...(form.username !== '' ? { username: form.username } : {}),
        ...(form.password !== '' ? { password: form.password } : {}),
        ...(form.domain !== '' ? { domain: form.domain } : {}),
        ...(form.subdir !== '' ? { subdir: form.subdir } : {}),
        ...(form.smbversion !== 'default' && (SMB_VERSIONS as readonly string[]).includes(form.smbversion)
          ? { smbversion: form.smbversion as (typeof SMB_VERSIONS)[number] }
          : {}),
        ...pruneKey,
      };
    case 'lvm':
      return { type, ...common, vgname: form.vgname, ...(form.shared ? { shared: true } : {}) };
    case 'lvmthin':
      return { type, ...common, vgname: form.vgname, thinpool: form.thinpool };
    case 'zfspool':
      return {
        type,
        ...common,
        pool: form.pool,
        ...(form.sparse ? { sparse: true } : {}),
        ...(form.blocksize !== '' ? { blocksize: form.blocksize } : {}),
      };
    case 'pbs':
      return {
        type,
        ...common,
        server: form.server,
        datastore: form.datastore,
        username: form.username,
        password: form.password,
        ...(form.fingerprint !== '' ? { fingerprint: form.fingerprint } : {}),
        ...(form.namespace !== '' ? { namespace: form.namespace } : {}),
        ...pruneKey,
      };
  }
}

/** The edit request: the FULL desired state of every editable field for this type. Cleared
 * values are `null` (the server turns them into PVE's delete list); a blank password is
 * `{ keep: true }`, so the stored secret is never re-sent. */
export function buildEditBody(type: StorageType, form: StorageForm): StorageEditBody {
  const body: StorageEditBody = {
    content: form.content,
    nodes: form.nodes.length > 0 ? form.nodes : null,
    disable: !form.enabled,
  };
  if (type === 'dir' || type === 'lvm') body.shared = form.shared;
  if (type === 'nfs') body.options = form.options !== '' ? form.options : null;
  if (type === 'zfspool') body.sparse = form.sparse;
  if (type === 'cifs') {
    body.username = form.username !== '' ? form.username : null;
    body.domain = form.domain !== '' ? form.domain : null;
    body.smbversion = form.smbversion !== 'default' && (SMB_VERSIONS as readonly string[]).includes(form.smbversion)
      ? (form.smbversion as (typeof SMB_VERSIONS)[number])
      : null;
  }
  if (type === 'cifs' || type === 'pbs') {
    if (type === 'pbs') body.username = form.username;
    body.password = form.password !== '' ? form.password : { keep: true };
  }
  if (type === 'pbs') {
    body.fingerprint = form.fingerprint !== '' ? form.fingerprint : null;
    body.namespace = form.namespace !== '' ? form.namespace : null;
  }
  if (showsRetention(type, form.content)) body.prune = pruneFromForm(form) ?? null;
  return body;
}
