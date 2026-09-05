import { ENABLE_LEGACY_AGENT_INTEGRATION } from "@/app/config/feature-flags";
import { useShellStore } from "@/app/shell/model";
import { AppSettingsDialog } from "@/features/settings";
import { SpaceSettingsDialog } from "@/features/settings";

export function SettingsDialogs() {
  const {
    settingsDialog,
    settingsAppSection,
    settingsAppVariablesContext,
    settingsSpaceDestination,
    settingsSpacePath,
    closeSettings,
  } = useShellStore();

  return (
    <>
      <AppSettingsDialog
        open={settingsDialog === "app"}
        initialSection={settingsAppSection}
        variablesContext={settingsAppVariablesContext ?? undefined}
        enableLegacyAgentIntegration={ENABLE_LEGACY_AGENT_INTEGRATION}
        onOpenChange={(open) => {
          if (!open) closeSettings();
        }}
      />
      <SpaceSettingsDialog
        open={settingsDialog === "space"}
        initialSection={settingsSpaceDestination}
        spacePath={settingsSpacePath}
        enableLegacyAgentIntegration={ENABLE_LEGACY_AGENT_INTEGRATION}
        onOpenChange={(open) => {
          if (!open) closeSettings();
        }}
      />
    </>
  );
}
