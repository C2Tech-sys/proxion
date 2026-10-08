import {
  retentionToBody,
  type BackupCompress,
  type BackupJob,
  type BackupJobCreateBody,
  type BackupJobUpdateBody,
  type BackupMailWhen,
  type BackupMode,
  type BackupNotificationMode,
  type BackupRetention,
  type BackupSelectionBody,
} from '@/api/backupJobs';

/**
 * The backup job dialog's form model and its pure helpers: initial state from a job, validation
 * (mirrors the server route's schema, `backupJobRoutes.ts`), and the two request bodies. Kept out
 * of the component files so they export plain functions only.
 */

export const CUSTOM_SCHEDULE = 'custom';

/** The schedule presets; anything else is a custom calendar event. */
export const SCHEDULE_PRESETS: ReadonlyArray<{ label: string; value: string }> = [
  { label: 'Daily at 02:00', value: '02:00' },
  { label: 'Weekdays at 02:00', value: 'mon..fri 02:00' },
  { label: 'Weekly, Sunday 01:00', value: 'sun 01:00' },
  { label: 'Monthly, 1st 03:00', value: '*-*-01 03:00' },
];

export const CALENDAR_EVENT_DOCS_URL = 'https://pve.proxmox.com/wiki/Calendar_Events';

export type SelectionKind = 'all' | 'pool' | 'vmids';

export interface JobFormState {
  /** A preset's schedule string, or `CUSTOM_SCHEDULE`. */
  schedulePreset: string;
  customSchedule: string;
  /** Empty = untouched: the first backup-capable storage is used. */
  storage: string;
  mode: BackupMode;
  compress: BackupCompress;
  enabled: boolean;
  selectionKind: SelectionKind;
  exclude: number[];
  pool: string;
  vmids: number[];
  keepAll: boolean;
  keepLast: string;
  keepHourly: string;
  keepDaily: string;
  keepWeekly: string;
  keepMonthly: string;
  keepYearly: string;
  mailtoText: string;
  mailWhen: '' | BackupMailWhen;
  notificationMode: '' | BackupNotificationMode;
  comment: string;
  repeatMissed: boolean;
  bwlimit: string;
  zstd: string;
  ionice: string;
  protectedJob: boolean;
}

const SCHEDULE_RE = /^[A-Za-z0-9 ,.:*/-]{1,128}$/;
const EMAIL_RE = /^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/;
const MAX_COMMENT_LENGTH = 512;
const MAX_MAILTO = 10;

function numText(value: number | undefined): string {
  return value === undefined ? '' : String(value);
}

function compressOf(job: BackupJob | undefined): BackupCompress {
  const value = job?.compress ?? 'zstd';
  if (value === '1') return 'gzip';
  return value === '0' || value === 'gzip' || value === 'lzo' ? value : 'zstd';
}

/** The form's starting state: a new job's defaults, or the given job's current values. */
export function initialFormState(job?: BackupJob): JobFormState {
  const preset = job === undefined ? SCHEDULE_PRESETS[0] : SCHEDULE_PRESETS.find((p) => p.value === job.schedule);
  const selection = job?.selection ?? { kind: 'all' as const, exclude: [] };
  const retention = job?.retention;
  return {
    schedulePreset: preset?.value ?? CUSTOM_SCHEDULE,
    customSchedule: preset === undefined ? (job?.schedule ?? '') : '',
    storage: job?.storage ?? '',
    mode: job?.mode ?? 'snapshot',
    compress: compressOf(job),
    enabled: job?.enabled ?? true,
    selectionKind: selection.kind,
    exclude: selection.kind === 'all' ? [...selection.exclude] : [],
    pool: selection.kind === 'pool' ? selection.pool : '',
    vmids: selection.kind === 'vmids' ? [...selection.vmids] : [],
    keepAll: retention?.keepAll ?? false,
    keepLast: numText(retention?.keepLast),
    keepHourly: numText(retention?.keepHourly),
    keepDaily: numText(retention?.keepDaily),
    keepWeekly: numText(retention?.keepWeekly),
    keepMonthly: numText(retention?.keepMonthly),
    keepYearly: numText(retention?.keepYearly),
    mailtoText: (job?.mailto ?? []).join(', '),
    mailWhen: job?.mailnotification ?? '',
    notificationMode: job?.notificationMode ?? '',
    comment: job?.comment ?? '',
    repeatMissed: job?.repeatMissed ?? false,
    bwlimit: numText(job?.bwlimit),
    zstd: numText(job?.zstd),
    ionice: numText(job?.ionice),
    protectedJob: job?.protected ?? false,
  };
}

export function effectiveSchedule(state: JobFormState): string {
  return state.schedulePreset === CUSTOM_SCHEDULE ? state.customSchedule.trim() : state.schedulePreset;
}

/** The addresses in the mailto text (separated by commas, semicolons or whitespace). */
export function parseMailto(text: string): string[] {
  return text.split(/[\s,;]+/).filter((s) => s !== '');
}

/** `undefined` for blank text, the integer for whole-number text, `NaN` for anything else. */
function intOf(text: string): number | undefined {
  const trimmed = text.trim();
  if (trimmed === '') return undefined;
  return /^\d+$/.test(trimmed) ? Number(trimmed) : Number.NaN;
}

function intError(text: string, min: number, max: number, what: string): string | undefined {
  const n = intOf(text);
  if (n === undefined) return undefined;
  if (Number.isNaN(n)) return `${what} must be a whole number.`;
  return n >= min && n <= max ? undefined : `${what} must be between ${min} and ${max}.`;
}

export interface JobFormErrors {
  schedule?: string | undefined;
  storage?: string | undefined;
  selection?: string | undefined;
  keepLast?: string | undefined;
  keepHourly?: string | undefined;
  keepDaily?: string | undefined;
  keepWeekly?: string | undefined;
  keepMonthly?: string | undefined;
  keepYearly?: string | undefined;
  mailto?: string | undefined;
  comment?: string | undefined;
  bwlimit?: string | undefined;
  zstd?: string | undefined;
  ionice?: string | undefined;
}

/** Inline validation; `storage` is the effective storage (the form's, else the default one). */
export function validateForm(state: JobFormState, storage: string): JobFormErrors {
  const schedule = effectiveSchedule(state);
  const mailto = parseMailto(state.mailtoText);
  const badMail = mailto.find((m) => !EMAIL_RE.test(m));
  return {
    schedule: SCHEDULE_RE.test(schedule) ? undefined : 'Enter a calendar event such as mon..fri 02:00.',
    storage: storage === '' ? 'Choose a storage to back up to.' : undefined,
    selection:
      state.selectionKind === 'pool' && state.pool.trim() === ''
        ? 'Choose a pool.'
        : state.selectionKind === 'vmids' && state.vmids.length === 0
          ? 'Choose at least one guest.'
          : undefined,
    keepLast: intError(state.keepLast, 0, 365, 'Keep last'),
    keepHourly: intError(state.keepHourly, 0, 365, 'Keep hourly'),
    keepDaily: intError(state.keepDaily, 0, 365, 'Keep daily'),
    keepWeekly: intError(state.keepWeekly, 0, 365, 'Keep weekly'),
    keepMonthly: intError(state.keepMonthly, 0, 365, 'Keep monthly'),
    keepYearly: intError(state.keepYearly, 0, 365, 'Keep yearly'),
    mailto:
      mailto.length > MAX_MAILTO
        ? `At most ${MAX_MAILTO} recipients.`
        : badMail !== undefined
          ? `"${badMail}" is not a valid email address.`
          : undefined,
    comment:
      state.comment.length > MAX_COMMENT_LENGTH
        ? `At most ${MAX_COMMENT_LENGTH} characters.`
        : /[\r\n]/.test(state.comment)
          ? 'The comment must be a single line.'
          : undefined,
    bwlimit: intError(state.bwlimit, 0, 1_000_000_000, 'Bandwidth limit'),
    zstd: intError(state.zstd, 0, 64, 'zstd threads'),
    ionice: intError(state.ionice, 0, 8, 'I/O priority'),
  };
}

export function formIsValid(errors: JobFormErrors): boolean {
  return Object.values(errors).every((e) => e === undefined);
}

function sortedUnique(values: number[]): number[] {
  return [...new Set(values)].sort((a, b) => a - b);
}

/** The selection as the request body takes it (an empty exclude list is left out). */
export function selectionBody(state: JobFormState): BackupSelectionBody {
  if (state.selectionKind === 'pool') return { kind: 'pool', pool: state.pool.trim() };
  if (state.selectionKind === 'vmids') return { kind: 'vmids', vmids: sortedUnique(state.vmids) };
  const exclude = sortedUnique(state.exclude);
  return exclude.length > 0 ? { kind: 'all', exclude } : { kind: 'all' };
}

/** The retention the form describes (nothing set -> PVE keeps everything). */
export function formRetention(state: JobFormState): BackupRetention {
  if (state.keepAll) return { keepAll: true };
  const field = (text: string) => {
    const n = intOf(text);
    return n !== undefined && n > 0 ? n : undefined;
  };
  const out: BackupRetention = { keepAll: false };
  const last = field(state.keepLast);
  const hourly = field(state.keepHourly);
  const daily = field(state.keepDaily);
  const weekly = field(state.keepWeekly);
  const monthly = field(state.keepMonthly);
  const yearly = field(state.keepYearly);
  if (last !== undefined) out.keepLast = last;
  if (hourly !== undefined) out.keepHourly = hourly;
  if (daily !== undefined) out.keepDaily = daily;
  if (weekly !== undefined) out.keepWeekly = weekly;
  if (monthly !== undefined) out.keepMonthly = monthly;
  if (yearly !== undefined) out.keepYearly = yearly;
  return out;
}

/** The request body for a new job: defaults spelled out, optional keys only when set. */
export function buildCreateBody(state: JobFormState, storage: string): BackupJobCreateBody {
  const body: BackupJobCreateBody = {
    schedule: effectiveSchedule(state),
    storage,
    selection: selectionBody(state),
    enabled: state.enabled,
    mode: state.mode,
    compress: state.compress,
  };
  const mailto = parseMailto(state.mailtoText);
  if (mailto.length > 0) body.mailto = mailto;
  if (state.mailWhen !== '') body.mailnotification = state.mailWhen;
  if (state.notificationMode !== '') body.notificationMode = state.notificationMode;
  const prune = retentionToBody(formRetention(state));
  if (prune !== undefined) body.pruneBackups = prune;
  if (state.comment.trim() !== '') body.comment = state.comment.trim();
  if (state.repeatMissed) body.repeatMissed = true;
  const bwlimit = intOf(state.bwlimit);
  if (bwlimit !== undefined) body.bwlimit = bwlimit;
  const zstd = intOf(state.zstd);
  if (zstd !== undefined) body.zstd = zstd;
  const ionice = intOf(state.ionice);
  if (ionice !== undefined) body.ionice = ionice;
  if (state.protectedJob) body.protected = true;
  return body;
}

function sameJson(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function currentSelectionBody(job: BackupJob): BackupSelectionBody | undefined {
  const s = job.selection;
  if (s === null) return undefined;
  if (s.kind === 'all') {
    const exclude = sortedUnique(s.exclude);
    return exclude.length > 0 ? { kind: 'all', exclude } : { kind: 'all' };
  }
  return s.kind === 'pool' ? s : { kind: 'vmids', vmids: sortedUnique(s.vmids) };
}

/**
 * The request body for an edit: ONLY what the user changed, with an explicit `null` for an optional
 * setting they cleared (the server turns those into PVE's `delete` list, and a changed selection
 * kind into a delete of the other selection keys). Anything the form doesn't expose (node,
 * lockwait, stopwait) is never touched. Empty when nothing changed.
 */
export function buildUpdateBody(job: BackupJob, state: JobFormState, storage: string): BackupJobUpdateBody {
  const body: BackupJobUpdateBody = {};

  const schedule = effectiveSchedule(state);
  if (schedule !== job.schedule) body.schedule = schedule;
  if (storage !== job.storage) body.storage = storage;
  if (state.mode !== job.mode) body.mode = state.mode;
  if (state.compress !== compressOf(job)) body.compress = state.compress;
  if (state.enabled !== job.enabled) body.enabled = state.enabled;

  const selection = selectionBody(state);
  if (!sameJson(selection, currentSelectionBody(job))) body.selection = selection;

  const mailto = parseMailto(state.mailtoText);
  if (!sameJson(mailto, job.mailto)) body.mailto = mailto.length > 0 ? mailto : null;
  const mailWhen = state.mailWhen === '' ? undefined : state.mailWhen;
  if (mailWhen !== job.mailnotification) body.mailnotification = mailWhen ?? null;
  const notificationMode = state.notificationMode === '' ? undefined : state.notificationMode;
  if (notificationMode !== job.notificationMode) body.notificationMode = notificationMode ?? null;

  const prune = retentionToBody(formRetention(state));
  if (!sameJson(prune, retentionToBody(job.retention))) body.pruneBackups = prune ?? null;

  const comment = state.comment.trim();
  if (comment !== (job.comment ?? '')) body.comment = comment === '' ? null : comment;
  if (state.repeatMissed !== job.repeatMissed) body.repeatMissed = state.repeatMissed;

  const bwlimit = intOf(state.bwlimit);
  if (bwlimit !== job.bwlimit) body.bwlimit = bwlimit ?? null;
  const zstd = intOf(state.zstd);
  if (zstd !== job.zstd) body.zstd = zstd ?? null;
  const ionice = intOf(state.ionice);
  if (ionice !== job.ionice) body.ionice = ionice ?? null;
  if (state.protectedJob !== job.protected) body.protected = state.protectedJob;

  return body;
}
