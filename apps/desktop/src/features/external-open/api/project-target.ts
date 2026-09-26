import {
  listProjectOpeners,
  openProjectInApp,
} from "@/platform/project-openers";

import { DIRECTORY_PREFERENCE_KEY } from "../model/preference-key";
import type { ExternalOpenTarget } from "../model/types";

export function projectExternalOpenTarget(
  projectPath: string,
): ExternalOpenTarget {
  return {
    preferenceKey: DIRECTORY_PREFERENCE_KEY,
    listApps: listProjectOpeners,
    open: (appId) => openProjectInApp(projectPath, appId),
  };
}
