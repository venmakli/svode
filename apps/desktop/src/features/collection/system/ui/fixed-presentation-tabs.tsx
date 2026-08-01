import { Tabs, TabsList } from "@/components/ui/tabs";

import { CollectionPresentationTabTrigger } from "../../ui/presentation-core";

import type { SystemCollectionPresentationRuntime } from "../model/types";
import { readSystemCollectionPresentationRuntime } from "../model/runtime";

export interface SystemCollectionFixedTabsProps {
  presentations: readonly SystemCollectionPresentationRuntime[];
  value: string;
  onValueChange(value: string): void;
}

export function SystemCollectionFixedTabs({
  presentations,
  value,
  onValueChange,
}: SystemCollectionFixedTabsProps) {
  return (
    <Tabs
      value={value}
      onValueChange={onValueChange}
      className="min-w-0 flex-1 gap-0"
    >
      <TabsList className="scrollbar-hide min-w-0 max-w-full flex-nowrap overflow-x-auto overflow-y-hidden">
        {presentations.map((presentation) => {
          const { descriptor } =
            readSystemCollectionPresentationRuntime(presentation).instance;
          return (
            <CollectionPresentationTabTrigger
              key={descriptor.id}
              value={descriptor.id}
              data-system-collection-presentation={descriptor.id}
            >
              {descriptor.label}
            </CollectionPresentationTabTrigger>
          );
        })}
      </TabsList>
    </Tabs>
  );
}
