import { useCallback } from "react";
import { toast } from "sonner";
import * as m from "@/paraglide/messages.js";
import type { SpaceConfig } from "@/features/space";
import { getSettingsSpaceConfig, saveSettingsSpaceConfig } from "../api";

export type SaveSpaceConfig = (
  updates: Partial<SpaceConfig>,
) => Promise<boolean>;

export type SaveSpaceGitConfig = (
  updates: NonNullable<SpaceConfig["git"]>,
) => Promise<boolean>;

interface UseSpaceSettingsConfigActionsOptions {
  spacePath: string;
  projectPath: string | null;
}

export function useSpaceSettingsConfigActions({
  spacePath,
  projectPath,
}: UseSpaceSettingsConfigActionsOptions): {
  saveConfig: SaveSpaceConfig;
  saveGitConfig: SaveSpaceGitConfig;
} {
  const saveConfig = useCallback<SaveSpaceConfig>(
    async (updates) => {
      if (!spacePath) return false;
      try {
        const cfg = await getSettingsSpaceConfig(spacePath);
        await saveSettingsSpaceConfig({
          spacePath,
          configData: { ...cfg, ...updates },
          projectPath,
        });
        return true;
      } catch (err) {
        console.error("Failed to save workspace config:", err);
        toast.error(m.toast_error());
        return false;
      }
    },
    [spacePath, projectPath],
  );

  const saveGitConfig = useCallback<SaveSpaceGitConfig>(
    async (updates) => {
      if (!spacePath) return false;
      try {
        const cfg = await getSettingsSpaceConfig(spacePath);
        await saveSettingsSpaceConfig({
          spacePath,
          configData: { ...cfg, git: { ...cfg.git, ...updates } },
          projectPath,
        });
        return true;
      } catch (err) {
        console.error("Failed to save git config:", err);
        toast.error(m.toast_error());
        return false;
      }
    },
    [spacePath, projectPath],
  );

  return { saveConfig, saveGitConfig };
}
