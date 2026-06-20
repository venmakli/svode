import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import * as m from "@/paraglide/messages.js";
import type { AgentConfig } from "@/features/space";
import { getSettingsSpaceConfig } from "../api";
import type { SaveSpaceConfig } from "./use-space-settings-config-actions";

interface UseSpaceSettingsDefaultsOptions {
  open: boolean;
  enabled: boolean;
  spacePath: string;
  saveConfig: SaveSpaceConfig;
}

export function useSpaceSettingsDefaults({
  open,
  enabled,
  spacePath,
  saveConfig,
}: UseSpaceSettingsDefaultsOptions) {
  const [defaultsModel, setDefaultsModel] = useState("");
  const [defaultsPrompt, setDefaultsPrompt] = useState("");
  const [savedDefaultsPrompt, setSavedDefaultsPrompt] = useState("");

  const loadDefaultsConfig = useCallback(async () => {
    if (!spacePath) return;
    try {
      const cfg = await getSettingsSpaceConfig(spacePath);
      const defaults = cfg.defaults?.agent;
      setDefaultsModel(defaults?.defaultModel ?? "");
      setDefaultsPrompt(defaults?.systemPrompt ?? "");
      setSavedDefaultsPrompt(defaults?.systemPrompt ?? "");
    } catch (err) {
      console.error("Failed to load workspace defaults:", err);
    }
  }, [spacePath]);

  useEffect(() => {
    if (!enabled || !open || !spacePath) return;
    const preload = window.setTimeout(() => {
      void loadDefaultsConfig();
    }, 0);
    return () => window.clearTimeout(preload);
  }, [enabled, open, spacePath, loadDefaultsConfig]);

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
    await saveDefaults(modelId, defaultsPrompt);
  }

  async function handleDefaultsPromptBlur() {
    if (defaultsPrompt === savedDefaultsPrompt) return;
    setSavedDefaultsPrompt(defaultsPrompt);
    await saveDefaults(defaultsModel, defaultsPrompt);
  }

  return {
    defaultsModel,
    defaultsPrompt,
    setDefaultsPrompt,
    handleDefaultsModelChange,
    handleDefaultsPromptBlur,
  };
}
