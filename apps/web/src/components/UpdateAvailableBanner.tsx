import { useState } from 'react';
import { RefreshCw, X } from 'lucide-react';

import { USE_FIXTURES } from '@/api/client';
import { useServerVersion } from '@/api/hooks';
import { APP_VERSION } from '@/version';

/**
 * A slim strip under the top bar (next to `DemoBanner`), shown when the running server's build
 * (`GET /api/health`, polled by `useServerVersion`) has moved past the bundle this tab is
 * actually running (see T38's "Why": a stale tab kept running old code for an hour after a
 * deploy, unnoticed). Reload picks up the new bundle immediately; Dismiss hides the banner for
 * *that* server version only -- component state, not persisted -- so it reappears the moment the
 * server moves to yet another version, rather than being silenced forever after one dismissal.
 *
 * Never rendered in fixture mode: the fixture client's `getHealth()` always echoes the bundle's
 * own version (see fixtures.ts), so this condition is never true there anyway, but the explicit
 * `USE_FIXTURES` guard makes that a documented invariant rather than an accident of the fixture
 * data, matching `DemoBanner`'s own fixture-mode convention.
 */
export function UpdateAvailableBanner() {
  const { data: health } = useServerVersion();
  const [dismissedVersion, setDismissedVersion] = useState<string | null>(null);

  if (USE_FIXTURES) return null;

  const serverVersion = health?.version;
  if (!serverVersion || serverVersion === APP_VERSION) return null;
  if (dismissedVersion === serverVersion) return null;

  return (
    <div
      role="status"
      className="flex h-8 shrink-0 items-center justify-center gap-2 border-b border-accent/30 bg-accent/10 px-3 text-xs text-foreground"
    >
      <span className="truncate">
        Proxion was updated to v{serverVersion} (this tab is running v{APP_VERSION}). Reload to
        get the new version.
      </span>
      <button
        type="button"
        onClick={() => window.location.reload()}
        className="ml-1 inline-flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 font-medium text-accent outline-none hover:bg-accent/15 focus-visible:ring-[3px] focus-visible:ring-ring/50"
      >
        <RefreshCw className="size-3.5" aria-hidden="true" />
        Reload
      </button>
      <button
        type="button"
        onClick={() => setDismissedVersion(serverVersion)}
        aria-label="Dismiss update banner"
        className="shrink-0 rounded p-0.5 text-muted-foreground outline-none hover:bg-accent/15 hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50"
      >
        <X className="size-3.5" />
      </button>
    </div>
  );
}
