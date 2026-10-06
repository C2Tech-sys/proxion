import { create } from 'zustand';

export type CreateKind = 'qemu' | 'lxc';

export interface CreateRequest {
  kind: CreateKind;
  /** The node the user launched the wizard from (the inventory tree's node menu); unset when it
   * was launched from the top bar, where the wizard asks for a node itself. */
  node?: string;
}

interface CreateState {
  /** `null` while no create wizard is open. */
  open: CreateRequest | null;
  openCreate: (kind: CreateKind, node?: string) => void;
  closeCreate: () => void;
}

/**
 * Which "Create VM" / "Create CT" wizard is open, shared by every entry point (top bar, node
 * context menu) and the two dialogs mounted once in the shell. The wizards read this; nothing
 * else about them lives here.
 */
export const useCreateStore = create<CreateState>((set) => ({
  open: null,
  openCreate: (kind, node) => set({ open: node === undefined ? { kind } : { kind, node } }),
  closeCreate: () => set({ open: null }),
}));
