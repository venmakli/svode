export const APP_LOCALES = ["en", "ru"] as const;

export type AppLocale = (typeof APP_LOCALES)[number];

export function isAppLocale(value: string): value is AppLocale {
  return APP_LOCALES.some((locale) => locale === value);
}

export function normalizeAppLocale(
  value: string | null | undefined,
): AppLocale {
  return value && isAppLocale(value) ? value : "en";
}
