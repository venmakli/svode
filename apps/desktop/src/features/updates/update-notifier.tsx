import { useAppVersion } from "@/hooks/use-app-version";
import { getBuildCommit } from "./model";
import { useDogfoodUpdateCheck } from "./hooks/use-dogfood-update-check";

export function DogfoodUpdateNotifier() {
  const version = useAppVersion();
  useDogfoodUpdateCheck({
    currentVersion: version,
    currentBuildCommit: getBuildCommit(),
    auto: true,
  });

  return null;
}
