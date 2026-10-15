import type { ReactNode } from "react";

import { SurfaceTabs } from "@/shared/ui/surface-tabs";

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
  ...props
}: ScopeSurfaceTabsProps) {
  return <SurfaceTabs tabs={surfaces} {...props} />;
}
