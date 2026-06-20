import { useDogfoodUpdateCheck } from "../hooks/use-dogfood-update-check";

interface DogfoodUpdateNotifierProps {
  version: string;
  buildCommit: string;
}

export function DogfoodUpdateNotifier({
  version,
  buildCommit,
}: DogfoodUpdateNotifierProps) {
  useDogfoodUpdateCheck({
    currentVersion: version,
    currentBuildCommit: buildCommit,
    auto: true,
  });

  return null;
}
