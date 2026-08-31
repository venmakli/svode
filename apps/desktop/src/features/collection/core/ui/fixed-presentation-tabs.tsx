import { Tabs, TabsList } from "@/components/ui/tabs";

import { CollectionPresentationTabTrigger } from "../../ui/presentation-core";

import type { CollectionCorePresentationRuntime } from "../model/types";
import { readCollectionCorePresentationRuntime } from "../model/runtime";

export interface CollectionCoreFixedTabsProps {
  presentations: readonly CollectionCorePresentationRuntime[];
  value: string;
  onValueChange(value: string): void;
}

export function CollectionCoreFixedTabs({
  presentations,
  value,
  onValueChange,
}: CollectionCoreFixedTabsProps) {
  return (
    <Tabs
      value={value}
      onValueChange={onValueChange}
      className="min-w-0 flex-1 gap-0"
    >
      <TabsList className="scrollbar-hide min-w-0 max-w-full flex-nowrap overflow-x-auto overflow-y-hidden">
        {presentations.map((presentation) => {
          const { descriptor } =
            readCollectionCorePresentationRuntime(presentation).instance;
          return (
            <CollectionPresentationTabTrigger
              key={descriptor.id}
              value={descriptor.id}
              data-collection-core-presentation={descriptor.id}
            >
              {descriptor.label}
            </CollectionPresentationTabTrigger>
          );
        })}
      </TabsList>
    </Tabs>
  );
}
