import { getVersion, setTheme } from "@tauri-apps/api/app";

export type NativeAppTheme = "light" | "dark";

export function getAppVersion(): Promise<string> {
  return getVersion();
}

/**
 * Sets the theme of every window of the application, including windows opened
 * later, for the OS and every WebView frame; `null` follows the OS theme.
 */
export function setNativeAppTheme(theme: NativeAppTheme | null): Promise<void> {
  return setTheme(theme);
}
