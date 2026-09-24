import { useRef, useState, type ReactNode } from 'react';
import { Check } from 'lucide-react';

import { Breadcrumbs } from '@/components/Breadcrumbs';
import { Panel } from '@/components/Panel';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { SegmentedControl, SwitchToggle } from '@/pages/preferences/controls';
import { useAuthMe } from '@/api/hooks';
import { usePrefs, useUpdatePrefs } from '@/api/prefsHooks';
import {
  PREFS_DEFAULTS,
  type Density,
  type PrefsPatch,
  type ThumbnailRefreshSeconds,
  type Theme,
} from '@/api/prefs';
import { useUiStore, DEFAULT_SIDEBAR_WIDTH } from '@/store/ui';
import { RRD_TIMEFRAME_LABEL } from '@/lib/rrd';
import { APP_VERSION } from '@/version';

const THEME_OPTIONS = ['system', 'light', 'dark'] as const satisfies readonly Theme[];
const THEME_LABELS: Record<Theme, string> = { system: 'System', light: 'Light', dark: 'Dark' };

const DENSITY_OPTIONS = ['comfortable', 'compact'] as const satisfies readonly Density[];
const DENSITY_LABELS: Record<Density, string> = { comfortable: 'Comfortable', compact: 'Compact' };

const RANGE_OPTIONS = ['hour', 'day', 'week', 'month', 'year'] as const;

const REFRESH_OPTIONS = ['30', '60', '120', '300'] as const;
const REFRESH_LABELS: Record<(typeof REFRESH_OPTIONS)[number], string> = {
  '30': '30s',
  '60': '60s',
  '120': '2m',
  '300': '5m',
};

function PrefRow({
  label,
  description,
  children,
}: {
  label: string;
  description?: string;
  children: ReactNode;
}) {
  return (
    <div className="flex items-center justify-between gap-4 py-2.5">
      <div className="flex min-w-0 flex-col gap-0.5">
        <span className="text-sm">{label}</span>
        {description && <span className="text-xs text-muted-foreground">{description}</span>}
      </div>
      {children}
    </div>
  );
}

const SAVED_FLASH_MS = 1500;

/**
 * Preferences: appearance, dashboard defaults, console thumbnails, layout, and the signed-in
 * identity. Every control saves on interaction (no Save button) -- `useUpdatePrefs`'s optimistic
 * update makes each change feel instant regardless of the round-trip. Read-only in token mode
 * (a shared service token is not a person): every control is disabled and shows the defaults.
 */
export function PreferencesPage() {
  const { data: auth } = useAuthMe();
  const { data: prefs } = usePrefs();
  const updatePrefs = useUpdatePrefs();
  const sidebarWidth = useUiStore((s) => s.sidebarWidth);
  const setSidebarWidth = useUiStore((s) => s.setSidebarWidth);
  const [resetOpen, setResetOpen] = useState(false);
  const [showSaved, setShowSaved] = useState(false);
  const savedTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const current = prefs ?? { ...PREFS_DEFAULTS, readOnly: false };
  const readOnly = current.readOnly;

  // A thin wrapper around `updatePrefs.mutate` that also flashes "Saved" for a moment on
  // success -- `setShowSaved` here runs inside the mutation's own success callback (an ordinary
  // async callback, not an effect body), so there's nothing for the "don't setState directly in
  // an effect" rule to catch.
  function save(patch: PrefsPatch) {
    updatePrefs.mutate(patch, {
      onSuccess: () => {
        clearTimeout(savedTimerRef.current);
        setShowSaved(true);
        savedTimerRef.current = setTimeout(() => setShowSaved(false), SAVED_FLASH_MS);
      },
    });
  }

  function handleResetAll() {
    setSidebarWidth(DEFAULT_SIDEBAR_WIDTH);
    save({ ...PREFS_DEFAULTS, railWidth: DEFAULT_SIDEBAR_WIDTH });
    setResetOpen(false);
  }

  function handleResetRailWidth() {
    setSidebarWidth(DEFAULT_SIDEBAR_WIDTH);
    if (!readOnly) save({ railWidth: DEFAULT_SIDEBAR_WIDTH });
  }

  // Clears just the one guest type's saved order (the other, if any, is untouched) -- a shallow
  // patch of `summaryLayout` without that key omits it from the JSON body entirely, and the
  // server's merge is itself shallow (see `apps/server/src/prefs/store.ts`), so this can't clobber
  // a saved order for the other guest type.
  function handleResetSummaryLayout(guestType: 'qemu' | 'lxc') {
    if (readOnly) return;
    const nextLayout = { ...(current.summaryLayout ?? {}) };
    delete nextLayout[guestType];
    save({ summaryLayout: nextLayout });
  }

  return (
    <div className="flex flex-col gap-4 p-4">
      <div className="flex flex-col gap-1">
        <Breadcrumbs items={[{ label: 'Datacenter', to: 'home' }, { label: 'Preferences' }]} />
        <div className="flex items-center gap-3">
          <h1 className="font-display text-[32px] leading-tight font-light tracking-[var(--font-display-tracking)]">
            Preferences
          </h1>
          <span
            role="status"
            className="flex h-4 items-center gap-1 text-xs text-muted-foreground"
          >
            {updatePrefs.isPending ? (
              'Saving…'
            ) : showSaved ? (
              <>
                <Check className="size-3.5 text-status-running" aria-hidden="true" />
                Saved
              </>
            ) : null}
          </span>
        </div>
        <p className="text-sm text-muted-foreground">Follows you across browsers.</p>
      </div>

      <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
        <Panel title="Appearance">
          <div className="flex flex-col divide-y divide-border">
            <PrefRow label="Theme">
              <SegmentedControl
                value={current.theme}
                options={THEME_OPTIONS}
                labels={THEME_LABELS}
                ariaLabel="Theme"
                disabled={readOnly}
                onChange={(theme) => save({ theme })}
              />
            </PrefRow>
            <PrefRow label="Density" description="Tighter table rows and panel padding">
              <SegmentedControl
                value={current.density}
                options={DENSITY_OPTIONS}
                labels={DENSITY_LABELS}
                ariaLabel="Density"
                disabled={readOnly}
                onChange={(density) => save({ density })}
              />
            </PrefRow>
          </div>
        </Panel>

        <Panel title="Dashboard & charts">
          <div className="flex flex-col divide-y divide-border">
            <PrefRow
              label="Default Monitor range"
              description="Used when a Monitor tab's URL has no range of its own"
            >
              <SegmentedControl
                value={current.defaultRange}
                options={RANGE_OPTIONS}
                labels={RRD_TIMEFRAME_LABEL}
                ariaLabel="Default Monitor range"
                disabled={readOnly}
                onChange={(defaultRange) => save({ defaultRange })}
              />
            </PrefRow>
          </div>
        </Panel>

        <Panel title="Console thumbnails">
          <div className="flex flex-col divide-y divide-border">
            <PrefRow
              label="Show console thumbnails"
              description="Dashboard Consoles panel and the Summary tab's console preview"
            >
              <SwitchToggle
                checked={current.consoleThumbnails}
                ariaLabel="Show console thumbnails"
                disabled={readOnly}
                onChange={(consoleThumbnails) => save({ consoleThumbnails })}
              />
            </PrefRow>
            <PrefRow label="Refresh interval">
              <SegmentedControl
                value={String(current.thumbnailRefreshSeconds) as (typeof REFRESH_OPTIONS)[number]}
                options={REFRESH_OPTIONS}
                labels={REFRESH_LABELS}
                ariaLabel="Console thumbnail refresh interval"
                disabled={readOnly || !current.consoleThumbnails}
                onChange={(value) =>
                  save({
                    thumbnailRefreshSeconds: Number(value) as ThumbnailRefreshSeconds,
                  })
                }
              />
            </PrefRow>
          </div>
        </Panel>

        <Panel title="Layout">
          <div className="flex flex-col divide-y divide-border">
            <PrefRow label="Inventory rail width">
              <div className="flex items-center gap-2">
                <span className="font-numeric text-sm text-muted-foreground">{sidebarWidth}px</span>
                <Button variant="outline" size="sm" onClick={handleResetRailWidth}>
                  Reset to default
                </Button>
              </div>
            </PrefRow>
            <PrefRow
              label="Summary layout"
              description="Per-guest-type panel order, arranged from a VM/CT's Summary tab"
            >
              <div className="flex items-center gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  disabled={readOnly || !current.summaryLayout?.qemu?.length}
                  onClick={() => handleResetSummaryLayout('qemu')}
                >
                  Reset (VMs)
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={readOnly || !current.summaryLayout?.lxc?.length}
                  onClick={() => handleResetSummaryLayout('lxc')}
                >
                  Reset (containers)
                </Button>
              </div>
            </PrefRow>
          </div>
        </Panel>

        <Panel title="Account" className="lg:col-span-2">
          <div className="flex flex-col divide-y divide-border">
            <PrefRow label="Username">
              <span className="font-numeric text-sm">{auth?.username ?? '—'}</span>
            </PrefRow>
            <PrefRow label="Realm">
              <span className="text-sm">{auth?.realm ?? '—'}</span>
            </PrefRow>
            <PrefRow label="Sign-in mode">
              <span className="text-sm capitalize">{auth?.mode ?? '—'}</span>
            </PrefRow>
            <PrefRow label="Version">
              <span className="font-numeric text-sm text-muted-foreground">
                Proxion v{APP_VERSION}
              </span>
            </PrefRow>
          </div>
          {readOnly && (
            <p className="pt-3 text-xs text-muted-foreground">
              Signed in with a shared service token, not a personal account -- preferences can't
              be saved per-person, so every control above is shown at its default and disabled.
            </p>
          )}
        </Panel>
      </div>

      <div>
        <Button
          variant="outline"
          size="sm"
          disabled={readOnly}
          onClick={() => setResetOpen(true)}
        >
          Reset all to defaults
        </Button>
      </div>

      <Dialog open={resetOpen} onOpenChange={setResetOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Reset all preferences?</DialogTitle>
            <DialogDescription>
              Theme, density, default range, console thumbnails, and rail width all go back to
              their defaults.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setResetOpen(false)}>
              Cancel
            </Button>
            <Button variant="destructive" onClick={handleResetAll}>
              Reset
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
