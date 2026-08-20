export const APP_THEMES = ["system", "light", "dark"] as const;

export type AppTheme = (typeof APP_THEMES)[number];

export function isAppTheme(value: string): value is AppTheme {
  return APP_THEMES.some((theme) => theme === value);
}

export function normalizeAppTheme(
  value: string | null | undefined,
): AppTheme {
  return value && isAppTheme(value) ? value : "system";
}
