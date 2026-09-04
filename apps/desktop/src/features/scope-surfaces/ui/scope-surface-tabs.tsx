import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { detailPageToolbarClassName } from "@/shared/ui/page-layout";
import type { ReactNode } from "react";
import type { ScopeSurfaceContribution, ScopeSurfaceId } from "../model/types";

interface ScopeSurfaceTabsProps {
  surfaces: readonly ScopeSurfaceContribution[];
  value: ScopeSurfaceId;
  onValueChange: (surfaceId: ScopeSurfaceId) => void;
  children: ReactNode;
  fillAvailableSpace?: boolean;
}

export function ScopeSurfaceTabs({
  surfaces,
  value,
  onValueChange,
  children,
  fillAvailableSpace = false,
}: ScopeSurfaceTabsProps) {
  if (surfaces.length < 2) return children;

  return (
    <Tabs
      value={value}
      onValueChange={(nextValue) => onValueChange(nextValue as ScopeSurfaceId)}
      className={
        fillAvailableSpace ? "flex min-h-0 flex-1 flex-col gap-0" : "gap-0"
      }
    >
      <div className={detailPageToolbarClassName}>
        <TabsList variant="line">
          {surfaces.map((surface) => (
            <TabsTrigger key={surface.id} value={surface.id}>
              {surface.label}
            </TabsTrigger>
          ))}
        </TabsList>
      </div>
      <TabsContent
        value={value}
        className={
          fillAvailableSpace ? "min-h-0 flex-1 overflow-hidden" : "flex-none"
        }
      >
        {children}
      </TabsContent>
    </Tabs>
  );
}
