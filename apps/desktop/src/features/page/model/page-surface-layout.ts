import type { ReactNode } from "react";

export interface PageSurfaceLayout {
  contentPath: string;
  directoryPath: string | null;
  header: (activeSurfaceId: string) => ReactNode;
  children: ReactNode;
}
