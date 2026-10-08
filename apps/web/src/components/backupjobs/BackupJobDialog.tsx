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
import { GuestChecklist } from '@/components/backupjobs/GuestChecklist';
import {
  CALENDAR_EVENT_DOCS_URL,
  CUSTOM_SCHEDULE,
  SCHEDULE_PRESETS,
  buildCreateBody,
  buildUpdateBody,
  effectiveSchedule,
  formIsValid,
  initialFormState,
  validateForm,
  type JobFormState,
  type SelectionKind,
} from '@/components/backupjobs/jobForm';
import { useClusterResources } from '@/api/hooks';
import {
  backupJobErrorMessage,
  useBackupStorages,
  useCreateBackupJob,
  usePools,
  useUpdateBackupJob,
} from '@/api/backupJobsHooks';
import type { BackupJob } from '@/api/backupJobs';

export interface BackupJobDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The job being edited; omit to add a new one. */
  job?: BackupJob | undefined;
}

function Field({ label, htmlFor, error, hint, children }: {
  label: string;
  htmlFor: string;
  error?: string | undefined;
  hint?: ReactNode;
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

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-3 border-t border-border pt-3 first:border-t-0 first:pt-0">
      <h3 className="text-xs font-medium tracking-[0.08em] text-muted-foreground uppercase">{title}</h3>
      {children}
    </section>
  );
}

/**
 * Adds or edits one datacenter backup job (a `/cluster/backup` vzdump schedule): General (schedule
 * presets or a custom calendar event, storage, mode, compression, enabled), Selection (all guests
 * with an exclude list, a pool, or chosen guests), Retention (keep-all or the keep-* fields),
 * Notification (recipients, when, mode) and Advanced (comment, repeat missed, bandwidth, zstd
 * threads, I/O priority, protected).
 *
 * An edit sends ONLY what changed (an optional setting the user cleared as `null`), so options the
 * dialog does not show are never touched; the server turns those into PVE's `delete` list. A server
 * error stays inline and the dialog stays open.
 *
 * Mount it fresh per open (the tab renders it conditionally).
 */
export function BackupJobDialog({ open, onOpenChange, job }: BackupJobDialogProps) {
  const id = useId();
  const isNew = job === undefined;
  const createMutation = useCreateBackupJob();
  const updateMutation = useUpdateBackupJob();
  const mutation = isNew ? createMutation : updateMutation;
  const storages = useBackupStorages();
  const pools = usePools();
  const resources = useClusterResources();

  const [form, setForm] = useState<JobFormState>(() => initialFormState(job));
  const patch = (changes: Partial<JobFormState>) => setForm((prev) => ({ ...prev, ...changes }));

  const storageNames = (storages.data ?? []).map((s) => s.id);
  const effectiveStorage = form.storage !== '' ? form.storage : (storageNames[0] ?? '');
  const storageOptions =
    effectiveStorage !== '' && !storageNames.includes(effectiveStorage) ? [...storageNames, effectiveStorage] : storageNames;
  const useStorageSelect = storages.isLoading || storageNames.length > 0;

  const poolNames = pools.data ?? [];
  const poolOptions = form.pool !== '' && !poolNames.includes(form.pool) ? [...poolNames, form.pool] : poolNames;
  const usePoolSelect = pools.isLoading || poolNames.length > 0;

  const errors = validateForm(form, effectiveStorage);
  const valid = formIsValid(errors);
  const updateBody = job !== undefined ? buildUpdateBody(job, form, effectiveStorage) : undefined;
  const unchanged = updateBody !== undefined && Object.keys(updateBody).length === 0;
  const busy = mutation.isPending;
  const canSave = valid && !busy && !unchanged;

  const serverError = mutation.isError
    ? backupJobErrorMessage(mutation.error, isNew ? 'The backup job could not be created.' : 'The backup job could not be saved.')
    : undefined;

  function submit() {
    if (!canSave) return;
    if (job === undefined) {
      createMutation.mutate(buildCreateBody(form, effectiveStorage), { onSuccess: () => onOpenChange(false) });
    } else if (updateBody !== undefined) {
      updateMutation.mutate({ id: job.id, body: updateBody }, { onSuccess: () => onOpenChange(false) });
    }
  }

  function onKeyDown(event: KeyboardEvent<HTMLElement>) {
    if (event.key === 'Enter' && event.target instanceof HTMLInputElement && event.target.type !== 'checkbox') {
      event.preventDefault();
      submit();
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next && busy) return;
        onOpenChange(next);
      }}
    >
      <DialogContent onKeyDown={onKeyDown} className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{isNew ? 'Add backup job' : `Edit backup job ${job.id}`}</DialogTitle>
          <DialogDescription>
            {isNew
              ? 'Schedule vzdump backups of guests across the cluster.'
              : 'Only the settings you change are sent. Options not shown here are kept as they are.'}
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-4">
          <Section title="General">
            <Field label="Schedule" htmlFor={`${id}-schedule`} error={form.schedulePreset === CUSTOM_SCHEDULE ? undefined : errors.schedule}>
              <NativeSelect
                id={`${id}-schedule`}
                value={form.schedulePreset}
                onChange={(e) => patch({ schedulePreset: e.target.value })}
                disabled={busy}
              >
                {SCHEDULE_PRESETS.map((p) => (
                  <option key={p.value} value={p.value}>
                    {p.label}
                  </option>
                ))}
                <option value={CUSTOM_SCHEDULE}>Custom...</option>
              </NativeSelect>
            </Field>
            {form.schedulePreset === CUSTOM_SCHEDULE && (
              <Field
                label="Custom schedule"
                htmlFor={`${id}-custom`}
                error={errors.schedule}
                hint={
                  <>
                    A PVE calendar event, e.g. <code>sat 22:30</code> or <code>*-*-01 03:00</code>.{' '}
                    <a
                      href={CALENDAR_EVENT_DOCS_URL}
                      target="_blank"
                      rel="noreferrer"
                      className="underline underline-offset-2"
                    >
                      Calendar event syntax
                    </a>
                  </>
                }
              >
                <Input
                  id={`${id}-custom`}
                  value={form.customSchedule}
                  onChange={(e) => patch({ customSchedule: e.target.value })}
                  disabled={busy}
                  aria-invalid={errors.schedule !== undefined || undefined}
                  autoComplete="off"
                  spellCheck={false}
                />
              </Field>
            )}
            <p className="-mt-1 text-xs text-muted-foreground">
              Runs: <code>{effectiveSchedule(form) || '-'}</code>
            </p>

            <Field label="Storage" htmlFor={`${id}-storage`} error={errors.storage}>
              {useStorageSelect ? (
                <NativeSelect
                  id={`${id}-storage`}
                  value={effectiveStorage}
                  onChange={(e) => patch({ storage: e.target.value })}
                  disabled={busy || storages.isLoading}
                >
                  {storages.isLoading && <option value={effectiveStorage}>Loading storages...</option>}
                  {storageOptions.map((s) => (
                    <option key={s} value={s}>
                      {s}
                    </option>
                  ))}
                </NativeSelect>
              ) : (
                <Input
                  id={`${id}-storage`}
                  value={form.storage}
                  onChange={(e) => patch({ storage: e.target.value })}
                  disabled={busy}
                  placeholder="storage id"
                  aria-invalid={errors.storage !== undefined || undefined}
                  autoComplete="off"
                />
              )}
            </Field>

            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Mode" htmlFor={`${id}-mode`}>
                <NativeSelect
                  id={`${id}-mode`}
                  value={form.mode}
                  onChange={(e) => patch({ mode: e.target.value as JobFormState['mode'] })}
                  disabled={busy}
                >
                  <option value="snapshot">Snapshot</option>
                  <option value="suspend">Suspend</option>
                  <option value="stop">Stop</option>
                </NativeSelect>
              </Field>
              <Field label="Compression" htmlFor={`${id}-compress`}>
                <NativeSelect
                  id={`${id}-compress`}
                  value={form.compress}
                  onChange={(e) => patch({ compress: e.target.value as JobFormState['compress'] })}
                  disabled={busy}
                >
                  <option value="zstd">ZSTD (fast and good)</option>
                  <option value="gzip">GZIP</option>
                  <option value="lzo">LZO (fastest)</option>
                  <option value="0">None</option>
                </NativeSelect>
              </Field>
            </div>
            <CheckField
              id={`${id}-enabled`}
              label="Enabled"
              checked={form.enabled}
              onChange={(enabled) => patch({ enabled })}
              disabled={busy}
            />
          </Section>

          <Section title="Selection">
            <Field label="Selection mode" htmlFor={`${id}-selkind`} error={errors.selection}>
              <NativeSelect
                id={`${id}-selkind`}
                value={form.selectionKind}
                onChange={(e) => patch({ selectionKind: e.target.value as SelectionKind })}
                disabled={busy}
              >
                <option value="all">All guests</option>
                <option value="pool">Pool</option>
                <option value="vmids">Choose guests</option>
              </NativeSelect>
            </Field>
            {form.selectionKind === 'all' && (
              <div className="flex flex-col gap-1.5">
                <span className="text-sm font-medium">Exclude guests</span>
                <GuestChecklist
                  label="Guests to exclude"
                  resources={resources.data}
                  selected={form.exclude}
                  onChange={(exclude) => patch({ exclude })}
                  disabled={busy}
                />
                <p className="text-xs text-muted-foreground">Tick the guests that should NOT be backed up.</p>
              </div>
            )}
            {form.selectionKind === 'pool' && (
              <Field label="Pool" htmlFor={`${id}-pool`}>
                {usePoolSelect ? (
                  <NativeSelect
                    id={`${id}-pool`}
                    value={form.pool}
                    onChange={(e) => patch({ pool: e.target.value })}
                    disabled={busy || pools.isLoading}
                  >
                    <option value="">{pools.isLoading ? 'Loading pools...' : 'Choose a pool...'}</option>
                    {poolOptions.map((p) => (
                      <option key={p} value={p}>
                        {p}
                      </option>
                    ))}
                  </NativeSelect>
                ) : (
                  <Input
                    id={`${id}-pool`}
                    value={form.pool}
                    onChange={(e) => patch({ pool: e.target.value })}
                    disabled={busy}
                    placeholder="pool name"
                    autoComplete="off"
                  />
                )}
              </Field>
            )}
            {form.selectionKind === 'vmids' && (
              <div className="flex flex-col gap-1.5">
                <span className="text-sm font-medium">Guests</span>
                <GuestChecklist
                  label="Guests to back up"
                  resources={resources.data}
                  selected={form.vmids}
                  onChange={(vmids) => patch({ vmids })}
                  disabled={busy}
                />
              </div>
            )}
          </Section>

          <Section title="Retention">
            <CheckField
              id={`${id}-keepall`}
              label="Keep all backups"
              checked={form.keepAll}
              onChange={(keepAll) => patch({ keepAll })}
              disabled={busy}
            />
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
              {(
                [
                  ['keepLast', 'Keep last'],
                  ['keepHourly', 'Keep hourly'],
                  ['keepDaily', 'Keep daily'],
                  ['keepWeekly', 'Keep weekly'],
                  ['keepMonthly', 'Keep monthly'],
                  ['keepYearly', 'Keep yearly'],
                ] as const
              ).map(([key, label]) => (
                <Field key={key} label={label} htmlFor={`${id}-${key}`} error={errors[key]}>
                  <Input
                    id={`${id}-${key}`}
                    value={form[key]}
                    onChange={(e) => patch({ [key]: e.target.value })}
                    disabled={busy || form.keepAll}
                    inputMode="numeric"
                    aria-invalid={errors[key] !== undefined || undefined}
                    autoComplete="off"
                  />
                </Field>
              ))}
            </div>
            <p className="text-xs text-muted-foreground">PVE keeps all backups if nothing is set.</p>
          </Section>

          <Section title="Notification">
            <Field
              label="Send email to"
              htmlFor={`${id}-mailto`}
              error={errors.mailto}
              hint="Separate several addresses with commas."
            >
              <Input
                id={`${id}-mailto`}
                value={form.mailtoText}
                onChange={(e) => patch({ mailtoText: e.target.value })}
                disabled={busy}
                aria-invalid={errors.mailto !== undefined || undefined}
                autoComplete="off"
              />
            </Field>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Send when" htmlFor={`${id}-mailwhen`}>
                <NativeSelect
                  id={`${id}-mailwhen`}
                  value={form.mailWhen}
                  onChange={(e) => patch({ mailWhen: e.target.value as JobFormState['mailWhen'] })}
                  disabled={busy}
                >
                  <option value="">PVE default</option>
                  <option value="always">Always</option>
                  <option value="failure">On failure only</option>
                </NativeSelect>
              </Field>
              <Field label="Notification mode" htmlFor={`${id}-notifmode`}>
                <NativeSelect
                  id={`${id}-notifmode`}
                  value={form.notificationMode}
                  onChange={(e) => patch({ notificationMode: e.target.value as JobFormState['notificationMode'] })}
                  disabled={busy}
                >
                  <option value="">PVE default</option>
                  <option value="auto">Auto</option>
                  <option value="legacy-sendmail">Legacy sendmail</option>
                  <option value="notification-system">Notification system</option>
                </NativeSelect>
              </Field>
            </div>
          </Section>

          <Section title="Advanced">
            <Field label="Comment" htmlFor={`${id}-comment`} error={errors.comment}>
              <Input
                id={`${id}-comment`}
                value={form.comment}
                onChange={(e) => patch({ comment: e.target.value })}
                disabled={busy}
                aria-invalid={errors.comment !== undefined || undefined}
                autoComplete="off"
              />
            </Field>
            <div className="grid gap-3 sm:grid-cols-3">
              <Field label="Bandwidth limit (KiB/s)" htmlFor={`${id}-bwlimit`} error={errors.bwlimit}>
                <Input
                  id={`${id}-bwlimit`}
                  value={form.bwlimit}
                  onChange={(e) => patch({ bwlimit: e.target.value })}
                  disabled={busy}
                  inputMode="numeric"
                  aria-invalid={errors.bwlimit !== undefined || undefined}
                  autoComplete="off"
                />
              </Field>
              <Field label="zstd threads" htmlFor={`${id}-zstd`} error={errors.zstd} hint="0 = half the cores">
                <Input
                  id={`${id}-zstd`}
                  value={form.zstd}
                  onChange={(e) => patch({ zstd: e.target.value })}
                  disabled={busy}
                  inputMode="numeric"
                  aria-invalid={errors.zstd !== undefined || undefined}
                  autoComplete="off"
                />
              </Field>
              <Field label="I/O priority" htmlFor={`${id}-ionice`} error={errors.ionice} hint="0 (high) to 8 (low)">
                <Input
                  id={`${id}-ionice`}
                  value={form.ionice}
                  onChange={(e) => patch({ ionice: e.target.value })}
                  disabled={busy}
                  inputMode="numeric"
                  aria-invalid={errors.ionice !== undefined || undefined}
                  autoComplete="off"
                />
              </Field>
            </div>
            <CheckField
              id={`${id}-repeat`}
              label="Repeat missed runs"
              checked={form.repeatMissed}
              onChange={(repeatMissed) => patch({ repeatMissed })}
              disabled={busy}
            />
            <CheckField
              id={`${id}-protected`}
              label="Protect the backups from pruning"
              checked={form.protectedJob}
              onChange={(protectedJob) => patch({ protectedJob })}
              disabled={busy}
            />
          </Section>
        </div>

        {serverError && (
          <p role="alert" className="text-xs text-status-error">
            {serverError}
          </p>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={!canSave} title={unchanged ? 'No changes to save' : undefined}>
            {busy && <Loader2 className="size-4 animate-spin" />}
            {isNew ? 'Create job' : 'Save changes'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
