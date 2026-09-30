import { useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Textarea } from '@/components/ui/textarea';
import { MAX_PASTE_CHARS, planTyping, typeText, type KeySender } from '@/lib/vncTyping';

/** What the dialog needs from the live RFB session (see VncConsole). */
export interface PasteTarget extends KeySender {
  clipboardPasteFrom(text: string): void;
  focus(): void;
}

export interface PasteTextDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Read at click time so a reconnect (new RFB instance) is picked up. */
  getTarget: () => PasteTarget | null;
}

function plural(n: number): string {
  return `${n} character${n === 1 ? '' : 's'}`;
}

/**
 * "Paste" for the VNC console: a box holding the text (pre-filled from the clipboard where the
 * browser allows it) that is typed into the guest as keystrokes. See `lib/vncTyping.ts` for why
 * this does not rely on VNC's clipboard message.
 */
export function PasteTextDialog({ open, onOpenChange, getTarget }: PasteTextDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        onCloseAutoFocus={(event) => {
          // Keystrokes go to the canvas, so hand focus back to it instead of the toolbar button.
          event.preventDefault();
          getTarget()?.focus();
        }}
      >
        <PasteForm onClose={() => onOpenChange(false)} getTarget={getTarget} />
      </DialogContent>
    </Dialog>
  );
}

interface PasteFormProps {
  onClose: () => void;
  getTarget: () => PasteTarget | null;
}

// Mounted fresh on every open (Radix unmounts closed content), so its state needs no reset.
function PasteForm({ onClose, getTarget }: PasteFormProps) {
  const [text, setText] = useState('');
  const [clipboardUnavailable, setClipboardUnavailable] = useState(false);
  const [progress, setProgress] = useState<{ typed: number; total: number } | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    let cancelled = false;
    Promise.resolve()
      .then(() => navigator.clipboard.readText())
      .then((clip) => {
        if (cancelled) return;
        if (clip) setText((prev) => (prev === '' ? clip : prev));
        else setClipboardUnavailable(true);
      })
      .catch(() => {
        if (!cancelled) setClipboardUnavailable(true);
      });
    return () => {
      cancelled = true;
      abortRef.current?.abort();
    };
  }, []);

  const typing = progress !== null;
  const tooLong = text.length > MAX_PASTE_CHARS;

  async function type() {
    const target = getTarget();
    if (!target || text === '' || tooLong || typing) return;
    // Harmless, and helps guests that do run a clipboard agent -- never relied on.
    try {
      target.clipboardPasteFrom(text);
    } catch {
      /* ignore */
    }
    const controller = new AbortController();
    abortRef.current = controller;
    setProgress({ typed: 0, total: planTyping(text).typed });
    const result = await typeText(target, text, {
      signal: controller.signal,
      onProgress: (typed, total) => setProgress({ typed, total }),
    });
    abortRef.current = null;
    if (controller.signal.aborted) {
      toast.info(`Typing cancelled after ${plural(result.typed)}`);
    } else {
      toast.success(
        `Typed ${plural(result.typed)}` + (result.skipped > 0 ? `; ${result.skipped} skipped` : ''),
      );
    }
    onClose();
  }

  return (
    <>
      <DialogHeader>
        <DialogTitle>Paste into console</DialogTitle>
        <DialogDescription>
          Typed as keystrokes; assumes a US keyboard layout in the guest.
        </DialogDescription>
      </DialogHeader>
      <div className="grid gap-2">
        <Textarea
          autoFocus
          aria-label="Text to type"
          rows={8}
          className="font-mono"
          value={text}
          readOnly={typing}
          onChange={(e) => setText(e.target.value)}
        />
        {clipboardUnavailable && text === '' && (
          <p className="text-xs text-muted-foreground">Paste into the box with Ctrl+V</p>
        )}
        <div className="flex items-center justify-between text-xs text-muted-foreground">
          {progress ? (
            <span role="status">
              {progress.typed} of {progress.total} characters
            </span>
          ) : (
            <span>{plural(text.length)}</span>
          )}
        </div>
        {tooLong && (
          <p role="alert" className="text-xs text-destructive">
            Too long: {text.length} of {MAX_PASTE_CHARS} characters. Trim the text to type it.
          </p>
        )}
      </div>
      <DialogFooter>
        {typing ? (
          <Button type="button" variant="outline" onClick={() => abortRef.current?.abort()}>
            Cancel
          </Button>
        ) : (
          <Button type="button" variant="outline" onClick={onClose}>
            Close
          </Button>
        )}
        <Button type="button" disabled={typing || text === '' || tooLong} onClick={() => void type()}>
          Type into console
        </Button>
      </DialogFooter>
    </>
  );
}
