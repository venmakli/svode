import { GitBranch, HardDrive, KeyRound, Settings } from "lucide-react";
import * as m from "@/paraglide/messages.js";
import type { ProjectSettingsSection } from "../model/settings-destination";

export function getProjectSettingsNavItems() {
  return [
    { key: "general", label: m.settings_general(), icon: Settings },
    { key: "variables", label: m.settings_variables_title(), icon: KeyRound },
    { key: "git", label: m.git_section(), icon: GitBranch },
    { key: "storage", label: m.storage_section(), icon: HardDrive },
  ] satisfies {
    key: ProjectSettingsSection;
    label: string;
    icon: typeof Settings;
  }[];
}
