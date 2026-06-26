import { Loader2 } from "lucide-react";
import {
  selectIndicator,
  selectSpaceRootChangeIndicator,
  useGitStore,
} from "../model";
import {
  GitIndicatorIcon,
  SpaceRootGitIndicatorIcon,
} from "./git-status-indicator";

export function SpaceGitActivityIndicator({
  spacePath,
  loading,
}: {
  spacePath: string;
  loading: boolean;
}) {
  const gitIndicator = useGitStore((state) =>
    selectIndicator(state, spacePath),
  );
  const rootIndicator = useGitStore((state) =>
    selectSpaceRootChangeIndicator(state, spacePath),
  );
  const showRootIndicator =
    rootIndicator.kind !== "clean" &&
    (gitIndicator === "clean" || gitIndicator === "dirty");

  if (!loading && gitIndicator === "clean" && rootIndicator.kind === "clean") {
    return null;
  }

  return (
    <span className="inline-flex size-4 shrink-0 items-center justify-center">
      {loading ? (
        <Loader2 className="!size-3 animate-spin text-muted-foreground" />
      ) : showRootIndicator ? (
        <SpaceRootGitIndicatorIcon spacePath={spacePath} />
      ) : (
        <GitIndicatorIcon spacePath={spacePath} />
      )}
    </span>
  );
}
