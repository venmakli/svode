import type { ComponentType } from "react";
import * as m from "@/paraglide/messages.js";
import {
  Info,
  KeyRound,
  Keyboard,
  Paintbrush,
  PlugZap,
  User,
} from "lucide-react";
import type { AppSettingsSection } from "../model";
export const APP_SETTINGS_NAV_ITEMS: {
  key: AppSettingsSection;
  label: () => string;
  icon: ComponentType<{ className?: string }>;
}[] = [
  {
    key: "git-identity",
    label: () => m.settings_profile(),
    icon: User,
  },
  {
    key: "appearance",
    label: () => m.settings_appearance(),
    icon: Paintbrush,
  },
  {
    key: "variables",
    label: () => m.variables_global_title(),
    icon: KeyRound,
  },
  {
    key: "providers",
    label: () => m.settings_providers(),
    icon: PlugZap,
  },
  {
    key: "shortcuts",
    label: () => m.settings_shortcuts(),
    icon: Keyboard,
  },
  {
    key: "about",
    label: () => m.common_about(),
    icon: Info,
  },
];
