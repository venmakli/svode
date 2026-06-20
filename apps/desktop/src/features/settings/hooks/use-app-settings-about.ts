import { getBuildCommit } from "@/platform/build-info";
import { useAppVersion } from "./use-app-version";

const RELEASE_URL = "https://github.com/venmakli/svode/releases";

export function useAppSettingsAbout() {
  const version = useAppVersion();
  const buildCommit = getBuildCommit();

  return {
    version,
    buildCommit,
    releaseUrl: RELEASE_URL,
  };
}
