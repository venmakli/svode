import { useEffect } from "react";
import { useShellStore } from "@/app/shell/model";
import { registerRepositorySettingsOpener } from "@/features/git/app-shell";
import { SettingsDialog } from "@/features/settings";
import { registerVoiceSettingsOpener } from "@/features/voice-input";

import { settingsShortcutGroups } from "./settings-shortcuts";

export function SettingsDialogs() {
  const {
    settingsDestination,
    closeSettings,
    openAppSettings,
    openSpaceSettings,
  } = useShellStore();
  useEffect(
    () =>
      registerRepositorySettingsOpener((settingsPath) =>
        openSpaceSettings(settingsPath, "git"),
      ),
    [openSpaceSettings],
  );
  useEffect(
    () => registerVoiceSettingsOpener(() => openAppSettings("sessions")),
    [openAppSettings],
  );
  return settingsDestination ? (
    <SettingsDialog
      shortcutGroups={settingsShortcutGroups}
      destination={settingsDestination}
      onClose={closeSettings}
    />
  ) : null;
}
