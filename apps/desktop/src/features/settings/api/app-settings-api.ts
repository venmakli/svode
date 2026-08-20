import {
  getAppPreferences as getAppPreferencesDto,
  getAppSettings as getAppSettingsDto,
  listenAppPreferencesChanged as listenAppPreferencesChangedDto,
  saveAppSettings as saveAppSettingsDto,
  setAppLocale as setAppLocaleDto,
  setAppTheme as setAppThemeDto,
} from "@/platform/settings/settings-api";

import {
  isAppLocale,
  isAppTheme,
  type AppLocale,
  type AppPreferences,
  type AppSettings,
  type AppTheme,
} from "../model";

export function getAppPreferences(): Promise<AppPreferences> {
  return getAppPreferencesDto();
}

export function getAppSettings(): Promise<AppSettings> {
  return getAppSettingsDto();
}

export function saveAppSettings(settingsData: AppSettings): Promise<void> {
  return saveAppSettingsDto(settingsData);
}

export async function setAppLocale(language: AppLocale): Promise<AppLocale> {
  const committedLocale = await setAppLocaleDto(language);
  if (!isAppLocale(committedLocale)) {
    throw new Error(`Backend returned unsupported locale: ${committedLocale}`);
  }
  return committedLocale;
}

export async function setAppTheme(theme: AppTheme): Promise<AppTheme> {
  const committedTheme = await setAppThemeDto(theme);
  if (!isAppTheme(committedTheme)) {
    throw new Error(`Backend returned unsupported theme: ${committedTheme}`);
  }
  return committedTheme;
}

export function listenAppPreferencesChanged(handler: () => void) {
  return listenAppPreferencesChangedDto(handler);
}
