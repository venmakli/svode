import {
  useEffect,
  useState,
  type ComponentType,
  type MouseEvent,
} from "react";
import * as m from "@/paraglide/messages.js";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarGroupContent,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
} from "@/components/ui/sidebar";
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@/components/ui/breadcrumb";
import {
  Activity,
  Bot,
  FileText,
  Folder,
  GitBranch,
  HardDrive,
  Settings,
} from "lucide-react";
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
import { useOpenEntryDocument } from "@/features/entry/selection";
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

interface SpaceSettingsDialogProps {
  open: boolean;
  spacePath: string | null;
  enableLegacyAgentIntegration: boolean;
  onOpenChange: (open: boolean) => void;
}

type Section =
  | ProjectSpaceDetailSection
  | "spaces"
  | "ai-agent"
  | "health"
  | "defaults"
  | "instructions";

export function SpaceSettingsDialog({
  open,
  spacePath: inputPath,
  enableLegacyAgentIntegration,
  onOpenChange,
}: SpaceSettingsDialogProps) {
  const openDocument = useOpenEntryDocument();
  const { activeRootId, activeRootPath, activeRootName, spaces } = useSpace();

  const projectPath = activeRootPath ?? inputPath ?? "";
  const [section, setSection] = useState<Section>("general");
  const [createSpaceOpen, setCreateSpaceOpen] = useState(false);
  const [detailSpaceId, setDetailSpaceId] = useState<string | null>(null);
  const detailSpace = detailSpaceId
    ? (spaces.find((space) => space.id === detailSpaceId) ?? null)
    : null;
  const spacePath = detailSpace?.path ?? projectPath;
  const isRoot = detailSpace === null;
  const hasSpaces = spaces.length > 0;
  const currentSpaceId: string | null = detailSpace?.id ?? null;
  const projectName = activeRootName || "Project";

  const { saveConfig, saveGitConfig } = useSpaceSettingsConfigActions({
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
    saveGitConfig,
  });
  const identitySettings = useSpaceSettingsIdentity({
    open,
    spacePath,
    isRoot,
  });
  const storageSettings = useSpaceStorageSettings({
    open,
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

  useEffect(() => {
    if (!open || !projectPath) return;
    const resetSection = window.setTimeout(() => {
      setSection("general");
      setDetailSpaceId(null);
    }, 0);
    return () => window.clearTimeout(resetSection);
  }, [open, projectPath]);

  function handleOpenAgentsMd() {
    onOpenChange(false);
    openDocument(".svode/AGENTS.md", activeRootId ?? undefined);
  }

  function handleSectionChange(nextSection: Section) {
    setSection(nextSection);
    setDetailSpaceId(null);
  }

  function handleOpenSpaceDetail(
    spaceId: string,
    nextSection: ProjectSpaceDetailSection,
  ) {
    setDetailSpaceId(spaceId);
    setSection(nextSection === "general" ? "spaces" : nextSection);
  }

  function handleReturnToProjectSection(event: MouseEvent) {
    event.preventDefault();
    setDetailSpaceId(null);
  }

  const navItems: {
    key: Section;
    label: string;
    icon: ComponentType<{ className?: string }>;
    show: boolean;
  }[] = [
    { key: "general", label: m.settings_general(), icon: Settings, show: true },
    { key: "spaces", label: m.settings_spaces(), icon: Folder, show: true },
    {
      key: "ai-agent",
      label: m.settings_ai_agent(),
      icon: Bot,
      show: enableLegacyAgentIntegration,
    },
    { key: "git", label: m.git_section(), icon: GitBranch, show: true },
    { key: "storage", label: m.storage_section(), icon: HardDrive, show: true },
    { key: "health", label: m.settings_health(), icon: Activity, show: true },
    {
      key: "defaults",
      label: m.settings_defaults(),
      icon: Settings,
      show: enableLegacyAgentIntegration && hasSpaces,
    },
    {
      key: "instructions",
      label: m.settings_instructions(),
      icon: FileText,
      show: enableLegacyAgentIntegration,
    },
  ];

  const visibleNav = navItems.filter((item) => item.show);
  const currentNav =
    visibleNav.find((item) => item.key === section) ?? visibleNav[0];

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="overflow-hidden p-0 md:max-h-[500px] md:max-w-[700px] lg:max-w-[800px]">
        <DialogTitle className="sr-only">
          {m.sidebar_project_settings()}
        </DialogTitle>
        <DialogDescription className="sr-only">
          {m.sidebar_project_settings()}
        </DialogDescription>
        <SidebarProvider className="items-start">
          <Sidebar collapsible="none" className="hidden md:flex">
            <SidebarContent>
              <SidebarGroup>
                <SidebarGroupContent>
                  <SidebarMenu>
                    {visibleNav.map((item) => (
                      <SidebarMenuItem key={item.key}>
                        <SidebarMenuButton
                          isActive={section === item.key}
                          onClick={() => handleSectionChange(item.key)}
                        >
                          <item.icon />
                          <span>{item.label}</span>
                        </SidebarMenuButton>
                      </SidebarMenuItem>
                    ))}
                  </SidebarMenu>
                </SidebarGroupContent>
              </SidebarGroup>
            </SidebarContent>
          </Sidebar>
          <main className="flex h-[480px] flex-1 flex-col overflow-hidden">
            <header className="flex h-12 shrink-0 items-center gap-2 border-b">
              <div className="flex items-center gap-2 px-4">
                <Breadcrumb>
                  <BreadcrumbList>
                    <BreadcrumbItem className="hidden md:block">
                      <BreadcrumbLink
                        href="#"
                        onClick={handleReturnToProjectSection}
                      >
                        {m.settings_space_title({
                          name: projectName,
                        })}
                      </BreadcrumbLink>
                    </BreadcrumbItem>
                    <BreadcrumbSeparator className="hidden md:block" />
                    <BreadcrumbItem>
                      {detailSpace ? (
                        <BreadcrumbLink
                          href="#"
                          onClick={handleReturnToProjectSection}
                        >
                          {currentNav.label}
                        </BreadcrumbLink>
                      ) : (
                        <BreadcrumbPage>{currentNav.label}</BreadcrumbPage>
                      )}
                    </BreadcrumbItem>
                    {detailSpace && (
                      <>
                        <BreadcrumbSeparator />
                        <BreadcrumbItem>
                          <BreadcrumbPage>{detailSpace.name}</BreadcrumbPage>
                        </BreadcrumbItem>
                      </>
                    )}
                  </BreadcrumbList>
                </Breadcrumb>
              </div>
            </header>
            <div className="flex flex-1 flex-col gap-4 overflow-y-auto p-4">
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

              {section === "git" && (
                <div className="flex flex-col gap-6">
                  <SpaceGitSection
                    gitType={gitSettings.gitType}
                    activeRootName={activeRootName}
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
                    onSaveIdentity={identitySettings.handleSaveIdentity}
                    onFanoutEnabledChange={identitySettings.setFanoutEnabled}
                    onFanoutSelectedChange={identitySettings.setFanoutSelected}
                  />
                  {isRoot && (
                    <ProjectSpacePolicyList
                      spaces={spaces}
                      gitTypes={projectSpaceGitTypes}
                      section="git"
                      onOpenSpaceDetail={handleOpenSpaceDetail}
                    />
                  )}
                </div>
              )}

              {section === "storage" && (
                <div className="flex flex-col gap-6">
                  <StorageSettingsSection
                    gitType={gitSettings.gitType}
                    activeRootName={activeRootName}
                    settings={storageSettings}
                  />
                  {isRoot && (
                    <ProjectSpacePolicyList
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
        </SidebarProvider>
      </DialogContent>
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
    </Dialog>
  );
}
