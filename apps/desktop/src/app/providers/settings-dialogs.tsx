import { ENABLE_LEGACY_AGENT_INTEGRATION } from "@/app/config/feature-flags";
import { useShellStore } from "@/app/shell/model";
import { SettingsDialog } from "@/features/settings";

import { settingsShortcutGroups } from "./settings-shortcuts";

export function SettingsDialogs() {
  const { settingsDestination, closeSettings } = useShellStore();
  return settingsDestination ? (
    <SettingsDialog
      shortcutGroups={settingsShortcutGroups}
      destination={settingsDestination}
      enableLegacyAgentIntegration={ENABLE_LEGACY_AGENT_INTEGRATION}
      onClose={closeSettings}
    />
  ) : null;
}
