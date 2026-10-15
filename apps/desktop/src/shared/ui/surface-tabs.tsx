import type { ReactNode } from "react";

import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

import { detailPageToolbarClassName } from "./page-layout";

export interface SurfaceTab<Id extends string = string> {
  id: Id;
  label: string;
}

/**
 * Line tabs above the content of a surface. One tab hides the strip, and the
 * content then drops the tab panel semantics; the caller renders the content
 * of the active tab.
 */
export function SurfaceTabs<Id extends string>({
  tabs,
  value,
  onValueChange,
  children,
  fillAvailableSpace = false,
}: {
  tabs: readonly SurfaceTab<Id>[];
  value: Id;
  onValueChange: (id: Id) => void;
  children: ReactNode;
  fillAvailableSpace?: boolean;
}) {
  const showTabs = tabs.length >= 2;

  return (
    <Tabs
      value={value}
      onValueChange={(nextValue) => onValueChange(nextValue as Id)}
      className={
        fillAvailableSpace ? "flex min-h-0 flex-1 flex-col gap-0" : "gap-0"
      }
    >
      {showTabs ? (
        <div className={detailPageToolbarClassName}>
          <TabsList variant="line">
            {tabs.map((tab) => (
              <TabsTrigger key={tab.id} value={tab.id}>
                {tab.label}
              </TabsTrigger>
            ))}
          </TabsList>
        </div>
      ) : null}
      <TabsContent
        value={value}
        {...(!showTabs
          ? { role: undefined, "aria-labelledby": undefined }
          : {})}
        className={
          fillAvailableSpace ? "min-h-0 flex-1 overflow-hidden" : "flex-none"
        }
      >
        {children}
      </TabsContent>
    </Tabs>
  );
}
