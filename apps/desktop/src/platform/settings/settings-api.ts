import { listen, type UnlistenFn } from "@/platform/native/events";
import { invokeCommand } from "@/platform/native/invoke";

const APP_PREFERENCES_CHANGED_EVENT = "app-settings:preferences-changed";

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

export interface AppPreferencesDto {
  theme: string;
  language: string;
  themeNeedsRecovery: boolean;
}

export function getAppPreferences(): Promise<AppPreferencesDto> {
  return invokeCommand<AppPreferencesDto>("get_app_preferences");
}

export function getAppSettings(): Promise<AppSettingsDto> {
  return invokeCommand<AppSettingsDto>("get_app_settings");
}

export function saveAppSettings(settingsData: AppSettingsDto): Promise<void> {
  return invokeCommand<void>("save_app_settings", { settingsData });
}

export function setAppLocale(language: string): Promise<string> {
  return invokeCommand<string>("set_app_locale", { locale: language });
}

export function setAppTheme(theme: string): Promise<string> {
  return invokeCommand<string>("set_app_theme", { theme });
}

export function listenAppPreferencesChanged(
  handler: () => void,
): Promise<UnlistenFn> {
  return listen<void>(APP_PREFERENCES_CHANGED_EVENT, () => handler());
}
