import * as m from "@/paraglide/messages.js";
import type { HomeProjectAvailability } from "../model/home-projects";

/** Why Home cannot work with the project; null when it can. */
export function homeProjectUnavailableReason(
  availability: HomeProjectAvailability,
): string | null {
  switch (availability) {
    case "available":
      return null;
    case "otherWindow":
      return m.home_project_other_window();
    case "missing":
      return m.home_project_missing();
    case "broken":
      return m.home_project_broken();
  }
}
