import { useState } from 'react';
import { Loader2 } from 'lucide-react';

import { EmptyState } from '@/components/EmptyState';
import { Panel } from '@/components/Panel';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Textarea } from '@/components/ui/textarea';
import { errorMessage } from '@/api/errors';
import { nodeSystemErrorMessage, useNodeHosts, useSaveNodeHosts } from '@/api/nodeSystemHooks';

const MAX_HOSTS_LENGTH = 65536;
const MAX_HOSTS_LINE = 1024;

export interface HostsPanelProps {
  node: string;
  /** Why editing is disabled; `undefined` when the caller may write. */
  disabledReason: string | undefined;
}

function hostsProblem(text: string): string | undefined {
  if (text.trim() === '') return 'The hosts file cannot be empty.';
  if (text.length > MAX_HOSTS_LENGTH) return `The hosts file can be at most ${MAX_HOSTS_LENGTH} characters.`;
  if (text.split(/\r\n|\r|\n/).some((line) => line.length > MAX_HOSTS_LINE)) {
    return `A line can be at most ${MAX_HOSTS_LINE} characters.`;
  }
  return undefined;
}

/**
 * Node -> System -> Hosts: a monospace editor for the node's `/etc/hosts`. Save replaces the whole
 * file and sends the digest of the last read, so Proxmox refuses it if the file changed since.
 * The query re-reads on every mount, i.e. every time this sub-tab opens, so the digest is fresh.
 */
export function HostsPanel({ node, disabledReason }: HostsPanelProps) {
  const hosts = useNodeHosts(node);
  const save = useSaveNodeHosts();
  // `null` = untouched: the editor shows the file as last read. A draft remembers the digest of the
  // read it started from, so a background refetch cannot silently swap in a newer digest.
  const [draft, setDraft] = useState<{ text: string; digest: string | undefined } | null>(null);

  const readOnly = disabledReason !== undefined;
  const text = draft?.text ?? hosts.data?.data ?? '';
  const dirty = draft !== null && hosts.data !== undefined && draft.text !== hosts.data.data;
  const problem = dirty ? hostsProblem(text) : undefined;
  const busy = save.isPending;
  const canSave = dirty && problem === undefined && !readOnly && !busy;

  function submit() {
    if (!canSave || draft === null) return;
    const body = draft.digest !== undefined ? { data: text, digest: draft.digest } : { data: text };
    save.mutate(
      { node, body },
      {
        onSuccess: () => {
          setDraft(null);
        },
      },
    );
  }

  return (
    <div data-testid="node-system-hosts">
      <Panel
        title="Hosts"
        action={
          <div className="flex items-center gap-2">
            <Button
              variant="ghost"
              size="sm"
              disabled={!dirty || busy}
              onClick={() => {
                setDraft(null);
                save.reset();
              }}
            >
              Discard changes
            </Button>
            <Button size="sm" disabled={!canSave} title={readOnly ? disabledReason : undefined} onClick={submit}>
              {busy && <Loader2 className="size-4 animate-spin" />}
              Save
            </Button>
          </div>
        }
      >
        {hosts.isLoading ? (
          <Skeleton className="h-64" />
        ) : hosts.isError ? (
          <EmptyState message={`Could not load the hosts file: ${errorMessage(hosts.error)}`} />
        ) : (
          <div className="flex flex-col gap-2">
            <label htmlFor={`hosts-editor-${node}`} className="text-sm text-muted-foreground">
              /etc/hosts on {node}
            </label>
            <Textarea
              id={`hosts-editor-${node}`}
              className="min-h-64 font-mono text-[13px]"
              value={text}
              onChange={(e) => {
                setDraft({ text: e.target.value, digest: draft?.digest ?? hosts.data?.digest });
                if (save.isError) save.reset();
              }}
              readOnly={readOnly}
              title={readOnly ? disabledReason : undefined}
              rows={16}
              spellCheck={false}
              autoComplete="off"
              aria-invalid={problem !== undefined || undefined}
            />
            {problem && <p className="text-xs text-status-error">{problem}</p>}
            {save.isError && (
              <p role="alert" className="text-xs text-status-error">
                {nodeSystemErrorMessage(save.error, 'The hosts file could not be saved.')}
              </p>
            )}
            <p className="text-xs text-muted-foreground">Saving replaces the whole file.</p>
          </div>
        )}
      </Panel>
    </div>
  );
}
