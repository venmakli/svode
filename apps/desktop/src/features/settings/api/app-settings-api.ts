import {
  getAppPreferences as getAppPreferencesDto,
  listenAppPreferencesChanged as listenAppPreferencesChangedDto,
  setAppLocale as setAppLocaleDto,
  setAppTheme as setAppThemeDto,
} from "@/platform/settings/settings-api";

import {
  isAppLocale,
  isAppTheme,
  type AppLocale,
  type AppPreferences,
  type AppTheme,
} from "../model";

export function getAppPreferences(): Promise<AppPreferences> {
  return getAppPreferencesDto();
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
