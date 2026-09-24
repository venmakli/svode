import * as m from "@/paraglide/messages.js";
import type { SpaceGitType, SpaceStatus } from "@/features/space";

export function spaceGitTypeLabel(gitType: SpaceGitType | null | undefined) {
  if (gitType === undefined) return null;
  if (gitType === null) return m.settings_space_git_type_unknown();

  switch (gitType) {
    case "inline":
      return m.space_type_inline();
    case "independent":
      return m.space_type_independent();
    case "submodule":
      return m.space_type_submodule();
  }
}

export function spaceStatusLabel(status: SpaceStatus) {
  switch (status) {
    case "ready":
      return null;
    case "missing":
      return m.settings_space_status_missing();
    case "broken":
      return m.settings_space_status_broken();
  }
}
