import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@/components/ui/tabs";
import { detailPageToolbarClassName } from "@/shared/ui/page-layout";
import type { ReactNode } from "react";
import type { ScopeSurfaceContribution, ScopeSurfaceId } from "../model/types";

interface ScopeSurfaceTabsProps {
  surfaces: readonly ScopeSurfaceContribution[];
  value: ScopeSurfaceId;
  onValueChange: (surfaceId: ScopeSurfaceId) => void;
  children: ReactNode;
}

export function ScopeSurfaceTabs({
  surfaces,
  value,
  onValueChange,
  children,
}: ScopeSurfaceTabsProps) {
  if (surfaces.length < 2) return children;

  return (
    <Tabs
      value={value}
      onValueChange={(nextValue) =>
        onValueChange(nextValue as ScopeSurfaceId)
      }
      className="gap-0"
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
      <TabsContent value={value} className="flex-none">
        {children}
      </TabsContent>
    </Tabs>
  );
}
