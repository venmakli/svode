import { getAppVersion as getPlatformAppVersion } from "@/platform/native/app";

export function getAppVersion(): Promise<string> {
  return getPlatformAppVersion();
}
