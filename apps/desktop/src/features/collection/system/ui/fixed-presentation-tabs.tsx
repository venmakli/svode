import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";

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
  if (presentations.length <= 1) {
    return null;
  }

  return (
    <Tabs value={value} onValueChange={onValueChange} className="min-w-0 gap-0">
      <TabsList className="min-w-0 max-w-full flex-nowrap overflow-x-auto">
        {presentations.map((presentation) => {
          const { descriptor } =
            readSystemCollectionPresentationRuntime(presentation).instance;
          return (
            <TabsTrigger
              key={descriptor.id}
              value={descriptor.id}
              data-system-collection-presentation={descriptor.id}
            >
              {descriptor.label}
            </TabsTrigger>
          );
        })}
      </TabsList>
    </Tabs>
  );
}
