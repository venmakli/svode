import { Button } from "@/components/ui/button";
import { AppVariablesSection } from "./app-variables-section";
import { useLayoutEffect, useState, type MouseEvent } from "react";
import * as m from "@/paraglide/messages.js";
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@/components/ui/breadcrumb";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { useOpenPage } from "@/features/page/navigation";
import { CreateSpaceDialog, useSpace } from "@/features/space";
import { useSpaceSettingsAgent } from "../hooks/use-space-settings-agent";
import { useSpaceSettingsConfigActions } from "../hooks/use-space-settings-config-actions";
import { useSpaceSettingsDefaults } from "../hooks/use-space-settings-defaults";
import { useSpaceSettingsGeneral } from "../hooks/use-space-settings-general";
import { useSpaceSettingsGit } from "../hooks/use-space-settings-git";
import { useSpaceSettingsHealth } from "../hooks/use-space-settings-health";
import { useSpaceSettingsIdentity } from "../hooks/use-space-settings-identity";
import { useSpaceStorageSettings } from "../hooks/use-space-storage-settings";
import { useProjectSpaceGitTypes } from "../hooks/use-project-space-git-types";
import { SpaceAgentSection } from "./space-agent-section";
import { SpaceDefaultsSection } from "./space-defaults-section";
import { SpaceGeneralSection } from "./space-general-section";
import { IdentitySection } from "./identity-section";
import { SpaceGitSection } from "./space-git-section";
import { SpaceHealthSection } from "./space-health-section";
import { SpaceInstructionsSection } from "./space-instructions-section";
import {
  ProjectSpacePolicyList,
  ProjectSpacesSection,
  type ProjectSpaceDetailSection,
} from "./space-settings-spaces-section";
import {
  StorageSettingsSection,
  StorageStrategyConfirmDialog,
} from "./storage-section";

import type {
  ProjectSettingsSection,
  SettingsDestination,
  SettingsLeaveGuard,
} from "../model/settings-destination";
import { getProjectSettingsNavItems } from "./project-settings-navigation";

export function ProjectSettingsContent({
  spacePath,
  section,
  enableLegacyAgentIntegration,
  onNavigate,
  onClose,
  registerLeaveGuard,
}: {
  spacePath: string;
  section: ProjectSettingsSection;
  enableLegacyAgentIntegration: boolean;
  onNavigate: (destination: SettingsDestination) => void;
  onClose: () => void;
  registerLeaveGuard: (guard: SettingsLeaveGuard) => () => void;
}) {
  const open = true;
  const openPage = useOpenPage();
  const { activeRootId, activeRootPath, activeRootName, spaces } = useSpace();
  const projectPath = activeRootPath!;
  const detailSpace = spaces.find((space) => space.path === spacePath) ?? null;
  const isRoot = spacePath === projectPath;
  const currentSpaceId = detailSpace?.id ?? null;
  const projectName = activeRootName || "Project";
  const hasSpaces = spaces.length > 0;
  const [gitDetail, setGitDetail] = useState<"identity" | null>(null);
  const [createSpaceOpen, setCreateSpaceOpen] = useState(false);

  const { saveConfig } = useSpaceSettingsConfigActions({
    spacePath,
    projectPath: activeRootPath,
  });
  const generalSettings = useSpaceSettingsGeneral({
    open,
    spacePath,
    saveConfig,
  });
  const agentSettings = useSpaceSettingsAgent({
    open,
    enabled: enableLegacyAgentIntegration,
    spacePath,
    projectPath: activeRootPath,
    saveConfig,
  });
  const defaultsSettings = useSpaceSettingsDefaults({
    open,
    enabled: enableLegacyAgentIntegration,
    spacePath,
    saveConfig,
  });
  const gitSettings = useSpaceSettingsGit({
    open,
    spacePath,
    activeRootPath,
    isRoot,
    spaces,
  });
  const identitySettings = useSpaceSettingsIdentity({
    open,
    spacePath,
    isRoot,
  });
  const storageSettings = useSpaceStorageSettings({
    open,
    diagnosticsActive: section === "storage",
    spacePath,
    projectPath,
    currentSpaceId,
    isRoot,
    spaces,
  });
  const healthSettings = useSpaceSettingsHealth({
    open,
    active: section === "health",
    activeRootPath,
    isRoot,
  });
  const projectSpaceGitTypes = useProjectSpaceGitTypes({
    open,
    active: isRoot,
    projectPath,
    spaces,
  });

  useLayoutEffect(
    () =>
      registerLeaveGuard(() => {
        if (storageSettings.applyingStrategy || storageSettings.s3.pending)
          return false;
        if (section === "storage") storageSettings.s3.cancel();
        if (gitDetail === "identity")
          identitySettings.handleCancelIdentityEdit();
        setGitDetail(null);
        return true;
      }),
    [storageSettings, identitySettings, section, gitDetail, registerLeaveGuard],
  );

  function handleOpenAgentsMd() {
    onClose();
    openPage(".svode/AGENTS.md", activeRootId ?? undefined);
  }

  function handleOpenSpaceDetail(
    spaceId: string,
    nextSection: ProjectSpaceDetailSection,
  ) {
    const target = spaces.find((space) => space.id === spaceId);
    if (target)
      onNavigate({
        scope: "project",
        spacePath: target.path,
        section: nextSection === "general" ? "spaces" : nextSection,
      });
  }

  function handleReturnToProjectSection(event: MouseEvent) {
    event.preventDefault();
    onNavigate({ scope: "project", spacePath: projectPath, section });
  }

  function handleReturnToGitDetailParent(event: MouseEvent) {
    event.preventDefault();
    identitySettings.handleCancelIdentityEdit();
    setGitDetail(null);
  }

  function handleOpenIdentityDetail() {
    identitySettings.handleStartIdentityEdit();
    setGitDetail("identity");
  }

  function handleOpenRepositoryRemote() {
    if (gitSettings.gitType === "inline") {
      onNavigate({ scope: "project", spacePath: projectPath, section: "git" });
    }
    window.setTimeout(() => {
      document.getElementById("ws-git-remote")?.focus();
    }, 0);
  }

  function handleCancelIdentityDetail() {
    identitySettings.handleCancelIdentityEdit();
    setGitDetail(null);
  }

  const visibleNav = getProjectSettingsNavItems(
    enableLegacyAgentIntegration,
    hasSpaces,
  );
  const currentNav =
    visibleNav.find((item) => item.key === section) ?? visibleNav[0];
  const isGitIdentityDetail = section === "git" && gitDetail === "identity";

  return (
    <>
      <main className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
        <header className="flex min-h-12 shrink-0 items-center gap-2 border-b pr-10">
          <div className="flex min-w-0 items-center gap-2 px-4 py-2">
            <Breadcrumb className="min-w-0">
              <BreadcrumbList className="min-w-0 flex-nowrap">
                <BreadcrumbItem className="min-w-0">
                  <BreadcrumbLink
                    className="truncate"
                    href="#"
                    onClick={handleReturnToProjectSection}
                  >
                    {m.settings_project_group({
                      name: projectName,
                    })}
                  </BreadcrumbLink>
                </BreadcrumbItem>
                <BreadcrumbSeparator className="min-w-0" />
                <BreadcrumbItem className="min-w-0">
                  {detailSpace || isGitIdentityDetail ? (
                    <BreadcrumbLink
                      className="truncate"
                      href="#"
                      onClick={handleReturnToProjectSection}
                    >
                      {currentNav.label}
                    </BreadcrumbLink>
                  ) : (
                    <BreadcrumbPage className="truncate">
                      {currentNav.label}
                    </BreadcrumbPage>
                  )}
                </BreadcrumbItem>
                {detailSpace && (
                  <>
                    <BreadcrumbSeparator />
                    <BreadcrumbItem className="min-w-0">
                      {isGitIdentityDetail ? (
                        <BreadcrumbLink
                          className="truncate"
                          href="#"
                          onClick={handleReturnToGitDetailParent}
                        >
                          {detailSpace.name}
                        </BreadcrumbLink>
                      ) : (
                        <BreadcrumbPage className="truncate">
                          {detailSpace.name}
                        </BreadcrumbPage>
                      )}
                    </BreadcrumbItem>
                  </>
                )}
                {isGitIdentityDetail && (
                  <>
                    <BreadcrumbSeparator />
                    <BreadcrumbItem className="min-w-0">
                      <BreadcrumbPage className="truncate">
                        {m.settings_git_identity_title()}
                      </BreadcrumbPage>
                    </BreadcrumbItem>
                  </>
                )}
              </BreadcrumbList>
            </Breadcrumb>
          </div>
        </header>
        <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-4 overflow-x-hidden overflow-y-auto p-4">
          {section === "general" && (
            <SpaceGeneralSection
              icon={generalSettings.icon}
              name={generalSettings.name}
              description={generalSettings.description}
              onIconChange={generalSettings.handleIconChange}
              onNameChange={generalSettings.setName}
              onNameBlur={generalSettings.handleNameBlur}
              onDescriptionChange={generalSettings.setDescription}
              onDescriptionBlur={generalSettings.handleDescriptionBlur}
            />
          )}

          {section === "spaces" && detailSpace && (
            <>
              <Button
                variant="outline"
                onClick={() =>
                  onNavigate({
                    scope: "project",
                    spacePath,
                    section: "variables",
                  })
                }
              >
                {m.settings_variables_title()}
              </Button>
              <SpaceGeneralSection
                icon={generalSettings.icon}
                name={generalSettings.name}
                description={generalSettings.description}
                onIconChange={generalSettings.handleIconChange}
                onNameChange={generalSettings.setName}
                onNameBlur={generalSettings.handleNameBlur}
                onDescriptionChange={generalSettings.setDescription}
                onDescriptionBlur={generalSettings.handleDescriptionBlur}
              />
            </>
          )}

          {section === "variables" && (
            <AppVariablesSection
              projectPath={projectPath}
              spaceId={currentSpaceId}
              registerLeaveGuard={registerLeaveGuard}
            />
          )}

          {section === "spaces" && !detailSpace && (
            <ProjectSpacesSection
              spaces={spaces}
              gitTypes={projectSpaceGitTypes}
              onAddSpace={() => setCreateSpaceOpen(true)}
              onOpenSpaceDetail={handleOpenSpaceDetail}
            />
          )}

          {enableLegacyAgentIntegration && section === "ai-agent" && (
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
          )}

          {section === "git" && !isGitIdentityDetail && (
            <div className="flex min-w-0 flex-col gap-6">
              <SpaceGitSection
                gitType={gitSettings.gitType}
                repositoryAccessOwnerKind={
                  isRoot ? "project" : (gitSettings.gitType ?? "independent")
                }
                repositoryPath={
                  gitSettings.gitType === "inline" ? projectPath : spacePath
                }
                repositoryDisplayPath={
                  gitSettings.gitType === "inline" ? projectPath : spacePath
                }
                repositoryOwnerName={
                  gitSettings.gitType === "inline"
                    ? projectName
                    : isRoot
                      ? projectName
                      : (detailSpace?.name ?? projectName)
                }
                activeRootName={activeRootName}
                scopeName={
                  isRoot ? projectName : (detailSpace?.name ?? projectName)
                }
                isRoot={isRoot}
                submoduleUrl={gitSettings.submoduleUrl}
                remoteUrl={gitSettings.remoteUrl}
                branch={gitSettings.branch}
                autoSync={gitSettings.autoSync}
                autoCommitStructural={gitSettings.autoCommitStructural}
                autoCommitSystem={gitSettings.autoCommitSystem}
                repoIdentity={identitySettings.repoIdentity}
                identityName={identitySettings.identityName}
                identityEmail={identitySettings.identityEmail}
                identityFormError={identitySettings.identityFormError}
                savingIdentity={identitySettings.savingIdentity}
                canResetIdentity={identitySettings.canResetIdentity}
                remoteUpdateResult={gitSettings.remoteUpdateResult}
                fanoutEnabled={identitySettings.fanoutEnabled}
                fanoutPreview={identitySettings.fanoutPreview}
                fanoutSelected={identitySettings.fanoutSelected}
                onRemoteChange={gitSettings.setRemoteUrl}
                onRemoteBlur={gitSettings.handleRemoteBlur}
                onAutoSyncChange={gitSettings.handleAutoSyncChange}
                onAutoCommitStructuralChange={
                  gitSettings.handleAutoCommitStructuralChange
                }
                onAutoCommitSystemChange={
                  gitSettings.handleAutoCommitSystemChange
                }
                onIdentityNameChange={identitySettings.setIdentityName}
                onIdentityEmailChange={identitySettings.setIdentityEmail}
                onStartIdentityEdit={handleOpenIdentityDetail}
                onCancelIdentityEdit={identitySettings.handleCancelIdentityEdit}
                onSaveIdentity={identitySettings.handleSaveIdentity}
                onResetIdentity={identitySettings.handleResetIdentity}
                onFanoutEnabledChange={identitySettings.setFanoutEnabled}
                onFanoutSelectedChange={identitySettings.setFanoutSelected}
                onEditRemote={handleOpenRepositoryRemote}
              />
              {isRoot && (
                <ProjectSpacePolicyList
                  projectPath={projectPath}
                  spaces={spaces}
                  gitTypes={projectSpaceGitTypes}
                  section="git"
                  onOpenSpaceDetail={handleOpenSpaceDetail}
                />
              )}
            </div>
          )}

          {section === "git" && isGitIdentityDetail && (
            <IdentitySection
              mode="detail"
              isRoot={isRoot}
              scopeName={
                isRoot ? projectName : (detailSpace?.name ?? projectName)
              }
              repoIdentity={identitySettings.repoIdentity}
              identityName={identitySettings.identityName}
              identityEmail={identitySettings.identityEmail}
              setIdentityName={identitySettings.setIdentityName}
              setIdentityEmail={identitySettings.setIdentityEmail}
              identityFormError={identitySettings.identityFormError}
              savingIdentity={identitySettings.savingIdentity}
              canResetIdentity={identitySettings.canResetIdentity}
              onEdit={handleOpenIdentityDetail}
              onCancelEdit={handleCancelIdentityDetail}
              onSave={identitySettings.handleSaveIdentity}
              onReset={identitySettings.handleResetIdentity}
              fanoutEnabled={identitySettings.fanoutEnabled}
              setFanoutEnabled={identitySettings.setFanoutEnabled}
              fanoutPreview={identitySettings.fanoutPreview}
              fanoutSelected={identitySettings.fanoutSelected}
              setFanoutSelected={identitySettings.setFanoutSelected}
            />
          )}

          {section === "storage" && (
            <div className="flex min-w-0 flex-col gap-6">
              <StorageSettingsSection
                gitType={gitSettings.gitType}
                activeRootName={activeRootName}
                settings={storageSettings}
                onOpenRoot={() =>
                  onNavigate({
                    scope: "project",
                    spacePath: projectPath,
                    section: "storage",
                  })
                }
              />
              {isRoot && (
                <ProjectSpacePolicyList
                  projectPath={projectPath}
                  spaces={spaces}
                  gitTypes={projectSpaceGitTypes}
                  section="storage"
                  onOpenSpaceDetail={handleOpenSpaceDetail}
                />
              )}
            </div>
          )}

          {section === "health" && isRoot && (
            <SpaceHealthSection
              brokenLinksCount={healthSettings.brokenLinksCount}
              loading={healthSettings.linkHealthLoading}
              onRefresh={healthSettings.loadLinkHealth}
            />
          )}

          {enableLegacyAgentIntegration &&
            section === "defaults" &&
            hasSpaces && (
              <SpaceDefaultsSection
                model={defaultsSettings.defaultsModel}
                prompt={defaultsSettings.defaultsPrompt}
                availableModels={agentSettings.availableModels}
                onModelChange={defaultsSettings.handleDefaultsModelChange}
                onPromptChange={defaultsSettings.setDefaultsPrompt}
                onPromptBlur={defaultsSettings.handleDefaultsPromptBlur}
              />
            )}

          {enableLegacyAgentIntegration && section === "instructions" && (
            <SpaceInstructionsSection
              agentsMdContent={agentSettings.agentsMdContent}
              enabledClis={agentSettings.enabledClis}
              onOpenAgentsMd={handleOpenAgentsMd}
            />
          )}
        </div>
      </main>
      <AlertDialog
        open={gitSettings.pendingRemote !== null}
        onOpenChange={(nextOpen) => {
          if (!nextOpen) {
            gitSettings.cancelPendingRemote();
          }
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{m.git_remote_confirm_title()}</AlertDialogTitle>
            <AlertDialogDescription>
              {m.git_remote_confirm_description({
                url: gitSettings.pendingRemote ?? "",
              })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel onClick={gitSettings.cancelPendingRemote}>
              {m.project_cancel()}
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={() => void gitSettings.confirmPendingRemote()}
            >
              {m.git_remote_confirm_action()}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <StorageStrategyConfirmDialog settings={storageSettings} />
      <CreateSpaceDialog
        open={createSpaceOpen}
        onOpenChange={setCreateSpaceOpen}
      />
    </>
  );
}
