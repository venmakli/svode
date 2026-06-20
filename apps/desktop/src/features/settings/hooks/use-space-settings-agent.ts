import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import * as m from "@/paraglide/messages.js";
import { useChatStatusStore, type ModelOption } from "@/features/chat";
import {
  checkSymlinkHealth,
  getSettingsSpaceConfig,
  listAgentModels,
  listAvailableAgents,
  readAgentsMd,
  setupCliSymlinks,
  teardownCliSymlinks,
} from "../api";
import type { AvailableAgent, SymlinkHealthReport } from "../model";
import type { SaveSpaceConfig } from "./use-space-settings-config-actions";

interface UseSpaceSettingsAgentOptions {
  open: boolean;
  enabled: boolean;
  spacePath: string;
  projectPath: string | null;
  saveConfig: SaveSpaceConfig;
}

export function useSpaceSettingsAgent({
  open,
  enabled,
  spacePath,
  projectPath,
  saveConfig,
}: UseSpaceSettingsAgentOptions) {
  const [agents, setAgents] = useState<AvailableAgent[]>([]);
  const [enabledClis, setEnabledClis] = useState<string[]>([]);
  const [defaultModel, setDefaultModel] = useState("sonnet");
  const [systemPrompt, setSystemPrompt] = useState("");
  const [savedSystemPrompt, setSavedSystemPrompt] = useState("");
  const [availableModels, setAvailableModels] = useState<ModelOption[]>([]);
  const [healthReport, setHealthReport] = useState<SymlinkHealthReport | null>(
    null,
  );
  const [refreshing, setRefreshing] = useState(false);
  const [agentsMdContent, setAgentsMdContent] = useState<string | null>(null);

  const loadAgentConfig = useCallback(async () => {
    if (!spacePath) return;
    try {
      const cfg = await getSettingsSpaceConfig(spacePath);
      setEnabledClis(cfg.agent?.clis ?? []);
      setDefaultModel(cfg.agent?.defaultModel ?? "sonnet");
      setSystemPrompt(cfg.agent?.systemPrompt ?? "");
      setSavedSystemPrompt(cfg.agent?.systemPrompt ?? "");
    } catch (err) {
      console.error("Failed to load workspace config:", err);
    }
  }, [spacePath]);

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

  useEffect(() => {
    if (!enabled || !open || !spacePath) return;
    const preload = window.setTimeout(() => {
      void loadAgentConfig();
      void loadAgents();
      void loadModels();
      void loadAgentsMd();
    }, 0);
    return () => window.clearTimeout(preload);
  }, [
    enabled,
    open,
    spacePath,
    loadAgentConfig,
    loadAgents,
    loadModels,
    loadAgentsMd,
  ]);

  useEffect(() => {
    if (enabled && open && enabledClis.length > 0) {
      const preload = window.setTimeout(() => {
        void checkHealth();
      }, 0);
      return () => window.clearTimeout(preload);
    }
  }, [enabled, open, enabledClis, checkHealth]);

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

  async function handleCliToggle(cliName: string, enabledCli: boolean) {
    const newClis = enabledCli
      ? [...enabledClis, cliName]
      : enabledClis.filter((cli) => cli !== cliName);
    setEnabledClis(newClis);
    try {
      if (enabledCli) {
        await setupCliSymlinks({
          spacePath,
          cliName,
          projectPath,
        });
      } else {
        await teardownCliSymlinks({
          spacePath,
          cliName,
          projectPath,
        });
      }
      await saveConfig({ agent: { clis: newClis } });
      toast.success(m.toast_settings_saved());
    } catch (err) {
      console.error("Failed to toggle CLI:", err);
      toast.error(m.toast_error());
      setEnabledClis(enabledCli ? enabledClis : [...enabledClis, cliName]);
    }
  }

  async function handleRefresh() {
    setRefreshing(true);
    await loadAgents();
    await checkHealth();
    setRefreshing(false);
  }

  return {
    agents,
    enabledClis,
    defaultModel,
    systemPrompt,
    availableModels,
    healthReport,
    refreshing,
    agentsMdContent,
    setSystemPrompt,
    handleDefaultModelChange,
    handleSystemPromptBlur,
    handleCliToggle,
    handleRefresh,
  };
}
