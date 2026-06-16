import {
  getAppSettings as getAppSettingsDto,
  saveAppSettings as saveAppSettingsDto,
} from "@/platform/settings/settings-api";

import type { AppSettings } from "../model";

export function getAppSettings(): Promise<AppSettings> {
  return getAppSettingsDto();
}

export function saveAppSettings(settingsData: AppSettings): Promise<void> {
  return saveAppSettingsDto(settingsData);
}
