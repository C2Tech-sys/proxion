import { useState, type KeyboardEvent } from 'react';
import { Loader2 } from 'lucide-react';

import { Textarea } from '@/components/ui/textarea';
import { Button } from '@/components/ui/button';
import { useUpdateGuestConfig } from '@/api/actionHooks';
import { GuestActionError } from '@/api/actions';
import { cn } from '@/lib/utils';
import type { GuestType } from '@/api/types';

/** PVE's own limit on the `description` config field -- matches the server's own copy
 * (`apps/server/src/actions/routes.ts`'s `MAX_DESCRIPTION_LENGTH`). */
const MAX_DESCRIPTION_LENGTH = 8192;
/** The counter only shows up once getting close to the limit actually matters. */
const COUNTER_THRESHOLD = 7000;
const MIN_ROWS = 4;
const MAX_ROWS = 12;

export interface NotesEditorProps {
  node: string;
  type: GuestType;
  vmid: number;
  initialValue: string;
  /** Called once editing ends -- after a successful save, or on Cancel/Escape. The caller (e.g.
   * `SummaryTab`'s Notes panel) just exits edit mode either way; a successful save's own query
   * invalidation (`useUpdateGuestConfig`) is what refreshes the read view's text. */
  onDone: () => void;
}

/**
 * The notes (PVE `description`) editor: a textarea that grows with its content up to ~12 rows
 * (by counted lines, not a `scrollHeight` measurement -- "roughly 12 rows" doesn't need pixel
 * accuracy, and a line-count is deterministic in a test environment where layout isn't computed),
 * a character counter that appears once the text nears PVE's 8192-character cap, and Save/Cancel
 * (also Ctrl/Cmd+Enter and Escape). Extracted out of `SummaryTab`'s Notes panel so it can be
 * reused for nodes later -- the panel itself still owns the read/edit toggle and the "Edit"
 * button in its header, and the read view's markup is untouched.
 */
export function NotesEditor({ node, type, vmid, initialValue, onDone }: NotesEditorProps) {
  const [value, setValue] = useState(initialValue);
  const mutation = useUpdateGuestConfig();

  const lineCount = value.split('\n').length;
  const rows = Math.min(MAX_ROWS, Math.max(MIN_ROWS, lineCount + 1));
  const showCounter = value.length > COUNTER_THRESHOLD;
  const overLimit = value.length > MAX_DESCRIPTION_LENGTH;

  const serverError =
    mutation.isError && mutation.error instanceof GuestActionError
      ? mutation.error.message
      : mutation.isError
        ? 'Notes could not be saved.'
        : undefined;

  function save() {
    if (overLimit || mutation.isPending) return;
    mutation.mutate({ node, type, vmid, patch: { description: value } }, { onSuccess: onDone });
  }

  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      save();
    } else if (event.key === 'Escape') {
      event.preventDefault();
      if (!mutation.isPending) onDone();
    }
  }

  return (
    <div className="flex flex-col gap-2">
      <Textarea
        autoFocus
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={onKeyDown}
        disabled={mutation.isPending}
        rows={rows}
        maxLength={MAX_DESCRIPTION_LENGTH}
        aria-label="Notes"
        className="text-sm"
      />
      {serverError && <p className="text-xs text-status-error">{serverError}</p>}
      <div className="flex items-center justify-between gap-2">
        {showCounter ? (
          <span className={cn('text-xs font-numeric', overLimit ? 'text-status-error' : 'text-muted-foreground')}>
            {value.length}/{MAX_DESCRIPTION_LENGTH}
          </span>
        ) : (
          <span />
        )}
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" disabled={mutation.isPending} onClick={onDone}>
            Cancel
          </Button>
          <Button size="sm" disabled={overLimit || mutation.isPending} onClick={save}>
            {mutation.isPending && <Loader2 className="size-3.5 animate-spin" />}
            Save
          </Button>
        </div>
      </div>
    </div>
  );
}
