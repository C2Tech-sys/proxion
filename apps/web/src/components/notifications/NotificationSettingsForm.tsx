import { useEffect, useId, useState, type ReactNode } from 'react';

import { NativeSelect } from '@/components/hardware/NativeSelect';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { SwitchToggle } from '@/pages/preferences/controls';
import { USE_FIXTURES } from '@/api/client';
import { useAuthMe } from '@/api/hooks';
import { useMuteNotifications, useNotifySettings, useSaveNotifySettings } from '@/api/notifyHooks';
import { useRootPermissions } from '@/api/rootPermissionHooks';
import type { MuteSpan, NotifyKind, NotifySettingsPutBody, NotifySettingsView, WebhookFormat } from '@/api/notify';

const TOKEN_MODE_TOOLTIP = 'Read-only: signed in with a service token';
const NO_PRIVILEGE_TOOLTIP = "You don't have Sys.Modify on /";

const KINDS: ReadonlyArray<{ kind: NotifyKind; label: string }> = [
  { kind: 'backup', label: 'Backups' },
  { kind: 'task', label: 'Failed tasks' },
  { kind: 'storage', label: 'Storage usage' },
];

const WEBHOOK_FORMATS: ReadonlyArray<{ value: WebhookFormat; label: string }> = [
  { value: 'generic', label: 'Generic JSON' },
  { value: 'discord', label: 'Discord' },
  { value: 'slack', label: 'Slack' },
  { value: 'ntfy', label: 'ntfy' },
  { value: 'gotify', label: 'Gotify' },
];

const SNOOZES: ReadonlyArray<{ span: MuteSpan; label: string }> = [
  { span: '1h', label: '1 h' },
  { span: '8h', label: '8 h' },
  { span: '24h', label: '24 h' },
  { span: '7d', label: '7 days' },
];

/** What the form edits. Secrets are never in here as stored values -- only what the user typed. */
interface Draft {
  enabled: boolean;
  /** `true` = notify about this kind (unchecked = muted). */
  notifyKinds: Record<NotifyKind, boolean>;
  minSeverity: 'warning' | 'error';
  includeResolved: boolean;
  debounceSeconds: string;
  siteName: string;
  publicUrl: string;
  webhookOn: boolean;
  webhookFormat: WebhookFormat;
  webhookUrl: string;
  webhookToken: string;
  webhookTokenCleared: boolean;
  emailOn: boolean;
  smtpUrl: string;
  emailFrom: string;
  emailTo: string;
}

function draftFromView(view: NotifySettingsView): Draft {
  return {
    enabled: view.enabled,
    notifyKinds: {
      backup: !view.mutedKinds.includes('backup'),
      task: !view.mutedKinds.includes('task'),
      storage: !view.mutedKinds.includes('storage'),
    },
    minSeverity: view.minSeverity,
    includeResolved: view.includeResolved,
    debounceSeconds: String(view.debounceMs / 1000),
    siteName: view.siteName,
    publicUrl: view.publicUrl ?? '',
    webhookOn: Boolean(view.webhook),
    webhookFormat: view.webhook?.format ?? 'generic',
    webhookUrl: '',
    webhookToken: '',
    webhookTokenCleared: false,
    emailOn: Boolean(view.email),
    smtpUrl: '',
    emailFrom: view.email?.from ?? '',
    emailTo: view.email?.to.join(', ') ?? '',
  };
}

/** The PUT body for a draft, or why it cannot be sent yet. Secrets the user did not touch become
 *  `{ keep: true }`; a cleared token becomes `null`. */
function buildBody(draft: Draft, view: NotifySettingsView): { body: NotifySettingsPutBody } | { problem: string } {
  const seconds = Number(draft.debounceSeconds);
  if (draft.debounceSeconds.trim() === '' || !Number.isFinite(seconds)) {
    return { problem: 'Batching delay must be a number of seconds.' };
  }
  const body: NotifySettingsPutBody = {
    enabled: draft.enabled,
    mutedKinds: KINDS.filter(({ kind }) => !draft.notifyKinds[kind]).map(({ kind }) => kind),
    minSeverity: draft.minSeverity,
    includeResolved: draft.includeResolved,
    debounceMs: Math.round(seconds * 1000),
    siteName: draft.siteName.trim(),
  };
  if (draft.publicUrl.trim()) body.publicUrl = draft.publicUrl.trim();

  if (draft.webhookOn) {
    const url = draft.webhookUrl.trim();
    if (!view.webhook && !url) return { problem: 'Enter the webhook address.' };
    const webhook: NonNullable<NotifySettingsPutBody['webhook']> = {
      url: url ? url : { keep: true },
      format: draft.webhookFormat,
    };
    if (draft.webhookToken) webhook.token = draft.webhookToken;
    else if (view.webhook?.token.set) webhook.token = draft.webhookTokenCleared ? null : { keep: true };
    body.webhook = webhook;
  }

  if (draft.emailOn) {
    const smtpUrl = draft.smtpUrl.trim();
    if (!view.email && !smtpUrl) return { problem: 'Enter the SMTP URL.' };
    const to = draft.emailTo
      .split(',')
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0);
    if (!draft.emailFrom.trim() || to.length === 0) return { problem: 'Email needs a From address and at least one To address.' };
    body.email = { smtpUrl: smtpUrl ? smtpUrl : { keep: true }, from: draft.emailFrom.trim(), to };
  }
  return { body };
}

function remainingText(untilIso: string, nowMs: number): string {
  const minutes = Math.max(1, Math.round((Date.parse(untilIso) - nowMs) / 60_000));
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor((minutes % 1440) / 60);
  const mins = minutes % 60;
  if (days > 0) return `${days}d ${hours}h left`;
  if (hours > 0) return `${hours}h ${mins}m left`;
  return `${mins}m left`;
}

/** "Notifications: On · Muted until … · Source: env" -- from what the server has, not from the draft. */
function statusLine(view: NotifySettingsView, nowMs: number): string {
  const parts = [`Notifications: ${view.enabled ? 'On' : 'Off'}`];
  if (view.muteUntil) {
    parts.push(`Muted until ${new Date(view.muteUntil).toLocaleString()} (${remainingText(view.muteUntil, nowMs)})`);
  }
  parts.push(`Source: ${view.source}`);
  return parts.join(' · ');
}

/** The one line saying what is in force. A component of its own so the clock it needs (for the
 *  "N h left" countdown) is read once on mount -- it is re-keyed whenever the snooze changes -- and
 *  then ticks every 30 s. */
function StatusLine({ view }: { view: NotifySettingsView }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, []);
  return (
    <p className="text-sm font-medium" data-testid="notify-status-line">
      {statusLine(view, now)}
    </p>
  );
}

function Field({ label, htmlFor, hint, children }: { label: string; htmlFor: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={htmlFor} className="text-xs font-medium text-muted-foreground">
        {label}
      </label>
      {children}
      {hint ? <span className="text-xs text-muted-foreground">{hint}</span> : null}
    </div>
  );
}

function Group({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-3 py-3">
      <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{title}</h3>
      {children}
    </section>
  );
}

/**
 * The editable half of the Preferences "Notifications" section (T64): master switch, snooze, which
 * alert kinds are announced, delivery tuning, and the webhook / email channel details. The server
 * returns every secret masked, so a secret field is only ever "unchanged" (sent as `{ keep: true }`)
 * or something the user typed. Everything is read-only unless the caller is signed in with a
 * session AND holds `Sys.Modify` on `/` (the server enforces both on every write).
 */
export function NotificationSettingsForm() {
  const { data: auth } = useAuthMe();
  const permissions = useRootPermissions();
  const settings = useNotifySettings();

  const isSessionMode = USE_FIXTURES || auth?.mode === 'session';
  const permissionsKnown = permissions.data !== undefined;
  const canEdit = isSessionMode && Boolean(permissions.data?.can('Sys.Modify'));
  const lockedReason = !isSessionMode ? TOKEN_MODE_TOOLTIP : permissionsKnown && !canEdit ? NO_PRIVILEGE_TOOLTIP : undefined;

  if (!settings.data) {
    return (
      <p className="py-3 text-sm text-muted-foreground">
        {settings.isError ? 'Notification settings could not be loaded.' : 'Loading notification settings…'}
      </p>
    );
  }

  // Re-created (so the draft starts from the server's state again) whenever the server's settings
  // change in any way other than the snooze -- i.e. after a save, or another admin's save.
  const { muteUntil: _muteUntil, ...stable } = settings.data;
  void _muteUntil;
  return (
    <SettingsFormBody
      key={JSON.stringify(stable)}
      view={settings.data}
      canEdit={canEdit}
      lockedReason={lockedReason}
    />
  );
}

function SettingsFormBody({
  view,
  canEdit,
  lockedReason,
}: {
  view: NotifySettingsView;
  canEdit: boolean;
  lockedReason: string | undefined;
}) {
  const id = useId();
  const save = useSaveNotifySettings();
  const mute = useMuteNotifications();
  const [draft, setDraft] = useState<Draft>(() => draftFromView(view));
  const baseline = draftFromView(view);

  const built = buildBody(draft, view);
  const baselineBuilt = buildBody(baseline, view);
  const dirty = JSON.stringify(built) !== JSON.stringify(baselineBuilt);
  const problem = 'problem' in built ? built.problem : undefined;

  const locked = !canEdit;
  const lockTitle = locked ? lockedReason : undefined;
  const busy = save.isPending || mute.isPending;

  function patch(update: Partial<Draft>) {
    save.reset();
    setDraft((current) => ({ ...current, ...update }));
  }

  function onSave() {
    if ('body' in built) save.mutate(built.body);
  }

  return (
    <div className="flex flex-col divide-y divide-border">
      <section className="flex flex-col gap-2 py-3">
        <StatusLine key={view.muteUntil ?? 'not-muted'} view={view} />
        {view.source === 'env' ? (
          <p className="text-xs text-muted-foreground">
            These values come from the server environment. Saving here stores them in the data directory, where they
            then take over.
          </p>
        ) : null}
        <div className="flex items-center justify-between gap-4">
          <span className="text-sm">Send notifications</span>
          <span title={lockTitle}>
            <SwitchToggle
              ariaLabel="Notifications enabled"
              checked={draft.enabled}
              disabled={locked || busy}
              onChange={(enabled) => patch({ enabled })}
            />
          </span>
        </div>
        <div className="flex flex-wrap items-center gap-2" role="group" aria-label="Snooze notifications">
          <span className="text-sm">Snooze</span>
          {SNOOZES.map(({ span, label }) => (
            <Button
              key={span}
              type="button"
              variant="outline"
              size="sm"
              disabled={locked || busy}
              title={lockTitle}
              onClick={() => mute.mutate(span)}
            >
              {label}
            </Button>
          ))}
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={locked || busy || !view.muteUntil}
            title={lockTitle}
            onClick={() => mute.mutate(null)}
          >
            Unmute
          </Button>
        </div>
      </section>

      <Group title="Alert kinds">
        <div className="flex flex-wrap gap-x-6 gap-y-2">
          {KINDS.map(({ kind, label }) => (
            <div key={kind} className="flex items-center gap-2" title={lockTitle}>
              <Checkbox
                id={`${id}-kind-${kind}`}
                checked={draft.notifyKinds[kind]}
                disabled={locked || busy}
                onCheckedChange={(checked) =>
                  patch({ notifyKinds: { ...draft.notifyKinds, [kind]: checked === true } })
                }
              />
              <label htmlFor={`${id}-kind-${kind}`} className="text-sm">
                {label}
              </label>
            </div>
          ))}
        </div>
        <p className="text-xs text-muted-foreground">Unchecked kinds are never announced.</p>
      </Group>

      <Group title="Delivery">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Field label="Minimum severity" htmlFor={`${id}-severity`}>
            <NativeSelect
              id={`${id}-severity`}
              value={draft.minSeverity}
              disabled={locked || busy}
              title={lockTitle}
              onChange={(e) => patch({ minSeverity: e.target.value === 'error' ? 'error' : 'warning' })}
            >
              <option value="warning">Warning and above</option>
              <option value="error">Errors only</option>
            </NativeSelect>
          </Field>
          <Field label="Batching delay (seconds)" htmlFor={`${id}-debounce`} hint="1 to 600">
            <Input
              id={`${id}-debounce`}
              type="number"
              inputMode="numeric"
              min={1}
              max={600}
              value={draft.debounceSeconds}
              disabled={locked || busy}
              title={lockTitle}
              onChange={(e) => patch({ debounceSeconds: e.target.value })}
            />
          </Field>
          <Field label="Site name" htmlFor={`${id}-site`}>
            <Input
              id={`${id}-site`}
              value={draft.siteName}
              maxLength={64}
              disabled={locked || busy}
              title={lockTitle}
              onChange={(e) => patch({ siteName: e.target.value })}
            />
          </Field>
          <Field label="Public URL" htmlFor={`${id}-public`} hint="Used for links back to this app in messages">
            <Input
              id={`${id}-public`}
              value={draft.publicUrl}
              placeholder="https://proxion.example.com"
              disabled={locked || busy}
              title={lockTitle}
              onChange={(e) => patch({ publicUrl: e.target.value })}
            />
          </Field>
        </div>
        <div className="flex items-center gap-2" title={lockTitle}>
          <Checkbox
            id={`${id}-resolved`}
            checked={draft.includeResolved}
            disabled={locked || busy}
            onCheckedChange={(checked) => patch({ includeResolved: checked === true })}
          />
          <label htmlFor={`${id}-resolved`} className="text-sm">
            Also announce when an alert clears
          </label>
        </div>
      </Group>

      <Group title="Webhook">
        {draft.webhookOn ? (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Field label="Format" htmlFor={`${id}-wh-format`}>
              <NativeSelect
                id={`${id}-wh-format`}
                value={draft.webhookFormat}
                disabled={locked || busy}
                title={lockTitle}
                onChange={(e) => patch({ webhookFormat: e.target.value as WebhookFormat })}
              >
                {WEBHOOK_FORMATS.map(({ value, label }) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </NativeSelect>
            </Field>
            <Field
              label="Address"
              htmlFor={`${id}-wh-url`}
              hint={view.webhook ? `Current: ${view.webhook.url.host} (the rest of the address is kept private)` : undefined}
            >
              <Input
                id={`${id}-wh-url`}
                value={draft.webhookUrl}
                placeholder={view.webhook ? 'unchanged' : 'https://hooks.example.com/…'}
                autoComplete="off"
                disabled={locked || busy}
                title={lockTitle}
                onChange={(e) => patch({ webhookUrl: e.target.value })}
              />
            </Field>
            <Field
              label="Token"
              htmlFor={`${id}-wh-token`}
              hint={draft.webhookTokenCleared && !draft.webhookToken ? 'The stored token is removed when you save.' : undefined}
            >
              <div className="flex gap-2">
                <Input
                  id={`${id}-wh-token`}
                  type="password"
                  value={draft.webhookToken}
                  placeholder={view.webhook?.token.set && !draft.webhookTokenCleared ? 'unchanged' : 'none'}
                  autoComplete="new-password"
                  disabled={locked || busy}
                  title={lockTitle}
                  onChange={(e) => patch({ webhookToken: e.target.value })}
                />
                {view.webhook?.token.set ? (
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={locked || busy}
                    title={lockTitle}
                    onClick={() => patch({ webhookTokenCleared: !draft.webhookTokenCleared, webhookToken: '' })}
                  >
                    {draft.webhookTokenCleared ? 'Keep' : 'Clear'}
                  </Button>
                ) : null}
              </div>
            </Field>
          </div>
        ) : (
          <p className="text-xs text-muted-foreground">
            {view.webhook ? 'The webhook is removed when you save.' : 'No webhook is set up.'}
          </p>
        )}
        <div>
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={locked || busy}
            title={lockTitle}
            onClick={() =>
              patch(
                draft.webhookOn
                  ? { webhookOn: false }
                  : { webhookOn: true, webhookUrl: '', webhookToken: '', webhookTokenCleared: false },
              )
            }
          >
            {draft.webhookOn ? 'Remove webhook' : view.webhook ? 'Keep webhook' : 'Add webhook'}
          </Button>
        </div>
      </Group>

      <Group title="Email">
        {draft.emailOn ? (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Field
              label="SMTP URL"
              htmlFor={`${id}-smtp`}
              hint={
                view.email
                  ? `Current: ${view.email.smtpUrl.user ? `${view.email.smtpUrl.user}@` : ''}${view.email.smtpUrl.host}:${view.email.smtpUrl.port}${view.email.smtpUrl.secure ? ' (TLS)' : ''}`
                  : 'smtp://user:password@host:587 or smtps://…'
              }
            >
              <Input
                id={`${id}-smtp`}
                type="password"
                value={draft.smtpUrl}
                placeholder={view.email ? 'unchanged' : 'smtp://user:password@host:587'}
                autoComplete="new-password"
                disabled={locked || busy}
                title={lockTitle}
                onChange={(e) => patch({ smtpUrl: e.target.value })}
              />
            </Field>
            <Field label="From" htmlFor={`${id}-from`}>
              <Input
                id={`${id}-from`}
                value={draft.emailFrom}
                placeholder="proxion@example.com"
                disabled={locked || busy}
                title={lockTitle}
                onChange={(e) => patch({ emailFrom: e.target.value })}
              />
            </Field>
            <Field label="To" htmlFor={`${id}-to`} hint="Comma-separated">
              <Input
                id={`${id}-to`}
                value={draft.emailTo}
                placeholder="you@example.com, team@example.com"
                disabled={locked || busy}
                title={lockTitle}
                onChange={(e) => patch({ emailTo: e.target.value })}
              />
            </Field>
          </div>
        ) : (
          <p className="text-xs text-muted-foreground">
            {view.email ? 'Email is removed when you save.' : 'No email is set up.'}
          </p>
        )}
        <div>
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={locked || busy}
            title={lockTitle}
            onClick={() =>
              patch(
                draft.emailOn
                  ? { emailOn: false }
                  : { emailOn: true, smtpUrl: '', emailFrom: view.email?.from ?? '', emailTo: view.email?.to.join(', ') ?? '' },
              )
            }
          >
            {draft.emailOn ? 'Remove email' : view.email ? 'Keep email' : 'Add email'}
          </Button>
        </div>
      </Group>

      <section className="flex flex-col gap-2 py-3">
        {save.isError ? (
          <p role="alert" className="text-xs text-status-error">
            {save.error.message}
          </p>
        ) : null}
        {problem && dirty ? <p className="text-xs text-muted-foreground">{problem}</p> : null}
        <div className="flex flex-wrap items-center gap-2">
          <Button
            type="button"
            size="sm"
            disabled={locked || !dirty || Boolean(problem) || busy}
            title={lockTitle}
            onClick={onSave}
          >
            {save.isPending ? 'Saving…' : 'Save'}
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={!dirty || busy}
            onClick={() => {
              save.reset();
              setDraft(baseline);
            }}
          >
            Discard changes
          </Button>
        </div>
        <p className="text-xs text-muted-foreground">Tests always send, even while muted.</p>
      </section>
    </div>
  );
}
