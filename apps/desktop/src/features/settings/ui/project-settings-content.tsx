import { useCallback, useLayoutEffect, useRef } from "react";
import { useOpenPage } from "@/features/page/navigation";
import { useSpace } from "@/features/space";
import { useProjectSpaceGitTypes } from "../hooks/use-project-space-git-types";
import { useSpaceSettingsAgent } from "../hooks/use-space-settings-agent";
import { useSpaceSettingsConfigActions } from "../hooks/use-space-settings-config-actions";
import { useSpaceSettingsDefaults } from "../hooks/use-space-settings-defaults";
import type {
  ProjectSettingsSection,
  SettingsLeaveGuard,
} from "../model/settings-destination";
import { ProjectVariablesSection } from "./app-variables-section";
import { ProjectGeneralSection } from "./project-general-section";
import { ProjectGitSection } from "./project-git-section";
import { ProjectOwnerBlock } from "./project-owner-block";
import { ProjectStorageSection } from "./project-storage-section";
import { SpaceAgentSection } from "./space-agent-section";
import { SpaceDefaultsSection } from "./space-defaults-section";
import { SpaceInstructionsSection } from "./space-instructions-section";

// One project section page: the project block, then a block per space. The
// destination's space is the owner whose block is shown; the project opens
// the page at its top.
export function ProjectSettingsContent({
  destination,
  enableLegacyAgentIntegration,
  onClose,
  registerLeaveGuard,
}: {
  destination: { section: ProjectSettingsSection; spacePath: string };
  enableLegacyAgentIntegration: boolean;
  onClose: () => void;
  registerLeaveGuard: (guard: SettingsLeaveGuard) => () => void;
}) {
  const open = true;
  const openPage = useOpenPage();
  const {
    activeRootId,
    activeRootPath,
    activeRootName,
    activeRootIcon,
    spaces,
  } = useSpace();
  const projectPath = activeRootPath!;
  const projectName = activeRootName || "Project";
  const hasSpaces = spaces.length > 0;
  const { section, spacePath } = destination;
  const reveal = {
    owner: spacePath === projectPath ? null : spacePath,
    request: destination,
  };

  const { saveConfig } = useSpaceSettingsConfigActions({
    spacePath: projectPath,
    projectPath,
  });
  const agentSettings = useSpaceSettingsAgent({
    open,
    enabled: enableLegacyAgentIntegration,
    spacePath: projectPath,
    projectPath,
    saveConfig,
  });
  const defaultsSettings = useSpaceSettingsDefaults({
    open,
    enabled: enableLegacyAgentIntegration,
    spacePath: projectPath,
    saveConfig,
  });
  const gitTypes = useProjectSpaceGitTypes({
    open,
    active: true,
    projectPath,
    spaces,
  });
  // Every owner part with its own pending writes (Variables catalogs, Storage
  // apply and S3) registers here; leaving is allowed only when none is busy.
  const sectionGuards = useRef(new Set<SettingsLeaveGuard>());
  const registerSectionGuard = useCallback((guard: SettingsLeaveGuard) => {
    sectionGuards.current.add(guard);
    return () => {
      sectionGuards.current.delete(guard);
    };
  }, []);

  useLayoutEffect(
    () =>
      registerLeaveGuard(() => {
        for (const guard of sectionGuards.current) if (!guard()) return false;
        return true;
      }),
    [registerLeaveGuard],
  );

  function handleOpenAgentsMd() {
    onClose();
    openPage(".svode/AGENTS.md", activeRootId ?? undefined);
  }

  const owners = {
    projectPath,
    projectName,
    projectIcon: activeRootIcon,
    spaces,
    gitTypes,
    reveal,
  };

  return (
    <>
      {section === "general" && <ProjectGeneralSection {...owners} />}

      {section === "variables" && (
        <ProjectVariablesSection
          {...owners}
          registerLeaveGuard={registerSectionGuard}
        />
      )}

      {enableLegacyAgentIntegration && section === "ai-agent" && (
        <ProjectOwnerBlock name={projectName} icon={activeRootIcon}>
          <SpaceAgentSection
            agents={agentSettings.agents}
            enabledClis={agentSettings.enabledClis}
            defaultModel={agentSettings.defaultModel}
            systemPrompt={agentSettings.systemPrompt}
            availableModels={agentSettings.availableModels}
            healthReport={agentSettings.healthReport}
            refreshing={agentSettings.refreshing}
            onDefaultModelChange={agentSettings.handleDefaultModelChange}
            onSystemPromptChange={agentSettings.setSystemPrompt}
            onSystemPromptBlur={agentSettings.handleSystemPromptBlur}
            onCliToggle={agentSettings.handleCliToggle}
            onRefresh={agentSettings.handleRefresh}
          />
        </ProjectOwnerBlock>
      )}

      {section === "git" && <ProjectGitSection {...owners} />}

      {section === "storage" && (
        <ProjectStorageSection
          {...owners}
          registerLeaveGuard={registerSectionGuard}
        />
      )}

      {enableLegacyAgentIntegration && section === "defaults" && hasSpaces && (
        <ProjectOwnerBlock name={projectName} icon={activeRootIcon}>
          <SpaceDefaultsSection
            model={defaultsSettings.defaultsModel}
            prompt={defaultsSettings.defaultsPrompt}
            availableModels={agentSettings.availableModels}
            onModelChange={defaultsSettings.handleDefaultsModelChange}
            onPromptChange={defaultsSettings.setDefaultsPrompt}
            onPromptBlur={defaultsSettings.handleDefaultsPromptBlur}
          />
        </ProjectOwnerBlock>
      )}

      {enableLegacyAgentIntegration && section === "instructions" && (
        <ProjectOwnerBlock name={projectName} icon={activeRootIcon}>
          <SpaceInstructionsSection
            agentsMdContent={agentSettings.agentsMdContent}
            enabledClis={agentSettings.enabledClis}
            onOpenAgentsMd={handleOpenAgentsMd}
          />
        </ProjectOwnerBlock>
      )}
    </>
  );
}
