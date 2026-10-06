import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { CreateVmWizard } from '@/components/create/vm/CreateVmWizard';
import { useCreateVm } from '@/api/createVmHooks';
import { useCreateStore } from '@/store/createStore';

/**
 * "Create virtual machine": the eight-step wizard (`components/create/vm/`). Mounted once in the
 * app shell; opens whenever `useCreateStore.open.kind === 'qemu'`. The create mutation lives here
 * rather than in the wizard so its follow-up (waiting for the task, the "VM created" toast and the
 * navigation to the new VM) survives the dialog closing.
 */
export function CreateVmDialog() {
  const open = useCreateStore((s) => s.open);
  const closeCreate = useCreateStore((s) => s.closeCreate);
  const isOpen = open?.kind === 'qemu';
  const mutation = useCreateVm();

  function close() {
    mutation.reset();
    closeCreate();
  }

  return (
    <Dialog
      open={isOpen}
      onOpenChange={(next) => {
        if (next || mutation.isPending) return;
        close();
      }}
    >
      <DialogContent data-testid="create-vm-dialog" className="sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>Create virtual machine</DialogTitle>
          <DialogDescription>
            {open?.node
              ? `Creates a new VM on ${open.node}. Everything is sent to Proxmox VE as one request.`
              : 'Creates a new VM. Everything is sent to Proxmox VE as one request.'}
          </DialogDescription>
        </DialogHeader>
        {isOpen && <CreateVmWizard initialNode={open.node} mutation={mutation} onClose={close} />}
      </DialogContent>
    </Dialog>
  );
}
