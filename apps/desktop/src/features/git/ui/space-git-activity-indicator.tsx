import { Loader2 } from "lucide-react";
import { selectIndicator, useGitStore } from "../model";
import { GitIndicatorIcon } from "./git-status-indicator";

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

  if (!loading && gitIndicator === "clean") return null;

  return (
    <span className="inline-flex size-4 shrink-0 items-center justify-center">
      {loading ? (
        <Loader2 className="!size-3 animate-spin text-muted-foreground" />
      ) : (
        <GitIndicatorIcon spacePath={spacePath} />
      )}
    </span>
  );
}
