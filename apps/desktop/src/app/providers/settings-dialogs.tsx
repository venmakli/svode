import { useShellStore } from "@/app/shell/model";
import { AppSettingsDialog } from "@/features/settings/app-settings-dialog";
import { SpaceSettingsDialog } from "@/features/settings/space-settings-dialog";

export function SettingsDialogs() {
  const { settingsDialog, settingsSpacePath, closeSettings } = useShellStore();

  return (
    <>
      <AppSettingsDialog
        open={settingsDialog === "app"}
        onOpenChange={(open) => {
          if (!open) closeSettings();
        }}
      />
      <SpaceSettingsDialog
        open={settingsDialog === "space"}
        spacePath={settingsSpacePath}
        onOpenChange={(open) => {
          if (!open) closeSettings();
        }}
      />
    </>
  );
}
