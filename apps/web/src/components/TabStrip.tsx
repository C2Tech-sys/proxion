import { TabsList, TabsTrigger } from '@/components/ui/tabs';

export interface TabDef {
  value: string;
  label: string;
}

export interface TabStripProps {
  tabs: TabDef[];
}

/** Renders the trigger row for an object page's tab strip. Use inside a `<Tabs>` root. */
export function TabStrip({ tabs }: TabStripProps) {
  return (
    <TabsList>
      {tabs.map((tab) => (
        <TabsTrigger key={tab.value} value={tab.value}>
          {tab.label}
        </TabsTrigger>
      ))}
    </TabsList>
  );
}
