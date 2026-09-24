import { useState } from 'react';
import { X } from 'lucide-react';

import { USE_FIXTURES } from '@/api/client';

/** Where the banner's "Install Proxion" link points -- the repo's own Quickstart section. */
const QUICKSTART_URL = 'https://github.com/C2Tech-sys/proxion#quickstart';

/** Remembers the banner's dismissal across reloads, per browser. Best-effort: a private window
 *  or blocked site data just falls back to "not dismissed" (the banner shows again). */
const DISMISSED_KEY = 'proxion.demoBanner.dismissed';

function readDismissed(): boolean {
  try {
    return localStorage.getItem(DISMISSED_KEY) === '1';
  } catch {
    return false;
  }
}

function writeDismissed(): void {
  try {
    localStorage.setItem(DISMISSED_KEY, '1');
  } catch {
    // ignore persistence failures (private browsing, blocked site data, ...)
  }
}

/**
 * A slim strip under the top bar, shown only when the app is running against static fixtures
 * (the GitHub Pages demo, or a local `pnpm demo`) -- never against a real Proxmox server. Says
 * so plainly, links out to the repo's Quickstart, and remembers a dismissal in `localStorage` so
 * it doesn't nag a returning visitor on every reload.
 */
export function DemoBanner() {
  const [dismissed, setDismissed] = useState(readDismissed);

  if (!USE_FIXTURES || dismissed) return null;

  function dismiss() {
    writeDismissed();
    setDismissed(true);
  }

  return (
    <div
      role="note"
      className="flex h-8 shrink-0 items-center justify-center gap-2 border-b border-accent/30 bg-accent/10 px-3 text-xs text-foreground"
    >
      <span className="truncate">
        <span className="font-medium">Demo</span> — sample data, nothing here is real.{' '}
        <a
          href={QUICKSTART_URL}
          target="_blank"
          rel="noopener noreferrer"
          className="font-medium text-accent underline-offset-2 hover:underline"
        >
          Install Proxion →
        </a>
      </span>
      <button
        type="button"
        onClick={dismiss}
        aria-label="Dismiss demo banner"
        className="ml-1 shrink-0 rounded p-0.5 text-muted-foreground outline-none hover:bg-accent/15 hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50"
      >
        <X className="size-3.5" />
      </button>
    </div>
  );
}
