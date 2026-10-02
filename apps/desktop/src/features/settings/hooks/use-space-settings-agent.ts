import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import * as m from "@/paraglide/messages.js";
import { useChatStatusStore, type ModelOption } from "@/features/chat";
import { getSettingsSpaceConfig, listAgentModels, readAgentsMd } from "../api";
import type { SaveSpaceConfig } from "./use-space-settings-config-actions";

interface UseSpaceSettingsAgentOptions {
  open: boolean;
  enabled: boolean;
  spacePath: string;
  saveConfig: SaveSpaceConfig;
}

export function useSpaceSettingsAgent({
  open,
  enabled,
  spacePath,
  saveConfig,
}: UseSpaceSettingsAgentOptions) {
  const [enabledClis, setEnabledClis] = useState<string[]>([]);
  const [defaultModel, setDefaultModel] = useState("sonnet");
  const [systemPrompt, setSystemPrompt] = useState("");
  const [savedSystemPrompt, setSavedSystemPrompt] = useState("");
  const [availableModels, setAvailableModels] = useState<ModelOption[]>([]);
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

  const loadAgentsMd = useCallback(async () => {
    if (!spacePath) return;
    try {
      const content = await readAgentsMd(spacePath);
      setAgentsMdContent(content);
    } catch {
      setAgentsMdContent(null);
    }
  }, [spacePath]);

  useEffect(() => {
    if (!enabled || !open || !spacePath) return;
    const preload = window.setTimeout(() => {
      void loadAgentConfig();
      void loadModels();
      void loadAgentsMd();
    }, 0);
    return () => window.clearTimeout(preload);
  }, [enabled, open, spacePath, loadAgentConfig, loadModels, loadAgentsMd]);

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

  return {
    enabledClis,
    defaultModel,
    systemPrompt,
    availableModels,
    agentsMdContent,
    setSystemPrompt,
    handleDefaultModelChange,
    handleSystemPromptBlur,
  };
}
