import type { ShortcutGroup } from "@/shared/lib/shortcut-description";
import type { SettingsLeaveGuard } from "../model/settings-destination";
import { useAppSettingsAbout } from "../hooks/use-app-settings-about";
import { useAppSettingsAppearance } from "../hooks/use-app-settings-appearance";
import { useGlobalIdentitySettings } from "../hooks/use-global-identity-settings";
import type { AppSettingsSection } from "../model";
import {
  AppAboutSection,
  AppAppearanceSection,
  AppGitIdentitySection,
} from "./app-settings-sections";
import { AppShortcutsSection } from "./app-shortcuts-section";
import { GlobalVariablesSection } from "./app-variables-section";
import { ProvidersSection } from "./providers-section";

export function AppSettingsContent({
  section,
  shortcutGroups,
  registerLeaveGuard,
}: {
  section: AppSettingsSection;
  shortcutGroups: readonly ShortcutGroup[];
  registerLeaveGuard: (guard: SettingsLeaveGuard) => () => void;
}) {
  const appearanceSettings = useAppSettingsAppearance();
  const aboutSettings = useAppSettingsAbout();
  return (
    <>
      {section === "git-identity" && <GlobalIdentitySettingsContent />}
      {section === "appearance" && (
        <AppAppearanceSection settings={appearanceSettings} />
      )}
      {section === "variables" && (
        <GlobalVariablesSection registerLeaveGuard={registerLeaveGuard} />
      )}
      {section === "providers" && <ProvidersSection />}
      {section === "shortcuts" && (
        <AppShortcutsSection groups={shortcutGroups} />
      )}
      {section === "about" && <AppAboutSection {...aboutSettings} />}
    </>
  );
}

function GlobalIdentitySettingsContent() {
  const settings = useGlobalIdentitySettings(true);
  return <AppGitIdentitySection settings={settings} />;
}
