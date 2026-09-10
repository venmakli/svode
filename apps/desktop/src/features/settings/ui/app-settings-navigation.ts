import type { ComponentType } from "react";
import * as m from "@/paraglide/messages.js";
import {
  Info,
  KeyRound,
  Keyboard,
  Paintbrush,
  PlugZap,
  Terminal,
  User,
} from "lucide-react";
import type { AppSettingsSection } from "../model";
export const APP_SETTINGS_NAV_ITEMS: {
  key: AppSettingsSection;
  label: () => string;
  icon: ComponentType<{ className?: string }>;
  show: (options: { enableLegacyAgentIntegration: boolean }) => boolean;
}[] = [
  {
    key: "git-identity",
    label: () => m.settings_profile(),
    icon: User,
    show: () => true,
  },
  {
    key: "appearance",
    label: () => m.settings_appearance(),
    icon: Paintbrush,
    show: () => true,
  },
  {
    key: "variables",
    label: () => m.settings_variables_title(),
    icon: KeyRound,
    show: () => true,
  },
  {
    key: "mcp-integrations",
    label: () => m.settings_mcp_integrations(),
    icon: PlugZap,
    show: () => true,
  },
  {
    key: "cli-agents",
    label: () => m.settings_cli_agents(),
    icon: Terminal,
    show: ({ enableLegacyAgentIntegration }) => enableLegacyAgentIntegration,
  },
  {
    key: "shortcuts",
    label: () => m.settings_shortcuts(),
    icon: Keyboard,
    show: () => true,
  },
  {
    key: "about",
    label: () => m.common_about(),
    icon: Info,
    show: () => true,
  },
];
