import {
  getAppSettings as getAppSettingsDto,
  listenAppLocaleChanged as listenAppLocaleChangedDto,
  saveAppSettings as saveAppSettingsDto,
  setAppLocale as setAppLocaleDto,
} from "@/platform/settings/settings-api";

import { isAppLocale, type AppLocale, type AppSettings } from "../model";

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

export function listenAppLocaleChanged(handler: () => void) {
  return listenAppLocaleChangedDto(handler);
}
