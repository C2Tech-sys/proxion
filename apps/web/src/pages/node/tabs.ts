import type { ComponentType } from 'react';

import { SummaryTab } from '@/pages/node/tabs/SummaryTab';
import { MonitorTab } from '@/pages/node/tabs/MonitorTab';
import { ShellTab } from '@/pages/node/tabs/ShellTab';
import { StorageTab } from '@/pages/node/tabs/StorageTab';
import { TasksTab } from '@/pages/node/tabs/TasksTab';

/** Props every node object-page tab receives. Tabs fetch their own data from this ID. */
export interface NodeTabProps {
  node: string;
}

export const NODE_TAB_ORDER = ['summary', 'monitor', 'shell', 'storage', 'tasks'] as const;
export type NodeTab = (typeof NODE_TAB_ORDER)[number];

export function isNodeTab(value: unknown): value is NodeTab {
  return typeof value === 'string' && (NODE_TAB_ORDER as readonly string[]).includes(value);
}

/** tab search-param value -> { label, component }, in display order. */
export const NODE_TAB_REGISTRY: Record<NodeTab, { label: string; component: ComponentType<NodeTabProps> }> = {
  summary: { label: 'Summary', component: SummaryTab },
  monitor: { label: 'Monitor', component: MonitorTab },
  shell: { label: 'Shell', component: ShellTab },
  storage: { label: 'Storage', component: StorageTab },
  tasks: { label: 'Tasks', component: TasksTab },
};
