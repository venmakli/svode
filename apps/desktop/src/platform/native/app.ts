import { getVersion } from "@tauri-apps/api/app";

export function getAppVersion(): Promise<string> {
  return getVersion();
}
