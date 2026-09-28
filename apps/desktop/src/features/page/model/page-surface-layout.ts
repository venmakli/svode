import type { ReactNode } from "react";

export interface PageSurfaceLayout {
  header: (activeSurfaceId: string) => ReactNode;
  children: ReactNode;
}
