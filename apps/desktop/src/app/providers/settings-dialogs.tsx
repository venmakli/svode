import { ENABLE_LEGACY_AGENT_INTEGRATION } from "@/app/config/feature-flags";
import { useShellStore } from "@/app/shell/model";
import { SettingsDialog } from "@/features/settings";

export function SettingsDialogs() {
  const { settingsDestination, closeSettings } = useShellStore();
  return settingsDestination ? (
    <SettingsDialog
      destination={settingsDestination}
      enableLegacyAgentIntegration={ENABLE_LEGACY_AGENT_INTEGRATION}
      onClose={closeSettings}
    />
  ) : null;
}
