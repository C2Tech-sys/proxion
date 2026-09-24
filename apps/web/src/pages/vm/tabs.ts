import type { ComponentType } from 'react';

import type { GuestType } from '@/api/types';
import { SummaryTab } from '@/pages/vm/tabs/SummaryTab';
import { MonitorTab } from '@/pages/vm/tabs/MonitorTab';
import { ConsoleTab } from '@/pages/vm/tabs/ConsoleTab';
import { HardwareTab } from '@/pages/vm/tabs/HardwareTab';
import { SnapshotsTab } from '@/pages/vm/tabs/SnapshotsTab';
import { BackupsTab } from '@/pages/vm/tabs/BackupsTab';
import { TasksTab } from '@/pages/vm/tabs/TasksTab';

/** Props every VM/CT object-page tab receives. Tabs fetch their own data from these IDs. */
export interface VmTabProps {
  node: string;
  type: GuestType;
  vmid: number;
}

export const VM_TAB_ORDER = ['summary', 'monitor', 'console', 'hardware', 'snapshots', 'backups', 'tasks'] as const;
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
  snapshots: { label: 'Snapshots', component: SnapshotsTab },
  backups: { label: 'Backups', component: BackupsTab },
  tasks: { label: 'Tasks', component: TasksTab },
};
