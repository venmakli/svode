import { Tabs, TabsList } from "@/components/ui/tabs";

import { CollectionPresentationTabTrigger } from "../../ui/presentation-chrome";

import type { CollectionPresentationRuntime } from "../model/types";
import { readCollectionPresentationRuntime } from "../model/runtime";

export interface CollectionFixedTabsProps {
  presentations: readonly CollectionPresentationRuntime[];
  value: string;
  onValueChange(value: string): void;
}

export function CollectionFixedTabs({
  presentations,
  value,
  onValueChange,
}: CollectionFixedTabsProps) {
  return (
    <Tabs
      value={value}
      onValueChange={onValueChange}
      className="min-w-0 flex-1 gap-0"
    >
      <TabsList className="scrollbar-hide min-w-0 max-w-full flex-nowrap overflow-x-auto overflow-y-hidden">
        {presentations.map((presentation) => {
          const { descriptor } =
            readCollectionPresentationRuntime(presentation).instance;
          return (
            <CollectionPresentationTabTrigger
              key={descriptor.id}
              value={descriptor.id}
              data-collection-presentation={descriptor.id}
            >
              {descriptor.label}
            </CollectionPresentationTabTrigger>
          );
        })}
      </TabsList>
    </Tabs>
  );
}
