import type { ReactNode } from "react";

/** What the Page's owner is beyond the Page itself. */
export interface PageSurfaceOwner {
  /** A folder Page with an App is an App, as in the sidebar. */
  isApp: boolean;
}

export interface PageSurfaceLayout {
  header: (activeSurfaceId: string, owner: PageSurfaceOwner) => ReactNode;
  children: ReactNode;
}
