import {
  Activity,
  Bot,
  FileText,
  Folder,
  GitBranch,
  HardDrive,
  Settings,
} from "lucide-react";
import * as m from "@/paraglide/messages.js";
import type { ProjectSettingsSection } from "../model/settings-destination";

export function getProjectSettingsNavItems(
  enableLegacyAgentIntegration: boolean,
  hasSpaces: boolean,
) {
  const items = [
    { key: "general", label: m.settings_general(), icon: Settings, show: true },
    { key: "spaces", label: m.settings_spaces(), icon: Folder, show: true },
    {
      key: "ai-agent",
      label: m.settings_ai_agent(),
      icon: Bot,
      show: enableLegacyAgentIntegration,
    },
    { key: "git", label: m.git_section(), icon: GitBranch, show: true },
    { key: "storage", label: m.storage_section(), icon: HardDrive, show: true },
    { key: "health", label: m.settings_health(), icon: Activity, show: true },
    {
      key: "defaults",
      label: m.settings_defaults(),
      icon: Settings,
      show: enableLegacyAgentIntegration && hasSpaces,
    },
    {
      key: "instructions",
      label: m.settings_instructions(),
      icon: FileText,
      show: enableLegacyAgentIntegration,
    },
  ] satisfies {
    key: ProjectSettingsSection;
    label: string;
    icon: typeof Settings;
    show: boolean;
  }[];
  return items.filter((item) => item.show);
}
