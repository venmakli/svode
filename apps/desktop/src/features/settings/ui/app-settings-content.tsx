import type { ShortcutGroup } from "@/shared/lib/shortcut-description";
import type { SettingsLeaveGuard } from "../model/settings-destination";
import { useAppSettingsAbout } from "../hooks/use-app-settings-about";
import { useAppSettingsAppearance } from "../hooks/use-app-settings-appearance";
import { useCliAgents } from "../hooks/use-cli-agents";
import { useGlobalIdentitySettings } from "../hooks/use-global-identity-settings";
import type { AppSettingsSection } from "../model";
import {
  AppAboutSection,
  AppAppearanceSection,
  AppCliAgentsSection,
  AppGitIdentitySection,
} from "./app-settings-sections";
import { AppShortcutsSection } from "./app-shortcuts-section";
import { McpIntegrationsSection } from "./mcp-section";
import { AppVariablesSection } from "./app-variables-section";

export function AppSettingsContent({
  section,
  enableLegacyAgentIntegration,
  shortcutGroups,
  registerLeaveGuard,
}: {
  section: AppSettingsSection;
  enableLegacyAgentIntegration: boolean;
  shortcutGroups: readonly ShortcutGroup[];
  registerLeaveGuard: (guard: SettingsLeaveGuard) => () => void;
}) {
  const appearanceSettings = useAppSettingsAppearance();
  const aboutSettings = useAppSettingsAbout();
  const cliAgents = useCliAgents({
    open: true,
    enabled: enableLegacyAgentIntegration,
  });
  return (
    <>
      {section === "git-identity" && <GlobalIdentitySettingsContent />}
      {section === "appearance" && (
        <AppAppearanceSection settings={appearanceSettings} />
      )}
      {section === "variables" && (
        <AppVariablesSection registerLeaveGuard={registerLeaveGuard} />
      )}
      {enableLegacyAgentIntegration && section === "cli-agents" && (
        <AppCliAgentsSection
          agents={cliAgents.agents}
          refreshing={cliAgents.refreshing}
          onRefresh={cliAgents.refreshAgents}
        />
      )}
      {section === "mcp-integrations" && <McpIntegrationsSection />}
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
