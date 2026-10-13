import { useCallback } from "react";
import { toast } from "sonner";
import * as m from "@/paraglide/messages.js";
import type { SpaceConfig } from "@/features/space";
import { getSettingsSpaceConfig, saveSettingsSpaceConfig } from "../api";

/** `recovering`: the failure was handed to a recovery that now shows it. */
export type SaveSpaceConfigResult = "saved" | "recovering" | "failed";

export type SaveSpaceConfig = (
  updates: Partial<SpaceConfig>,
  recoverFromError?: (error: unknown) => Promise<boolean>,
) => Promise<SaveSpaceConfigResult>;

interface UseSpaceSettingsConfigActionsOptions {
  spacePath: string;
  projectPath: string | null;
}

export function useSpaceSettingsConfigActions({
  spacePath,
  projectPath,
}: UseSpaceSettingsConfigActionsOptions): {
  saveConfig: SaveSpaceConfig;
} {
  const saveConfig = useCallback<SaveSpaceConfig>(
    async (updates, recoverFromError) => {
      if (!spacePath) return "failed";
      try {
        const cfg = await getSettingsSpaceConfig(spacePath);
        await saveSettingsSpaceConfig({
          spacePath,
          configData: { ...cfg, ...updates },
          projectPath,
        });
        return "saved";
      } catch (err) {
        if (await recoverFromError?.(err)) return "recovering";
        console.error("Failed to save workspace config:", err);
        toast.error(m.toast_error());
        return "failed";
      }
    },
    [spacePath, projectPath],
  );

  return { saveConfig };
}
