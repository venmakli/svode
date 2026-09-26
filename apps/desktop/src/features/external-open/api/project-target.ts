import {
  listProjectOpeners,
  openProjectInApp,
} from "@/platform/project-openers";

import type { ExternalOpenTarget } from "../model/types";

export function projectExternalOpenTarget(
  projectPath: string,
): ExternalOpenTarget {
  return {
    preferenceKey: "directory",
    listApps: listProjectOpeners,
    open: (appId) => openProjectInApp(projectPath, appId),
  };
}
