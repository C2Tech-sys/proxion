import { Checkbox } from '@/components/ui/checkbox';
import type { ClusterResource } from '@/api/types';

export interface GuestChecklistProps {
  /** Accessible name of the group, e.g. "Guests to back up". */
  label: string;
  /** The cluster resources; only qemu/lxc rows are listed. */
  resources: ClusterResource[] | undefined;
  selected: number[];
  onChange: (next: number[]) => void;
  disabled?: boolean | undefined;
  /** Shown instead of the list when there are no guests. */
  emptyMessage?: string;
}

interface GuestRow {
  vmid: number;
  name: string;
  node: string;
  type: string;
}

function guestRows(resources: ClusterResource[] | undefined): GuestRow[] {
  const rows: GuestRow[] = [];
  for (const r of resources ?? []) {
    if ((r.type !== 'qemu' && r.type !== 'lxc') || r.vmid === undefined) continue;
    rows.push({ vmid: r.vmid, name: r.name ?? `${r.type}/${r.vmid}`, node: r.node, type: r.type });
  }
  return rows.sort((a, b) => a.node.localeCompare(b.node) || a.vmid - b.vmid);
}

/**
 * A checkbox per guest in the cluster, grouped by node, for the backup job dialog's "choose
 * guests" selection and its "all guests except..." exclude list. A vmid that is selected but no
 * longer in the cluster stays listed (under "Not in the cluster") so it can be unticked.
 */
export function GuestChecklist({ label, resources, selected, onChange, disabled, emptyMessage }: GuestChecklistProps) {
  const rows = guestRows(resources);
  const known = new Set(rows.map((r) => r.vmid));
  const missing = selected.filter((vmid) => !known.has(vmid)).sort((a, b) => a - b);
  const byNode = new Map<string, GuestRow[]>();
  for (const row of rows) {
    const list = byNode.get(row.node);
    if (list) list.push(row);
    else byNode.set(row.node, [row]);
  }

  function toggle(vmid: number, checked: boolean) {
    onChange(checked ? [...selected, vmid] : selected.filter((v) => v !== vmid));
  }

  if (rows.length === 0 && missing.length === 0) {
    return <p className="text-xs text-muted-foreground">{emptyMessage ?? 'No guests found in the cluster.'}</p>;
  }

  return (
    <div role="group" aria-label={label} className="max-h-48 overflow-y-auto rounded-md border border-border p-2">
      {[...byNode.entries()].map(([node, guests]) => (
        <div key={node} className="mb-2 last:mb-0">
          <div className="mb-1 text-xs font-medium tracking-wide text-muted-foreground uppercase">{node}</div>
          <ul className="flex flex-col gap-1">
            {guests.map((g) => (
              <GuestItem
                key={g.vmid}
                row={g}
                checked={selected.includes(g.vmid)}
                disabled={disabled}
                onChange={(checked) => toggle(g.vmid, checked)}
              />
            ))}
          </ul>
        </div>
      ))}
      {missing.length > 0 && (
        <div className="mb-0">
          <div className="mb-1 text-xs font-medium tracking-wide text-muted-foreground uppercase">
            Not in the cluster
          </div>
          <ul className="flex flex-col gap-1">
            {missing.map((vmid) => (
              <GuestItem
                key={vmid}
                row={{ vmid, name: 'unknown guest', node: '', type: '' }}
                checked
                disabled={disabled}
                onChange={(checked) => toggle(vmid, checked)}
              />
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

function GuestItem({
  row,
  checked,
  disabled,
  onChange,
}: {
  row: GuestRow;
  checked: boolean;
  disabled: boolean | undefined;
  onChange: (checked: boolean) => void;
}) {
  const id = `guest-check-${row.vmid}`;
  return (
    <li className="flex items-center gap-2">
      <Checkbox id={id} checked={checked} disabled={disabled} onCheckedChange={(c) => onChange(c === true)} />
      <label htmlFor={id} className="text-sm">
        {row.vmid} <span className="text-muted-foreground">{row.name}</span>
      </label>
    </li>
  );
}
