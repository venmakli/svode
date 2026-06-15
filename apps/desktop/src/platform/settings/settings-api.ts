import { invokeCommand } from "@/platform/native/invoke";

export interface DetectedCliDto {
  name: string;
  path: string;
  version?: string;
  authStatus: string;
}

export interface AppAgentSettingsDto {
  detected: DetectedCliDto[];
  lastScan?: string;
}

export interface AppSettingsDto {
  appearance: { theme: string; language: string };
  window: { width: number; height: number };
  agents?: AppAgentSettingsDto;
}

export function getAppSettings(): Promise<AppSettingsDto> {
  return invokeCommand<AppSettingsDto>("get_app_settings");
}

export function saveAppSettings(settingsData: AppSettingsDto): Promise<void> {
  return invokeCommand<void>("save_app_settings", { settingsData });
}
