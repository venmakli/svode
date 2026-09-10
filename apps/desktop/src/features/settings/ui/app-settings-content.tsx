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
  AppShortcutsSection,
} from "./app-settings-sections";
import { McpIntegrationsSection } from "./mcp-section";
import { AppVariablesSection } from "./app-variables-section";

export function AppSettingsContent({
  section,
  enableLegacyAgentIntegration,
}: {
  section: AppSettingsSection;
  enableLegacyAgentIntegration: boolean;
}) {
  const appearanceSettings = useAppSettingsAppearance();
  const aboutSettings = useAppSettingsAbout();
  const cliAgents = useCliAgents({
    open: true,
    enabled: enableLegacyAgentIntegration,
  });
  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-4 overflow-x-hidden overflow-y-auto p-4">
      {section === "git-identity" && <GlobalIdentitySettingsContent />}
      {section === "appearance" && (
        <AppAppearanceSection settings={appearanceSettings} />
      )}
      {section === "variables" && <AppVariablesSection />}
      {enableLegacyAgentIntegration && section === "cli-agents" && (
        <AppCliAgentsSection
          agents={cliAgents.agents}
          refreshing={cliAgents.refreshing}
          onRefresh={cliAgents.refreshAgents}
        />
      )}
      {section === "mcp-integrations" && <McpIntegrationsSection />}
      {section === "shortcuts" && <AppShortcutsSection />}
      {section === "about" && <AppAboutSection {...aboutSettings} />}
    </div>
  );
}

function GlobalIdentitySettingsContent() {
  const settings = useGlobalIdentitySettings(true);
  return <AppGitIdentitySection settings={settings} />;
}
