import { useState, type ReactNode } from "react";

import { SurfaceTabs } from "@/shared/ui/surface-tabs";

export interface AgentContextItemTab {
  id: string;
  label: string;
  /** `null` when the item has nothing for this tab: the tab is not shown. */
  content: ReactNode | null;
}

/**
 * The content of an item's peek in the surface tabs of a page with
 * attachments: a tab without content is not shown, the first one opens, and
 * one tab hides the strip. Tab content keeps the peek column's gutter.
 */
export function AgentContextItemTabs({
  tabs,
}: {
  tabs: readonly AgentContextItemTab[];
}) {
  const available = tabs.filter((tab) => tab.content !== null);
  const [selected, setSelected] = useState<string | null>(null);
  const active =
    available.find((tab) => tab.id === selected) ?? available.at(0);
  if (!active) return null;

  return (
    <div className="-mx-6 min-w-0" data-agent-context-item-tabs={active.id}>
      <SurfaceTabs
        tabs={available}
        value={active.id}
        onValueChange={setSelected}
      >
        {active.content}
      </SurfaceTabs>
    </div>
  );
}
