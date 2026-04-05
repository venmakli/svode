import { useState, useEffect, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import { toast } from "sonner";
import * as m from "@/paraglide/messages.js";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
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
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Separator } from "@/components/ui/separator";
import { Checkbox } from "@/components/ui/checkbox";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { EmojiPicker } from "@/components/ui/emoji-picker";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { ExternalLink, Pencil, RefreshCw } from "lucide-react";
import { useWorkspaceStore } from "@/stores/workspace";
import { useLayoutStore } from "@/stores/layout";
import { useChatStatusStore, type ModelOption } from "@/stores/chat";
import type {
  WorkspaceConfig,
  AvailableAgent,
  SymlinkHealthReport,
} from "@/types/workspace";

interface WorkspaceSettingsDialogProps {
  open: boolean;
  workspaceId: string | null;
  onOpenChange: (open: boolean) => void;
}

const CLI_AUTH_COMMANDS: Record<string, string> = {
  claude: "claude login",
};

export function WorkspaceSettingsDialog({
  open,
  workspaceId,
  onOpenChange,
}: WorkspaceSettingsDialogProps) {
  const { workspaces } = useWorkspaceStore();
  const { openDocument, closeSettings } = useLayoutStore();

  const workspace = workspaces.find((w) => w.id === workspaceId);
  const workspacePath = workspace?.path ?? "";

  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [icon, setIcon] = useState("");
  const [initialName, setInitialName] = useState("");
  const [initialDescription, setInitialDescription] = useState("");
  const [showUnsaved, setShowUnsaved] = useState(false);

  // CLI agents
  const [agents, setAgents] = useState<AvailableAgent[]>([]);
  const [enabledClis, setEnabledClis] = useState<string[]>([]);
  const [healthReport, setHealthReport] = useState<SymlinkHealthReport | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  // Default model
  const [defaultModel, setDefaultModel] = useState("sonnet");
  const [availableModels, setAvailableModels] = useState<ModelOption[]>([]);

  // AGENTS.md
  const [agentsMdContent, setAgentsMdContent] = useState<string | null>(null);

  const isDirty = name !== initialName || description !== initialDescription;

  const loadConfig = useCallback(async () => {
    if (!workspacePath) return;
    try {
      const cfg = await invoke<WorkspaceConfig>("get_workspace_config", {
        workspacePath,
      });
      setName(cfg.name);
      setDescription(cfg.description);
      setIcon(cfg.icon);
      setInitialName(cfg.name);
      setInitialDescription(cfg.description);

      // Parse enabled CLIs and default model from agent config
      const agentValue = cfg.agent as { clis?: string[]; defaultModel?: string } | null;
      setEnabledClis(agentValue?.clis ?? []);
      setDefaultModel(agentValue?.defaultModel ?? "sonnet");
    } catch (err) {
      console.error("Failed to load workspace config:", err);
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
        const report = await invoke<SymlinkHealthReport>("check_symlink_health", {
          workspacePath,
          cliName: cli,
        });
        setHealthReport(report);
      } catch {
        // ignore
      }
    }
  }, [workspacePath, enabledClis]);

  useEffect(() => {
    if (open && workspacePath) {
      loadConfig();
      loadAgents();
      loadModels();
      loadAgentsMd();
    }
  }, [open, workspacePath, loadConfig, loadAgents, loadModels, loadAgentsMd]);

  useEffect(() => {
    if (open && enabledClis.length > 0) {
      checkHealth();
    }
  }, [open, enabledClis, checkHealth]);

  async function handleRefresh() {
    setRefreshing(true);
    await loadAgents();
    await checkHealth();
    setRefreshing(false);
  }

  async function saveConfig(updates: Partial<{ name: string; description: string; icon: string; agent: unknown }>) {
    if (!workspacePath) return false;
    try {
      const cfg = await invoke<WorkspaceConfig>("get_workspace_config", { workspacePath });
      const merged: WorkspaceConfig = { ...cfg, ...updates };
      await invoke("save_workspace_config", { workspacePath, configData: merged });
      return true;
    } catch (err) {
      console.error("Failed to save workspace config:", err);
      toast.error(m.toast_error());
      return false;
    }
  }

  async function handleSave() {
    const ok = await saveConfig({
      name: name.trim(),
      description: description.trim(),
      icon,
    });
    if (ok) {
      setInitialName(name.trim());
      setInitialDescription(description.trim());
      // Update store
      useWorkspaceStore.setState({
        workspaces: useWorkspaceStore.getState().workspaces.map((w) =>
          w.id === workspaceId ? { ...w, name: name.trim(), icon } : w
        ),
      });
      toast.success(m.toast_settings_saved());
      onOpenChange(false);
    }
  }

  async function handleIconChange(newIcon: string) {
    setIcon(newIcon);
    await saveConfig({ icon: newIcon });
    useWorkspaceStore.setState({
      workspaces: useWorkspaceStore.getState().workspaces.map((w) =>
        w.id === workspaceId ? { ...w, icon: newIcon } : w
      ),
    });
  }

  async function handleDefaultModelChange(modelId: string) {
    setDefaultModel(modelId);
    try {
      const cfg = await invoke<WorkspaceConfig>("get_workspace_config", { workspacePath });
      const agentValue = (cfg.agent ?? {}) as Record<string, unknown>;
      await saveConfig({ agent: { ...agentValue, defaultModel: modelId } });
      // Apply to active chat immediately
      useChatStatusStore.getState().applyDefaultModel(modelId);
      toast.success(m.toast_settings_saved());
    } catch (err) {
      console.error("Failed to save default model:", err);
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
        await invoke<string[]>("setup_cli_symlinks_cmd", { workspacePath, cliName });
      } else {
        await invoke("teardown_cli_symlinks_cmd", { workspacePath, cliName });
      }
      // Save to config
      await saveConfig({ agent: { clis: newClis } });
      toast.success(m.toast_settings_saved());
    } catch (err) {
      console.error("Failed to toggle CLI:", err);
      toast.error(m.toast_error());
      // Revert
      setEnabledClis(enabled ? enabledClis : [...enabledClis, cliName]);
    }
  }

  function handleClose() {
    if (isDirty) {
      setShowUnsaved(true);
    } else {
      onOpenChange(false);
    }
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

  return (
    <>
      <Dialog open={open} onOpenChange={(v) => { if (!v) handleClose(); }}>
        <DialogContent className="sm:max-w-[600px] p-0 gap-0 max-h-[85vh] flex flex-col">
          <DialogHeader className="px-6 pt-6 pb-4 shrink-0">
            <DialogTitle>
              {m.settings_workspace_title({ name: workspace?.name ?? "" })}
            </DialogTitle>
          </DialogHeader>
          <Separator className="shrink-0" />

          <div className="flex-1 overflow-y-auto px-6 py-6 space-y-6">
            {/* Section: Space */}
            <div className="space-y-4">
              <h3 className="text-sm font-medium text-muted-foreground uppercase tracking-wide">
                {m.settings_workspace_space()}
              </h3>
              <div className="space-y-2">
                <Label htmlFor="ws-settings-name">{m.workspace_name_label()}</Label>
                <div className="flex gap-2">
                  <EmojiPicker value={icon} onChange={handleIconChange} size="sm" />
                  <Input
                    id="ws-settings-name"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
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
                  placeholder={m.workspace_description_placeholder()}
                  rows={2}
                />
              </div>
            </div>

            <Separator />

            {/* Section: CLI Agents */}
            <div className="space-y-4">
              <h3 className="text-sm font-medium text-muted-foreground uppercase tracking-wide">
                {m.settings_workspace_cli_agents()}
              </h3>
              <div className="space-y-3">
                {agents.map((agent) => {
                  const status = getCliStatus(agent);
                  const isEnabled = enabledClis.includes(agent.name);
                  const canEnable = status === "authorized";

                  return (
                    <div key={agent.name} className="flex items-start gap-3 py-2">
                      <Checkbox
                        checked={isEnabled}
                        disabled={!canEnable}
                        onCheckedChange={(checked) =>
                          handleCliToggle(agent.name, checked === true)
                        }
                        className="mt-0.5"
                      />
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2">
                          <span className="text-sm font-medium capitalize">
                            {agent.name === "claude" ? "Claude Code" : agent.name === "codex" ? "Codex" : agent.name}
                          </span>
                        </div>
                        <div className="mt-0.5">
                          {status === "authorized" && (
                            <Badge variant="secondary" className="text-xs font-normal">
                              <span className="text-green-600 mr-1">&#10003;</span>
                              {m.settings_workspace_cli_found_auth({
                                version: agent.version || "unknown",
                              })}
                            </Badge>
                          )}
                          {status === "unauthorized" && (
                            <div className="space-y-1">
                              <Badge variant="secondary" className="text-xs font-normal">
                                <span className="text-yellow-600 mr-1">&#9888;</span>
                                {m.settings_workspace_cli_found_noauth({
                                  version: agent.version || "unknown",
                                })}
                              </Badge>
                              {CLI_AUTH_COMMANDS[agent.name] && (
                                <p className="text-xs text-muted-foreground">
                                  {m.settings_workspace_cli_noauth_hint({
                                    command: CLI_AUTH_COMMANDS[agent.name],
                                  })}
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
                              <a
                                href={agent.docsUrl}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="text-xs text-primary hover:underline inline-flex items-center gap-1"
                              >
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
              </div>
              <div className="flex items-center gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={handleRefresh}
                  disabled={refreshing}
                >
                  <RefreshCw className={`mr-2 h-3 w-3 ${refreshing ? "animate-spin" : ""}`} />
                  {m.settings_workspace_cli_refresh()}
                </Button>
                {healthReport && (
                  <span className="text-xs text-muted-foreground">
                    {healthReport.restored > 0
                      ? m.settings_workspace_symlinks_restored({ count: String(healthReport.restored) })
                      : m.settings_workspace_symlinks_ok()}
                  </span>
                )}
              </div>
            </div>

            <Separator />

            {/* Section: Default Model */}
            <div className="space-y-4">
              <h3 className="text-sm font-medium text-muted-foreground uppercase tracking-wide">
                {m.settings_workspace_model()}
              </h3>
              <div className="space-y-2">
                <Label>{m.settings_workspace_default_model()}</Label>
                <Select value={defaultModel} onValueChange={handleDefaultModelChange}>
                  <SelectTrigger className="w-[200px]">
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
            </div>

            <Separator />

            {/* Section: Instructions File */}
            <div className="space-y-4">
              <h3 className="text-sm font-medium text-muted-foreground uppercase tracking-wide">
                {m.settings_workspace_instructions()}
              </h3>
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
          </div>

          <Separator className="shrink-0" />
          <DialogFooter className="px-6 py-4 shrink-0">
            <Button variant="outline" onClick={handleClose}>
              {m.settings_cancel()}
            </Button>
            <Button onClick={handleSave} disabled={!isDirty}>
              {m.settings_save()}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <AlertDialog open={showUnsaved} onOpenChange={setShowUnsaved}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{m.settings_unsaved_title()}</AlertDialogTitle>
            <AlertDialogDescription>
              {m.settings_unsaved_description()}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{m.settings_cancel()}</AlertDialogCancel>
            <Button
              variant="outline"
              onClick={() => {
                setShowUnsaved(false);
                setName(initialName);
                setDescription(initialDescription);
                onOpenChange(false);
              }}
            >
              {m.settings_unsaved_discard()}
            </Button>
            <AlertDialogAction onClick={() => {
              setShowUnsaved(false);
              handleSave();
            }}>
              {m.settings_unsaved_save()}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
