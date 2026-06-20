import {
  getSpaceConfig,
  saveSpaceConfig,
} from "@/platform/space/space-api";

import type { SpaceConfig } from "@/features/space";

export interface SaveSettingsSpaceConfigInput extends Record<string, unknown> {
  spacePath: string;
  configData: SpaceConfig;
  projectPath?: string | null;
}

export function getSettingsSpaceConfig(
  spacePath: string,
): Promise<SpaceConfig> {
  return getSpaceConfig(spacePath);
}

export function saveSettingsSpaceConfig({
  spacePath,
  configData,
  projectPath,
}: SaveSettingsSpaceConfigInput): Promise<void> {
  return saveSpaceConfig(spacePath, configData, projectPath);
}
