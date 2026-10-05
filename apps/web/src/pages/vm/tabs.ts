import type { ComponentType } from 'react';

import type { GuestType } from '@/api/types';
import { SummaryTab } from '@/pages/vm/tabs/SummaryTab';
import { MonitorTab } from '@/pages/vm/tabs/MonitorTab';
import { ConsoleTab } from '@/pages/vm/tabs/ConsoleTab';
import { HardwareTab } from '@/pages/vm/tabs/HardwareTab';
import { SnapshotsTab } from '@/pages/vm/tabs/SnapshotsTab';
import { BackupsTab } from '@/pages/vm/tabs/BackupsTab';
import { TasksTab } from '@/pages/vm/tabs/TasksTab';
import { OptionsTab } from '@/pages/vm/tabs/OptionsTab';
import { CloudInitTab } from '@/pages/vm/tabs/CloudInitTab';
import { FirewallTab } from '@/pages/vm/tabs/FirewallTab';

/** Props every VM/CT object-page tab receives. Tabs fetch their own data from these IDs. */
export interface VmTabProps {
  node: string;
  type: GuestType;
  vmid: number;
}

export const VM_TAB_ORDER = [
  'summary',
  'monitor',
  'console',
  'hardware',
  'cloudinit',
  'options',
  'snapshots',
  'backups',
  'firewall',
  'tasks',
] as const;
export type VmTab = (typeof VM_TAB_ORDER)[number];

export function isVmTab(value: unknown): value is VmTab {
  return typeof value === 'string' && (VM_TAB_ORDER as readonly string[]).includes(value);
}

/** tab search-param value -> { label, component }, in display order. */
export const VM_TAB_REGISTRY: Record<VmTab, { label: string; component: ComponentType<VmTabProps> }> = {
  summary: { label: 'Summary', component: SummaryTab },
  monitor: { label: 'Monitor', component: MonitorTab },
  console: { label: 'Console', component: ConsoleTab },
  hardware: { label: 'Hardware', component: HardwareTab },
  cloudinit: { label: 'Cloud-Init', component: CloudInitTab },
  options: { label: 'Options', component: OptionsTab },
  snapshots: { label: 'Snapshots', component: SnapshotsTab },
  backups: { label: 'Backups', component: BackupsTab },
  firewall: { label: 'Firewall', component: FirewallTab },
  tasks: { label: 'Tasks', component: TasksTab },
};

/** Tabs that only exist for some guest types; a tab absent here shows for every type. */
const TAB_GUEST_TYPES: Partial<Record<VmTab, readonly GuestType[]>> = {
  cloudinit: ['qemu'],
};

/** Whether `tab` is shown on a guest of `type`. */
export function isTabAvailable(tab: VmTab, type: GuestType): boolean {
  return TAB_GUEST_TYPES[tab]?.includes(type) ?? true;
}

/** The tabs a guest of `type` shows, in display order. */
export function vmTabsFor(type: GuestType): VmTab[] {
  return VM_TAB_ORDER.filter((tab) => isTabAvailable(tab, type));
}
