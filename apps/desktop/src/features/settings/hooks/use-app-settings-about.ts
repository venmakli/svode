import { getBuildCommit, useDogfoodUpdateCheck } from "@/features/updates";
import { useAppVersion } from "./use-app-version";

const RELEASE_URL = "https://github.com/venmakli/svode/releases";

export function useAppSettingsAbout() {
  const version = useAppVersion();
  const buildCommit = getBuildCommit();
  const updates = useDogfoodUpdateCheck({
    currentVersion: version,
    currentBuildCommit: buildCommit,
  });

  return {
    version,
    buildCommit,
    releaseUrl: RELEASE_URL,
    updates,
  };
}
