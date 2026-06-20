import type { UpdatePlatform } from "../model";

export function getCurrentUpdatePlatform(): UpdatePlatform {
  const platform = navigator.platform.toLowerCase();
  const userAgent = navigator.userAgent.toLowerCase();

  if (platform.includes("mac") || userAgent.includes("mac os")) {
    return "darwin";
  }
  if (platform.includes("win") || userAgent.includes("windows")) {
    return "windows";
  }
  return "linux";
}
