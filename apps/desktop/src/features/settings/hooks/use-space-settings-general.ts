import { useCallback, useEffect, useState } from "react";
import { useSpace } from "@/features/space";
import { getSettingsSpaceConfig } from "../api";
import type { SaveSpaceConfig } from "./use-space-settings-config-actions";

interface UseSpaceSettingsGeneralOptions {
  open: boolean;
  spacePath: string;
  saveConfig: SaveSpaceConfig;
}

export function useSpaceSettingsGeneral({
  open,
  spacePath,
  saveConfig,
}: UseSpaceSettingsGeneralOptions) {
  const patchSpaceMetadata = useSpace((state) => state.patchSpaceMetadata);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [icon, setIcon] = useState("");
  const [savedName, setSavedName] = useState("");
  const [savedDescription, setSavedDescription] = useState("");

  const loadGeneralConfig = useCallback(async () => {
    if (!spacePath) return;
    try {
      const cfg = await getSettingsSpaceConfig(spacePath);
      setName(cfg.name);
      setDescription(cfg.description);
      setIcon(cfg.icon);
      setSavedName(cfg.name);
      setSavedDescription(cfg.description);
    } catch (err) {
      console.error("Failed to load workspace config:", err);
    }
  }, [spacePath]);

  useEffect(() => {
    if (!open || !spacePath) return;
    const preload = window.setTimeout(() => {
      void loadGeneralConfig();
    }, 0);
    return () => window.clearTimeout(preload);
  }, [open, spacePath, loadGeneralConfig]);

  const syncSpaceStore = useCallback(
    (updates: { name?: string; icon?: string; description?: string }) => {
      patchSpaceMetadata(spacePath, updates);
    },
    [patchSpaceMetadata, spacePath],
  );

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

  return {
    name,
    description,
    icon,
    setName,
    setDescription,
    handleNameBlur,
    handleDescriptionBlur,
    handleIconChange,
  };
}
