import { useId, useState } from 'react';
import { Loader2 } from 'lucide-react';

import { EmptyState } from '@/components/EmptyState';
import { KeyValueGrid } from '@/components/KeyValueGrid';
import { Panel } from '@/components/Panel';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { EditHardwareButton } from '@/components/hardware/EditHardwareButton';
import { SystemField } from '@/components/nodesystem/SystemField';
import { errorMessage } from '@/api/errors';
import { nodeSystemErrorMessage, useNodeDns, useUpdateNodeDns } from '@/api/nodeSystemHooks';
import type { NodeDns } from '@/api/nodeSystem';
import { isIPv4, isIPv6 } from '@/lib/pve-config';

const DNS_LABEL = '[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?';
const DNS_NAME_RE = new RegExp(`^${DNS_LABEL}(\\.${DNS_LABEL})*$`);

const SERVER_KEYS = ['dns1', 'dns2', 'dns3'] as const;

function isPlainIp(value: string): boolean {
  return isIPv4(value) || isIPv6(value);
}

export interface DnsPanelProps {
  node: string;
  /** Why editing is disabled; `undefined` when the caller may write. */
  disabledReason: string | undefined;
}

/** Node -> System -> DNS: the search domain and up to three DNS servers. */
export function DnsPanel({ node, disabledReason }: DnsPanelProps) {
  const dns = useNodeDns(node);
  const [editing, setEditing] = useState(false);

  return (
    <div data-testid="node-system-dns">
      <Panel
        title="DNS"
        action={
          dns.data ? (
            <EditHardwareButton label="DNS" disabledReason={disabledReason} onClick={() => setEditing(true)} />
          ) : undefined
        }
      >
        {dns.isLoading ? (
          <Skeleton className="h-20" />
        ) : dns.isError ? (
          <EmptyState message={`Could not load the DNS settings: ${errorMessage(dns.error)}`} />
        ) : dns.data ? (
          <KeyValueGrid
            rows={[
              { label: 'Search domain', value: dns.data.search || '-' },
              { label: 'DNS server 1', value: dns.data.dns1 ?? '-' },
              { label: 'DNS server 2', value: dns.data.dns2 ?? '-' },
              { label: 'DNS server 3', value: dns.data.dns3 ?? '-' },
            ]}
          />
        ) : null}
      </Panel>
      {editing && dns.data && (
        <DnsDialog
          open
          onOpenChange={(open) => {
            if (!open) setEditing(false);
          }}
          node={node}
          current={dns.data}
        />
      )}
    </div>
  );
}

interface DnsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  node: string;
  current: NodeDns;
}

/**
 * Edits the search domain and the three servers. PVE rewrites resolv.conf from what it is given, so
 * all four values are always sent; a blank server is sent as `null` (the server leaves it out).
 * Mount it fresh per open.
 */
function DnsDialog({ open, onOpenChange, node, current }: DnsDialogProps) {
  const id = useId();
  const mutation = useUpdateNodeDns();
  const [search, setSearch] = useState(current.search);
  const [servers, setServers] = useState<[string, string, string]>([
    current.dns1 ?? '',
    current.dns2 ?? '',
    current.dns3 ?? '',
  ]);

  const busy = mutation.isPending;
  const trimmedSearch = search.trim();
  const searchError =
    trimmedSearch === ''
      ? 'Enter a search domain.'
      : trimmedSearch.length > 253 || !DNS_NAME_RE.test(trimmedSearch)
        ? 'Enter a valid domain name, e.g. lab.local.'
        : undefined;
  const serverErrors = servers.map((value) =>
    value.trim() !== '' && !isPlainIp(value.trim()) ? 'Enter a valid IPv4 or IPv6 address.' : undefined,
  );
  const valid = searchError === undefined && serverErrors.every((e) => e === undefined);
  const changed =
    trimmedSearch !== current.search ||
    SERVER_KEYS.some((key, i) => servers[i]!.trim() !== (current[key] ?? ''));
  const canSave = valid && changed && !busy;

  function submit() {
    if (!canSave) return;
    const value = (i: number) => (servers[i]!.trim() === '' ? null : servers[i]!.trim());
    mutation.mutate(
      { node, body: { search: trimmedSearch, dns1: value(0), dns2: value(1), dns3: value(2) } },
      { onSuccess: () => onOpenChange(false) },
    );
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next && busy) return;
        onOpenChange(next);
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Edit: DNS</DialogTitle>
          <DialogDescription>Proxmox rewrites the node&apos;s resolv.conf from these values.</DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-4">
          <SystemField label="Search domain" htmlFor={`${id}-search`} error={searchError}>
            <Input
              id={`${id}-search`}
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              disabled={busy}
              aria-invalid={searchError !== undefined || undefined}
              placeholder="lab.local"
              autoComplete="off"
            />
          </SystemField>
          {SERVER_KEYS.map((key, i) => (
            <SystemField key={key} label={`DNS server ${i + 1}`} htmlFor={`${id}-${key}`} error={serverErrors[i]}>
              <Input
                id={`${id}-${key}`}
                value={servers[i]}
                onChange={(e) => {
                  const next: [string, string, string] = [...servers];
                  next[i] = e.target.value;
                  setServers(next);
                }}
                disabled={busy}
                aria-invalid={serverErrors[i] !== undefined || undefined}
                placeholder={i === 0 ? '10.0.0.1' : 'Optional'}
                autoComplete="off"
              />
            </SystemField>
          ))}
          {mutation.isError && (
            <p role="alert" className="text-xs text-status-error">
              {nodeSystemErrorMessage(mutation.error, 'The DNS settings could not be saved.')}
            </p>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={!canSave}>
            {busy && <Loader2 className="size-4 animate-spin" />}
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
