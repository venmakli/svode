import { useState, useEffect, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import { toast } from "sonner";
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
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Separator } from "@/components/ui/separator";
import { Checkbox } from "@/components/ui/checkbox";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { EmojiPicker } from "@/components/ui/emoji-picker";
import { Bot, ExternalLink, FileText, GitBranch, Pencil, RefreshCw, Settings } from "lucide-react";
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
import { useLayoutStore } from "@/stores/layout";
import { useWorkspaceStore } from "@/stores/workspace";
import { useChatStatusStore, type ModelOption } from "@/stores/chat";
import type {
  WorkspaceConfig,
  AgentConfig,
  AvailableAgent,
  SymlinkHealthReport,
} from "@/types/workspace";

interface WorkspaceSettingsDialogProps {
  open: boolean;
  workspacePath: string | null;
  onOpenChange: (open: boolean) => void;
}

const CLI_AUTH_COMMANDS: Record<string, string> = {
  claude: "claude login",
};

type Section = "general" | "ai-agent" | "git" | "defaults" | "instructions";

export function WorkspaceSettingsDialog({
  open,
  workspacePath: inputPath,
  onOpenChange,
}: WorkspaceSettingsDialogProps) {
  const { openDocument, closeSettings } = useLayoutStore();
  const { activeRootPath, children } = useWorkspaceStore();

  const workspacePath = inputPath ?? "";
  const isRoot = workspacePath === activeRootPath;
  const hasChildren = isRoot && children.length > 0;

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
  const [healthReport, setHealthReport] = useState<SymlinkHealthReport | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  // Defaults
  const [defaultsModel, setDefaultsModel] = useState("");
  const [defaultsPrompt, setDefaultsPrompt] = useState("");
  const [savedDefaultsModel, setSavedDefaultsModel] = useState("");
  const [savedDefaultsPrompt, setSavedDefaultsPrompt] = useState("");

  // AGENTS.md
  const [agentsMdContent, setAgentsMdContent] = useState<string | null>(null);

  const [savedSystemPrompt, setSavedSystemPrompt] = useState("");

  // Git section
  const [remoteUrl, setRemoteUrl] = useState("");
  const [savedRemoteUrl, setSavedRemoteUrl] = useState("");
  const [branch, setBranch] = useState<string | null>(null);
  const [autoSync, setAutoSync] = useState(true);
  const [pendingRemote, setPendingRemote] = useState<string | null>(null);

  const loadConfig = useCallback(async () => {
    if (!workspacePath) return;
    try {
      const cfg = await invoke<WorkspaceConfig>("get_workspace_config", { workspacePath });
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
      setAutoSync(cfg.git?.autoSync !== false);
    } catch (err) {
      console.error("Failed to load workspace config:", err);
    }
  }, [workspacePath]);

  const loadGitInfo = useCallback(async () => {
    if (!workspacePath) return;
    try {
      const remote = await invoke<string | null>("git_get_remote", {
        workspacePath,
      });
      setRemoteUrl(remote ?? "");
      setSavedRemoteUrl(remote ?? "");
    } catch {
      setRemoteUrl("");
      setSavedRemoteUrl("");
    }
    try {
      const status = await invoke<{ branch: string }>("git_status", {
        workspacePath,
      });
      setBranch(status.branch);
    } catch {
      setBranch(null);
    }
  }, [workspacePath]);

  const loadModels = useCallback(async () => {
    if (!workspacePath) return;
    try {
      const models = await invoke<ModelOption[]>("agent_list_models", { workspacePath });
      setAvailableModels(models);
    } catch {
      setAvailableModels([]);
    }
  }, [workspacePath]);

  const loadAgents = useCallback(async () => {
    try {
      const list = await invoke<AvailableAgent[]>("agent_list_available");
      setAgents(list);
    } catch (err) {
      console.error("Failed to load agents:", err);
    }
  }, []);

  const loadAgentsMd = useCallback(async () => {
    if (!workspacePath) return;
    try {
      const content = await invoke<string | null>("read_agents_md", { workspacePath });
      setAgentsMdContent(content);
    } catch {
      setAgentsMdContent(null);
    }
  }, [workspacePath]);

  const checkHealth = useCallback(async () => {
    if (!workspacePath) return;
    for (const cli of enabledClis) {
      try {
        const report = await invoke<SymlinkHealthReport>("check_symlink_health", { workspacePath, cliName: cli });
        setHealthReport(report);
      } catch { /* ignore */ }
    }
  }, [workspacePath, enabledClis]);

  useEffect(() => {
    if (open && workspacePath) {
      loadConfig();
      loadAgents();
      loadModels();
      loadAgentsMd();
      loadGitInfo();
      setSection("general");
    }
  }, [open, workspacePath, loadConfig, loadAgents, loadModels, loadAgentsMd, loadGitInfo]);

  useEffect(() => {
    if (open && enabledClis.length > 0) checkHealth();
  }, [open, enabledClis, checkHealth]);

  async function saveConfig(updates: Partial<WorkspaceConfig>) {
    if (!workspacePath) return false;
    try {
      const cfg = await invoke<WorkspaceConfig>("get_workspace_config", { workspacePath });
      await invoke("save_workspace_config", { workspacePath, configData: { ...cfg, ...updates } });
      return true;
    } catch (err) {
      console.error("Failed to save workspace config:", err);
      toast.error(m.toast_error());
      return false;
    }
  }

  function syncWorkspaceStore(updates: { name?: string; icon?: string; description?: string }) {
    if (isRoot) {
      useWorkspaceStore.setState({
        ...(updates.name !== undefined ? { activeRootName: updates.name } : {}),
        ...(updates.icon !== undefined ? { activeRootIcon: updates.icon } : {}),
        rootWorkspaces: useWorkspaceStore.getState().rootWorkspaces.map((w) =>
          w.path === workspacePath ? { ...w, ...updates } : w
        ),
      });
    } else {
      useWorkspaceStore.setState({
        children: useWorkspaceStore.getState().children.map((w) =>
          w.path === workspacePath ? { ...w, ...updates } : w
        ),
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
        syncWorkspaceStore({ name: trimmed });
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
        syncWorkspaceStore({ description: trimmed });
      }
    }
  }

  async function handleIconChange(newIcon: string) {
    setIcon(newIcon);
    await saveConfig({ icon: newIcon });
    syncWorkspaceStore({ icon: newIcon });
  }

  async function handleDefaultModelChange(modelId: string) {
    setDefaultModel(modelId);
    try {
      const cfg = await invoke<WorkspaceConfig>("get_workspace_config", { workspacePath });
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
      const cfg = await invoke<WorkspaceConfig>("get_workspace_config", { workspacePath });
      await saveConfig({ agent: { ...cfg.agent, systemPrompt: systemPrompt || undefined } });
      setSavedSystemPrompt(systemPrompt);
    } catch (err) {
      console.error("Failed to save system prompt:", err);
      toast.error(m.toast_error());
    }
  }

  async function handleCliToggle(cliName: string, enabled: boolean) {
    const newClis = enabled ? [...enabledClis, cliName] : enabledClis.filter((c) => c !== cliName);
    setEnabledClis(newClis);
    try {
      if (enabled) {
        await invoke<string[]>("setup_cli_symlinks_cmd", { workspacePath, cliName });
      } else {
        await invoke("teardown_cli_symlinks_cmd", { workspacePath, cliName });
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
      await invoke("git_set_remote", { workspacePath, url: newUrl });
      setSavedRemoteUrl(newUrl);
      setRemoteUrl(newUrl);
      toast.success(m.toast_settings_saved());
    } catch (err) {
      console.error("Failed to set remote:", err);
      toast.error(m.toast_error());
      // Roll back UI to previously-saved value
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
    await saveConfig({ git: { autoSync: value } });
  }


  function handleOpenAgentsMd() {
    closeSettings();
    openDocument(".combai/AGENTS.md");
  }

  function getCliStatus(agent: AvailableAgent): "authorized" | "unauthorized" | "not_found" {
    if (agent.authStatus === "not_found") return "not_found";
    if (agent.authStatus === "authorized") return "authorized";
    return "unauthorized";
  }

  const agentsMdLines = agentsMdContent?.split("\n").length ?? 0;

  const navItems: { key: Section; label: string; icon: React.FC<{ className?: string }>; show: boolean }[] = [
    { key: "general", label: m.settings_general(), icon: Settings, show: true },
    { key: "ai-agent", label: m.settings_ai_agent(), icon: Bot, show: true },
    { key: "git", label: m.git_section(), icon: GitBranch, show: true },
    { key: "defaults", label: m.settings_defaults(), icon: Settings, show: hasChildren },
    { key: "instructions", label: m.settings_instructions(), icon: FileText, show: true },
  ];

  const visibleNav = navItems.filter((i) => i.show);
  const currentNav = visibleNav.find((i) => i.key === section) ?? visibleNav[0];

  return (
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="overflow-hidden p-0 md:max-h-[500px] md:max-w-[700px] lg:max-w-[800px]">
          <DialogTitle className="sr-only">
            {m.settings_workspace_title({ name: name || "" })}
          </DialogTitle>
          <DialogDescription className="sr-only">
            {m.settings_workspace_title({ name: name || "" })}
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
                        <BreadcrumbLink href="#" onClick={(e) => e.preventDefault()}>
                          {m.settings_workspace_title({ name: name || "" })}
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
                  <div className="space-y-4 max-w-sm">
                    <div className="space-y-2">
                      <Label htmlFor="ws-settings-name">{m.workspace_name_label()}</Label>
                      <div className="flex gap-2">
                        <EmojiPicker value={icon} onChange={handleIconChange} size="sm" />
                        <Input
                          id="ws-settings-name"
                          value={name}
                          onChange={(e) => setName(e.target.value)}
                          onBlur={handleNameBlur}
                          placeholder={m.workspace_name_placeholder()}
                          className="flex-1"
                        />
                      </div>
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor="ws-settings-desc">{m.workspace_description_label()}</Label>
                      <Textarea
                        id="ws-settings-desc"
                        value={description}
                        onChange={(e) => setDescription(e.target.value)}
                        onBlur={handleDescriptionBlur}
                        placeholder={m.workspace_description_placeholder()}
                        rows={3}
                      />
                    </div>
                  </div>
                )}

                {section === "ai-agent" && (
                  <div className="space-y-6">
                    <div className="space-y-2 max-w-sm">
                      <Label>{m.settings_workspace_default_model()}</Label>
                      <Select value={defaultModel} onValueChange={handleDefaultModelChange}>
                        <SelectTrigger className="w-full">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {availableModels.map((model) => (
                            <SelectItem key={model.id} value={model.id}>
                              <span>{model.name}</span>
                              <span className="ml-2 text-muted-foreground">{model.description}</span>
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      <p className="text-xs text-muted-foreground">
                        {m.settings_workspace_default_model_desc()}
                      </p>
                    </div>

                    <Separator />

                    <div className="space-y-3">
                      <div className="flex items-center justify-between">
                        <Label>{m.settings_workspace_cli_agents()}</Label>
                        <Button variant="outline" size="sm" onClick={handleRefresh} disabled={refreshing}>
                          <RefreshCw className={`mr-2 h-3 w-3 ${refreshing ? "animate-spin" : ""}`} />
                          {m.settings_workspace_cli_refresh()}
                        </Button>
                      </div>
                      {agents.map((agent) => {
                        const status = getCliStatus(agent);
                        const isEnabled = enabledClis.includes(agent.name);
                        const canEnable = status === "authorized";
                        return (
                          <div key={agent.name} className="flex items-start gap-3 py-2">
                            <Checkbox
                              checked={isEnabled}
                              disabled={!canEnable}
                              onCheckedChange={(checked) => handleCliToggle(agent.name, checked === true)}
                              className="mt-0.5"
                            />
                            <div className="flex-1 min-w-0">
                              <span className="text-sm font-medium capitalize">
                                {agent.name === "claude" ? "Claude Code" : agent.name === "codex" ? "Codex" : agent.name}
                              </span>
                              <div className="mt-0.5">
                                {status === "authorized" && (
                                  <Badge variant="secondary" className="text-xs font-normal">
                                    <span className="text-green-600 mr-1">&#10003;</span>
                                    {m.settings_workspace_cli_found_auth({ version: agent.version || "unknown" })}
                                  </Badge>
                                )}
                                {status === "unauthorized" && (
                                  <div className="space-y-1">
                                    <Badge variant="secondary" className="text-xs font-normal">
                                      <span className="text-yellow-600 mr-1">&#9888;</span>
                                      {m.settings_workspace_cli_found_noauth({ version: agent.version || "unknown" })}
                                    </Badge>
                                    {CLI_AUTH_COMMANDS[agent.name] && (
                                      <p className="text-xs text-muted-foreground">
                                        {m.settings_workspace_cli_noauth_hint({ command: CLI_AUTH_COMMANDS[agent.name] })}
                                      </p>
                                    )}
                                  </div>
                                )}
                                {status === "not_found" && (
                                  <div className="flex items-center gap-2">
                                    <Badge variant="destructive" className="text-xs font-normal">
                                      <span className="mr-1">&#10005;</span>
                                      {m.settings_workspace_cli_not_found()}
                                    </Badge>
                                    <a href={agent.docsUrl} target="_blank" rel="noopener noreferrer"
                                      className="text-xs text-primary hover:underline inline-flex items-center gap-1">
                                      {m.settings_workspace_cli_install()}
                                      <ExternalLink className="h-3 w-3" />
                                    </a>
                                  </div>
                                )}
                              </div>
                            </div>
                          </div>
                        );
                      })}
                      {healthReport && (
                        <span className="text-xs text-muted-foreground">
                          {healthReport.restored > 0
                            ? m.settings_workspace_symlinks_restored({ count: String(healthReport.restored) })
                            : m.settings_workspace_symlinks_ok()}
                        </span>
                      )}
                    </div>

                    <Separator />

                    <div className="space-y-2 max-w-sm">
                      <Label>{m.settings_system_prompt()}</Label>
                      <Textarea
                        value={systemPrompt}
                        onChange={(e) => setSystemPrompt(e.target.value)}
                        onBlur={handleSystemPromptBlur}
                        placeholder={m.settings_system_prompt_placeholder()}
                        rows={4}
                      />
                    </div>
                  </div>
                )}

                {section === "git" && (
                  <div className="space-y-6 max-w-sm">
                    <div className="space-y-2">
                      <Label htmlFor="ws-git-remote">{m.git_remote_label()}</Label>
                      <Input
                        id="ws-git-remote"
                        value={remoteUrl}
                        onChange={(e) => setRemoteUrl(e.target.value)}
                        onBlur={handleRemoteBlur}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") {
                            e.preventDefault();
                            (e.target as HTMLInputElement).blur();
                          }
                        }}
                        placeholder={m.git_remote_placeholder()}
                      />
                    </div>
                    <div className="space-y-2">
                      <Label>{m.git_branch_label()}</Label>
                      <p className="text-sm text-muted-foreground">
                        {branch ?? "—"}
                      </p>
                    </div>
                    <Separator />
                    <div className="space-y-2">
                      <Label>{m.git_auto_sync_label()}</Label>
                      <label className="flex items-start gap-2 cursor-pointer">
                        <Checkbox
                          checked={autoSync}
                          onCheckedChange={(checked) =>
                            handleAutoSyncChange(checked === true)
                          }
                          className="mt-0.5"
                        />
                        <span className="text-sm">
                          {m.git_auto_sync_checkbox()}
                          <span className="block text-xs text-muted-foreground">
                            {m.git_auto_sync_hint()}
                          </span>
                        </span>
                      </label>
                    </div>
                  </div>
                )}

                {section === "defaults" && hasChildren && (
                  <div className="space-y-6 max-w-sm">
                    <p className="text-sm text-muted-foreground">
                      {m.settings_defaults_description()}
                    </p>
                    <div className="space-y-2">
                      <Label>{m.settings_workspace_default_model()}</Label>
                      <Select value={defaultsModel} onValueChange={handleDefaultsModelChange}>
                        <SelectTrigger className="w-full">
                          <SelectValue placeholder="—" />
                        </SelectTrigger>
                        <SelectContent>
                          {availableModels.map((model) => (
                            <SelectItem key={model.id} value={model.id}>{model.name}</SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                    <div className="space-y-2">
                      <Label>{m.settings_system_prompt()}</Label>
                      <Textarea
                        value={defaultsPrompt}
                        onChange={(e) => setDefaultsPrompt(e.target.value)}
                        onBlur={handleDefaultsPromptBlur}
                        placeholder={m.settings_system_prompt_placeholder()}
                        rows={3}
                      />
                    </div>
                  </div>
                )}

                {section === "instructions" && (
                  <div className="space-y-4">
                    {agentsMdContent !== null ? (
                      <Card>
                        <CardContent className="p-3">
                          <div className="flex items-center justify-between mb-2">
                            <span className="text-xs text-muted-foreground">
                              {enabledClis.includes("claude")
                                ? m.settings_workspace_agents_md_symlink({ target: "CLAUDE.md" })
                                : "AGENTS.md"}
                            </span>
                            <div className="flex items-center gap-2">
                              <span className="text-xs text-muted-foreground">
                                {m.settings_workspace_agents_md_lines({ count: String(agentsMdLines) })}
                              </span>
                              <Button variant="ghost" size="sm" onClick={handleOpenAgentsMd}>
                                <Pencil className="h-3 w-3 mr-1" />
                                {m.settings_workspace_agents_md_open()}
                              </Button>
                            </div>
                          </div>
                          <pre className="text-xs font-mono bg-muted/50 rounded p-2 max-h-[200px] overflow-y-auto whitespace-pre-wrap">
                            {agentsMdContent}
                          </pre>
                        </CardContent>
                      </Card>
                    ) : (
                      <Button variant="outline" onClick={handleOpenAgentsMd}>
                        {m.settings_workspace_agents_md_create()}
                      </Button>
                    )}
                  </div>
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
      </Dialog>
  );
}
