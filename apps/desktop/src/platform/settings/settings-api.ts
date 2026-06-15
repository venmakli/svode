import { invokeCommand } from "@/platform/native/invoke";
import type { AppSettings } from "@/types/space";

export type AppSettingsDto = AppSettings;

export function getAppSettings(): Promise<AppSettingsDto> {
  return invokeCommand<AppSettingsDto>("get_app_settings");
}

export function saveAppSettings(settingsData: AppSettingsDto): Promise<void> {
  return invokeCommand<void>("save_app_settings", { settingsData });
}
