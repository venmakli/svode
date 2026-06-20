import { useState, useEffect, useCallback } from "react";
import { toast } from "sonner";
import { ENABLE_LEGACY_AGENT_INTEGRATION } from "@/app/config/feature-flags";
import * as m from "@/paraglide/messages.js";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog";
// AlertDialog removed — auto-save, no unsaved dialog needed
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
import { useEntrySelectionStore } from "@/features/entry";
import { useSpaceStore } from "@/features/space";
import { useChatStatusStore, type ModelOption } from "@/features/chat";
import { useIdentityStore } from "@/features/identity";
import { isValidEmail, isValidName } from "@/features/identity";
import type {
  RepoIdentityResult,
  FanoutPreviewEntry,
} from "@/features/identity";
import { SpaceAgentSection } from "./space-agent-section";
import { SpaceDefaultsSection } from "./space-defaults-section";
import { SpaceGeneralSection } from "./space-general-section";
import { SpaceGitSection } from "./space-git-section";
import { SpaceHealthSection } from "./space-health-section";
import { SpaceInstructionsSection } from "./space-instructions-section";
import {
  StorageSettingsSection,
  StorageStrategyConfirmDialog,
} from "./storage-section";
import {
  checkSymlinkHealth,
  countBrokenLinks,
  getGitSubmoduleUrl,
  getProjectFanoutPreview,
  getRepoIdentity,
  getSettingsGitRemote,
  getSettingsGitStatus,
  getSettingsSpaceConfig,
  getSpaceGitType,
  listAgentModels,
  listAvailableAgents,
  listenGitCommitted,
  readAgentsMd,
  saveSettingsSpaceConfig,
  setGitRemote,
  saveProjectIdentity,
  saveRepoIdentity,
  setupCliSymlinks,
  teardownCliSymlinks,
} from "../api";
import type { AgentConfig, SpaceConfig } from "@/features/space";
import { useSpaceStorageSettings } from "../hooks/use-space-storage-settings";
import type { AvailableAgent, SymlinkHealthReport } from "../model";

interface SpaceSettingsDialogProps {
  open: boolean;
  spacePath: string | null;
  onOpenChange: (open: boolean) => void;
}

type Section =
  | "general"
  | "ai-agent"
  | "git"
  | "storage"
  | "health"
  | "defaults"
  | "instructions";

export function SpaceSettingsDialog({
  open,
  spacePath: inputPath,
  onOpenChange,
}: SpaceSettingsDialogProps) {
  const openDocument = useEntrySelectionStore((state) => state.openDocument);
  const { activeRootId, activeRootPath, activeRootName, spaces } =
    useSpaceStore();

  const spacePath = inputPath ?? "";
  const isRoot = spacePath === activeRootPath;
  const hasSpaces = isRoot && spaces.length > 0;
  // Storage operations key off (projectPath, spaceId); null spaceId means the
  // project root. We always pass `activeRootPath` as the project, matching the
  // per-pool resolver in Ф.5.
  const currentSpaceId: string | null = isRoot
    ? null
    : (spaces.find((s) => s.path === spacePath)?.id ?? null);
  const projectPath = activeRootPath ?? "";

  const [section, setSection] = useState<Section>("general");

  // General
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [icon, setIcon] = useState("");
  const [savedName, setSavedName] = useState("");
  const [savedDescription, setSavedDescription] = useState("");

  // AI Agent
  const [agents, setAgents] = useState<AvailableAgent[]>([]);
  const [enabledClis, setEnabledClis] = useState<string[]>([]);
  const [defaultModel, setDefaultModel] = useState("sonnet");
  const [systemPrompt, setSystemPrompt] = useState("");
  const [availableModels, setAvailableModels] = useState<ModelOption[]>([]);
  const [healthReport, setHealthReport] = useState<SymlinkHealthReport | null>(
    null,
  );
  const [refreshing, setRefreshing] = useState(false);

  // Defaults
  const [defaultsModel, setDefaultsModel] = useState("");
  const [defaultsPrompt, setDefaultsPrompt] = useState("");
  const [_savedDefaultsModel, setSavedDefaultsModel] = useState("");
  const [savedDefaultsPrompt, setSavedDefaultsPrompt] = useState("");

  // AGENTS.md
  const [agentsMdContent, setAgentsMdContent] = useState<string | null>(null);

  const [savedSystemPrompt, setSavedSystemPrompt] = useState("");

  // Git section
  const [gitType, setGitType] = useState<
    "inline" | "independent" | "submodule" | null
  >(null);
  const [submoduleUrl, setSubmoduleUrl] = useState<string | null>(null);
  const [remoteUrl, setRemoteUrl] = useState("");
  const [savedRemoteUrl, setSavedRemoteUrl] = useState("");
  const [branch, setBranch] = useState<string | null>(null);
  const [autoSync, setAutoSync] = useState(false);
  const [autoCommitStructural, setAutoCommitStructural] = useState(false);
  const [autoCommitSystem, setAutoCommitSystem] = useState(false);
  const [pendingRemote, setPendingRemote] = useState<string | null>(null);

  // Identity override
  const bumpIdentityVersion = useIdentityStore((s) => s.bumpRefreshVersion);
  const [repoIdentity, setRepoIdentity] = useState<RepoIdentityResult | null>(
    null,
  );
  const [identityName, setIdentityName] = useState("");
  const [identityEmail, setIdentityEmail] = useState("");
  const [savingIdentity, setSavingIdentity] = useState(false);
  const [identityFormError, setIdentityFormError] = useState<string | null>(
    null,
  );
  const [fanoutEnabled, setFanoutEnabled] = useState(true);
  const [fanoutPreview, setFanoutPreview] = useState<FanoutPreviewEntry[]>([]);
  const [fanoutSelected, setFanoutSelected] = useState<Record<string, boolean>>(
    {},
  );

  const storageSettings = useSpaceStorageSettings({
    open,
    spacePath,
    projectPath,
    currentSpaceId,
    isRoot,
    spaces,
  });

  const [brokenLinksCount, setBrokenLinksCount] = useState<number | null>(null);
  const [linkHealthLoading, setLinkHealthLoading] = useState(false);

  const loadConfig = useCallback(async () => {
    if (!spacePath) return;
    try {
      const cfg = await getSettingsSpaceConfig(spacePath);
      setName(cfg.name);
      setDescription(cfg.description);
      setIcon(cfg.icon);
      setSavedName(cfg.name);
      setSavedDescription(cfg.description);
      setEnabledClis(cfg.agent?.clis ?? []);
      setDefaultModel(cfg.agent?.defaultModel ?? "sonnet");
      setSystemPrompt(cfg.agent?.systemPrompt ?? "");
      setSavedSystemPrompt(cfg.agent?.systemPrompt ?? "");
      if (cfg.defaults?.agent) {
        setDefaultsModel(cfg.defaults.agent.defaultModel ?? "");
        setDefaultsPrompt(cfg.defaults.agent.systemPrompt ?? "");
        setSavedDefaultsModel(cfg.defaults.agent.defaultModel ?? "");
        setSavedDefaultsPrompt(cfg.defaults.agent.systemPrompt ?? "");
      }
      setAutoSync(cfg.git?.autoSync === true);
      setAutoCommitStructural(cfg.git?.autoCommitStructural === true);
      setAutoCommitSystem(cfg.git?.autoCommitSystem === true);
    } catch (err) {
      console.error("Failed to load workspace config:", err);
    }
  }, [spacePath]);

  const loadGitInfo = useCallback(async () => {
    if (!spacePath) return;
    // Reset so stale values from a previous space don't linger while we
    // re-fetch (important right after a clone — status/remote may have
    // just materialized).
    setRemoteUrl("");
    setSavedRemoteUrl("");
    setBranch(null);
    setSubmoduleUrl(null);
    // Detect git type for non-root spaces
    if (!isRoot && activeRootPath) {
      try {
        const t = await getSpaceGitType({
          projectPath: activeRootPath,
          spacePath,
        });
        setGitType(t);
        if (t === "submodule") {
          const folder = spacePath.split("/").pop() ?? "";
          const url = await getGitSubmoduleUrl({
            projectPath: activeRootPath,
            spaceFolder: folder,
          });
          setSubmoduleUrl(url);
        }
      } catch {
        setGitType(null);
      }
    } else {
      setGitType(null);
    }
    try {
      const remote = await getSettingsGitRemote(spacePath);
      setRemoteUrl(remote ?? "");
      setSavedRemoteUrl(remote ?? "");
    } catch {
      setRemoteUrl("");
      setSavedRemoteUrl("");
    }
    try {
      const status = await getSettingsGitStatus(spacePath);
      setBranch(
        status.branch && status.branch !== "HEAD" ? status.branch : null,
      );
    } catch {
      setBranch(null);
    }
  }, [spacePath, isRoot, activeRootPath]);

  const loadIdentity = useCallback(async () => {
    if (!spacePath) return;
    try {
      const result = await getRepoIdentity(spacePath);
      setRepoIdentity(result);
      setIdentityName(result.local?.name ?? "");
      setIdentityEmail(result.local?.email ?? "");
      setIdentityFormError(null);
    } catch (err) {
      console.warn("get_repo_identity failed:", err);
      setRepoIdentity(null);
    }
  }, [spacePath]);

  const loadFanoutPreview = useCallback(async () => {
    if (!isRoot || !spacePath) {
      setFanoutPreview([]);
      setFanoutSelected({});
      return;
    }
    try {
      const list = await getProjectFanoutPreview(spacePath);
      setFanoutPreview(list);
      const initial: Record<string, boolean> = {};
      for (const e of list) initial[e.spacePath] = true;
      setFanoutSelected(initial);
    } catch (err) {
      console.warn("get_project_fanout_preview failed:", err);
      setFanoutPreview([]);
      setFanoutSelected({});
    }
  }, [isRoot, spacePath]);

  const loadModels = useCallback(async () => {
    if (!spacePath) return;
    try {
      const models = await listAgentModels(spacePath);
      setAvailableModels(models);
    } catch {
      setAvailableModels([]);
    }
  }, [spacePath]);

  const loadAgents = useCallback(async () => {
    try {
      const list = await listAvailableAgents();
      setAgents(list);
    } catch (err) {
      console.error("Failed to load agents:", err);
    }
  }, []);

  const loadAgentsMd = useCallback(async () => {
    if (!spacePath) return;
    try {
      const content = await readAgentsMd(spacePath);
      setAgentsMdContent(content);
    } catch {
      setAgentsMdContent(null);
    }
  }, [spacePath]);

  const checkHealth = useCallback(async () => {
    if (!spacePath) return;
    for (const cli of enabledClis) {
      try {
        const report = await checkSymlinkHealth(spacePath, cli);
        setHealthReport(report);
      } catch {
        /* ignore */
      }
    }
  }, [spacePath, enabledClis]);

  const loadLinkHealth = useCallback(async () => {
    if (!activeRootPath || !isRoot) return;
    setLinkHealthLoading(true);
    try {
      const count = await countBrokenLinks(activeRootPath);
      setBrokenLinksCount(count);
    } catch (err) {
      console.warn("count_broken_links failed:", err);
      setBrokenLinksCount(null);
    } finally {
      setLinkHealthLoading(false);
    }
  }, [activeRootPath, isRoot]);

  useEffect(() => {
    if (open && spacePath) {
      loadConfig();
      if (ENABLE_LEGACY_AGENT_INTEGRATION) {
        loadAgents();
        loadModels();
        loadAgentsMd();
      }
      loadGitInfo();
      loadIdentity();
      loadFanoutPreview();
      setSection("general");
      setFanoutEnabled(true);
    }
  }, [
    open,
    spacePath,
    loadConfig,
    loadAgents,
    loadModels,
    loadAgentsMd,
    loadGitInfo,
    loadIdentity,
    loadFanoutPreview,
  ]);

  useEffect(() => {
    if (ENABLE_LEGACY_AGENT_INTEGRATION && open && enabledClis.length > 0) {
      checkHealth();
    }
  }, [open, enabledClis, checkHealth]);

  useEffect(() => {
    if (open && section === "health") loadLinkHealth();
  }, [open, section, loadLinkHealth]);

  // Refresh git info when an autocommit lands on this space (e.g. the
  // scaffold commit that lands immediately after a clone).
  useEffect(() => {
    if (!open || !spacePath) return;
    let unlisten: (() => void) | null = null;
    let cancelled = false;
    listenGitCommitted((event) => {
      if (cancelled) return;
      if (event.payload.spacePath !== spacePath) return;
      loadGitInfo();
    }).then((u) => {
      if (cancelled) u();
      else unlisten = u;
    });
    return () => {
      cancelled = true;
      if (unlisten) unlisten();
    };
  }, [open, spacePath, loadGitInfo]);

  async function saveConfig(updates: Partial<SpaceConfig>) {
    if (!spacePath) return false;
    try {
      const cfg = await getSettingsSpaceConfig(spacePath);
      await saveSettingsSpaceConfig({
        spacePath,
        configData: { ...cfg, ...updates },
        projectPath: activeRootPath,
      });
      return true;
    } catch (err) {
      console.error("Failed to save workspace config:", err);
      toast.error(m.toast_error());
      return false;
    }
  }

  async function saveGitConfig(updates: NonNullable<SpaceConfig["git"]>) {
    if (!spacePath) return false;
    try {
      const cfg = await getSettingsSpaceConfig(spacePath);
      await saveSettingsSpaceConfig({
        spacePath,
        configData: { ...cfg, git: { ...cfg.git, ...updates } },
        projectPath: activeRootPath,
      });
      return true;
    } catch (err) {
      console.error("Failed to save git config:", err);
      toast.error(m.toast_error());
      return false;
    }
  }

  function syncSpaceStore(updates: {
    name?: string;
    icon?: string;
    description?: string;
  }) {
    if (isRoot) {
      useSpaceStore.setState({
        ...(updates.name !== undefined ? { activeRootName: updates.name } : {}),
        ...(updates.icon !== undefined ? { activeRootIcon: updates.icon } : {}),
        rootSpaces: useSpaceStore
          .getState()
          .rootSpaces.map((w) =>
            w.path === spacePath ? { ...w, ...updates } : w,
          ),
      });
    } else {
      useSpaceStore.setState({
        spaces: useSpaceStore
          .getState()
          .spaces.map((w) => (w.path === spacePath ? { ...w, ...updates } : w)),
      });
    }
  }

  async function handleNameBlur() {
    const trimmed = name.trim();
    if (trimmed && trimmed !== savedName) {
      const ok = await saveConfig({ name: trimmed });
      if (ok) {
        setSavedName(trimmed);
        setName(trimmed);
        syncSpaceStore({ name: trimmed });
      }
    }
  }

  async function handleDescriptionBlur() {
    const trimmed = description.trim();
    if (trimmed !== savedDescription) {
      const ok = await saveConfig({ description: trimmed });
      if (ok) {
        setSavedDescription(trimmed);
        setDescription(trimmed);
        syncSpaceStore({ description: trimmed });
      }
    }
  }

  async function handleIconChange(newIcon: string) {
    setIcon(newIcon);
    await saveConfig({ icon: newIcon });
    syncSpaceStore({ icon: newIcon });
  }

  async function handleDefaultModelChange(modelId: string) {
    setDefaultModel(modelId);
    try {
      const cfg = await getSettingsSpaceConfig(spacePath);
      await saveConfig({ agent: { ...cfg.agent, defaultModel: modelId } });
      useChatStatusStore.getState().applyDefaultModel(modelId);
      toast.success(m.toast_settings_saved());
    } catch (err) {
      console.error("Failed to save default model:", err);
      toast.error(m.toast_error());
    }
  }

  async function handleSystemPromptBlur() {
    if (systemPrompt === savedSystemPrompt) return;
    try {
      const cfg = await getSettingsSpaceConfig(spacePath);
      await saveConfig({
        agent: { ...cfg.agent, systemPrompt: systemPrompt || undefined },
      });
      setSavedSystemPrompt(systemPrompt);
    } catch (err) {
      console.error("Failed to save system prompt:", err);
      toast.error(m.toast_error());
    }
  }

  async function handleCliToggle(cliName: string, enabled: boolean) {
    const newClis = enabled
      ? [...enabledClis, cliName]
      : enabledClis.filter((c) => c !== cliName);
    setEnabledClis(newClis);
    try {
      if (enabled) {
        await setupCliSymlinks({
          spacePath,
          cliName,
          projectPath: activeRootPath,
        });
      } else {
        await teardownCliSymlinks({
          spacePath,
          cliName,
          projectPath: activeRootPath,
        });
      }
      await saveConfig({ agent: { clis: newClis } });
      toast.success(m.toast_settings_saved());
    } catch (err) {
      console.error("Failed to toggle CLI:", err);
      toast.error(m.toast_error());
      setEnabledClis(enabled ? enabledClis : [...enabledClis, cliName]);
    }
  }

  async function saveDefaults(model: string, prompt: string) {
    try {
      await saveConfig({
        defaults: {
          agent: {
            defaultModel: model || undefined,
            systemPrompt: prompt || undefined,
          } as AgentConfig,
        },
      });
    } catch (err) {
      console.error("Failed to save defaults:", err);
      toast.error(m.toast_error());
    }
  }

  async function handleDefaultsModelChange(modelId: string) {
    setDefaultsModel(modelId);
    setSavedDefaultsModel(modelId);
    await saveDefaults(modelId, defaultsPrompt);
  }

  async function handleDefaultsPromptBlur() {
    if (defaultsPrompt === savedDefaultsPrompt) return;
    setSavedDefaultsPrompt(defaultsPrompt);
    await saveDefaults(defaultsModel, defaultsPrompt);
  }

  async function handleRefresh() {
    setRefreshing(true);
    await loadAgents();
    await checkHealth();
    setRefreshing(false);
  }

  async function applyRemote(newUrl: string) {
    try {
      const spaceWs = spaces.find((s) => s.path === spacePath);
      await setGitRemote({
        spacePath,
        url: newUrl,
        projectPath: activeRootPath ?? null,
        spaceId: spaceWs?.id ?? null,
      });
      setSavedRemoteUrl(newUrl);
      setRemoteUrl(newUrl);
      toast.success(m.toast_settings_saved());
    } catch (err) {
      console.error("Failed to set remote:", err);
      toast.error(m.toast_error());
      setRemoteUrl(savedRemoteUrl);
    }
  }

  function handleRemoteBlur() {
    const next = remoteUrl.trim();
    if (next === savedRemoteUrl) return;
    if (next === "") {
      // Empty value — apply silently (clear remote intentionally requires
      // a separate UI; we just no-op for now).
      setRemoteUrl(savedRemoteUrl);
      return;
    }
    setPendingRemote(next);
  }

  async function handleAutoSyncChange(value: boolean) {
    setAutoSync(value);
    await saveGitConfig({ autoSync: value });
  }

  async function handleAutoCommitStructuralChange(value: boolean) {
    setAutoCommitStructural(value);
    await saveGitConfig({ autoCommitStructural: value });
  }

  async function handleAutoCommitSystemChange(value: boolean) {
    setAutoCommitSystem(value);
    await saveGitConfig({ autoCommitSystem: value });
  }

  async function handleSaveIdentity() {
    if (!spacePath) return;
    const trimmedName = identityName.trim();
    const trimmedEmail = identityEmail.trim();
    const bothEmpty = !trimmedName && !trimmedEmail;
    const bothFilled = trimmedName && trimmedEmail;
    if (!bothEmpty && !bothFilled) {
      setIdentityFormError(m.settings_git_identity_both_required());
      return;
    }
    if (
      bothFilled &&
      (!isValidName(trimmedName) || !isValidEmail(trimmedEmail))
    ) {
      setIdentityFormError(
        !isValidName(trimmedName)
          ? m.identity_name_empty()
          : m.identity_email_invalid(),
      );
      return;
    }
    setIdentityFormError(null);
    setSavingIdentity(true);
    try {
      if (isRoot) {
        const targets = fanoutEnabled
          ? fanoutPreview
              .filter((e) => fanoutSelected[e.spacePath])
              .map((e) => e.spacePath)
          : [];
        await saveProjectIdentity({
          rootPath: spacePath,
          name: bothFilled ? trimmedName : null,
          email: bothFilled ? trimmedEmail : null,
          targetSpaces: targets,
        });
      } else {
        await saveRepoIdentity({
          repoPath: spacePath,
          name: bothFilled ? trimmedName : null,
          email: bothFilled ? trimmedEmail : null,
        });
      }
      await loadIdentity();
      await loadFanoutPreview();
      bumpIdentityVersion();
      toast.success(m.toast_settings_saved());
    } catch (err) {
      console.error("identity save failed:", err);
      toast.error(m.toast_error());
    } finally {
      setSavingIdentity(false);
    }
  }

  function handleOpenAgentsMd() {
    onOpenChange(false);
    openDocument(".svode/AGENTS.md", activeRootId ?? undefined);
  }

  const navItems: {
    key: Section;
    label: string;
    icon: React.FC<{ className?: string }>;
    show: boolean;
  }[] = [
    { key: "general", label: m.settings_general(), icon: Settings, show: true },
    {
      key: "ai-agent",
      label: m.settings_ai_agent(),
      icon: Bot,
      show: ENABLE_LEGACY_AGENT_INTEGRATION,
    },
    { key: "git", label: m.git_section(), icon: GitBranch, show: true },
    { key: "storage", label: m.storage_section(), icon: HardDrive, show: true },
    { key: "health", label: m.settings_health(), icon: Activity, show: isRoot },
    {
      key: "defaults",
      label: m.settings_defaults(),
      icon: Settings,
      show: ENABLE_LEGACY_AGENT_INTEGRATION && hasSpaces,
    },
    {
      key: "instructions",
      label: m.settings_instructions(),
      icon: FileText,
      show: ENABLE_LEGACY_AGENT_INTEGRATION,
    },
  ];

  const visibleNav = navItems.filter((i) => i.show);
  const currentNav = visibleNav.find((i) => i.key === section) ?? visibleNav[0];

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="overflow-hidden p-0 md:max-h-[500px] md:max-w-[700px] lg:max-w-[800px]">
        <DialogTitle className="sr-only">
          {m.settings_space_title({ name: name || "" })}
        </DialogTitle>
        <DialogDescription className="sr-only">
          {m.settings_space_title({ name: name || "" })}
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
                          onClick={() => setSection(item.key)}
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
                        onClick={(e) => e.preventDefault()}
                      >
                        {m.settings_space_title({ name: name || "" })}
                      </BreadcrumbLink>
                    </BreadcrumbItem>
                    <BreadcrumbSeparator className="hidden md:block" />
                    <BreadcrumbItem>
                      <BreadcrumbPage>{currentNav.label}</BreadcrumbPage>
                    </BreadcrumbItem>
                  </BreadcrumbList>
                </Breadcrumb>
              </div>
            </header>
            <div className="flex flex-1 flex-col gap-4 overflow-y-auto p-4">
              {section === "general" && (
                <SpaceGeneralSection
                  icon={icon}
                  name={name}
                  description={description}
                  onIconChange={handleIconChange}
                  onNameChange={setName}
                  onNameBlur={handleNameBlur}
                  onDescriptionChange={setDescription}
                  onDescriptionBlur={handleDescriptionBlur}
                />
              )}

              {ENABLE_LEGACY_AGENT_INTEGRATION && section === "ai-agent" && (
                <SpaceAgentSection
                  agents={agents}
                  enabledClis={enabledClis}
                  defaultModel={defaultModel}
                  systemPrompt={systemPrompt}
                  availableModels={availableModels}
                  healthReport={healthReport}
                  refreshing={refreshing}
                  onDefaultModelChange={handleDefaultModelChange}
                  onSystemPromptChange={setSystemPrompt}
                  onSystemPromptBlur={handleSystemPromptBlur}
                  onCliToggle={handleCliToggle}
                  onRefresh={handleRefresh}
                />
              )}

              {section === "git" && (
                <SpaceGitSection
                  gitType={gitType}
                  activeRootName={activeRootName}
                  isRoot={isRoot}
                  submoduleUrl={submoduleUrl}
                  remoteUrl={remoteUrl}
                  branch={branch}
                  autoSync={autoSync}
                  autoCommitStructural={autoCommitStructural}
                  autoCommitSystem={autoCommitSystem}
                  repoIdentity={repoIdentity}
                  identityName={identityName}
                  identityEmail={identityEmail}
                  identityFormError={identityFormError}
                  savingIdentity={savingIdentity}
                  fanoutEnabled={fanoutEnabled}
                  fanoutPreview={fanoutPreview}
                  fanoutSelected={fanoutSelected}
                  onRemoteChange={setRemoteUrl}
                  onRemoteBlur={handleRemoteBlur}
                  onAutoSyncChange={handleAutoSyncChange}
                  onAutoCommitStructuralChange={
                    handleAutoCommitStructuralChange
                  }
                  onAutoCommitSystemChange={handleAutoCommitSystemChange}
                  onIdentityNameChange={setIdentityName}
                  onIdentityEmailChange={setIdentityEmail}
                  onSaveIdentity={handleSaveIdentity}
                  onFanoutEnabledChange={setFanoutEnabled}
                  onFanoutSelectedChange={setFanoutSelected}
                />
              )}

              {section === "storage" && (
                <StorageSettingsSection
                  gitType={gitType}
                  activeRootName={activeRootName}
                  settings={storageSettings}
                />
              )}

              {section === "health" && isRoot && (
                <SpaceHealthSection
                  brokenLinksCount={brokenLinksCount}
                  loading={linkHealthLoading}
                  onRefresh={loadLinkHealth}
                />
              )}

              {ENABLE_LEGACY_AGENT_INTEGRATION &&
                section === "defaults" &&
                hasSpaces && (
                  <SpaceDefaultsSection
                    model={defaultsModel}
                    prompt={defaultsPrompt}
                    availableModels={availableModels}
                    onModelChange={handleDefaultsModelChange}
                    onPromptChange={setDefaultsPrompt}
                    onPromptBlur={handleDefaultsPromptBlur}
                  />
                )}

              {ENABLE_LEGACY_AGENT_INTEGRATION &&
                section === "instructions" && (
                  <SpaceInstructionsSection
                    agentsMdContent={agentsMdContent}
                    enabledClis={enabledClis}
                    onOpenAgentsMd={handleOpenAgentsMd}
                  />
                )}
            </div>
          </main>
        </SidebarProvider>
      </DialogContent>
      <AlertDialog
        open={pendingRemote !== null}
        onOpenChange={(open) => {
          if (!open) {
            setPendingRemote(null);
            setRemoteUrl(savedRemoteUrl);
          }
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{m.git_remote_confirm_title()}</AlertDialogTitle>
            <AlertDialogDescription>
              {m.git_remote_confirm_description({ url: pendingRemote ?? "" })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel
              onClick={() => {
                setPendingRemote(null);
                setRemoteUrl(savedRemoteUrl);
              }}
            >
              {m.project_cancel()}
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={async () => {
                const target = pendingRemote;
                setPendingRemote(null);
                if (target) await applyRemote(target);
              }}
            >
              {m.git_remote_confirm_action()}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <StorageStrategyConfirmDialog settings={storageSettings} />
    </Dialog>
  );
}
