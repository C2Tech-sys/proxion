import { useMemo } from 'react';

import { buildCreateVmBody, summaryRows, type VmForm } from '@/components/create/vm/wizardState';

/** Step 8: a key/value summary of everything the create request will carry. */
export function StepConfirm({ form }: { form: VmForm }) {
  const rows = useMemo(() => {
    const body = buildCreateVmBody(form);
    return body ? summaryRows(body, form.node) : undefined;
  }, [form]);

  if (!rows) {
    return (
      <p role="alert" className="text-sm text-status-error">
        Some earlier steps are incomplete. Go back and fix them before creating the VM.
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      <p className="text-sm text-muted-foreground">
        Review the settings below. Creating the VM sends them to Proxmox VE as one request.
      </p>
      <dl data-testid="create-vm-summary" className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1.5 text-sm">
        {rows.map((row) => (
          <div key={row.label} className="contents">
            <dt className="text-muted-foreground">{row.label}</dt>
            <dd className="font-medium break-all">{row.value}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}
