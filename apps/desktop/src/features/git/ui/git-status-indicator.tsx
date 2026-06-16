import { RefreshCw, AlertTriangle, X } from "lucide-react";
import {
  selectFileIndicator,
  selectIndicator,
  useGitStore,
  type GitIndicator,
} from "../model";

interface SpaceIndicatorProps {
  spacePath: string;
}

/**
 * Per-space git indicator (●/↻/⚠/✕). Renders nothing for clean state.
 * The cloning state is rendered separately by the sidebar (with a progress bar).
 */
export function GitIndicatorIcon({ spacePath }: SpaceIndicatorProps) {
  const state = useGitStore((s) => selectIndicator(s, spacePath));
  return <IndicatorIcon state={state} />;
}

interface FileIndicatorProps {
  spacePath: string;
  filePath: string;
}

export function FileGitIndicatorIcon({
  spacePath,
  filePath,
}: FileIndicatorProps) {
  const state = useGitStore((s) => selectFileIndicator(s, spacePath, filePath));
  if (state === "clean") return null;
  return <IndicatorIcon state={state} />;
}

function IndicatorIcon({
  state,
}: {
  state: GitIndicator | "dirty" | "syncing" | "conflict";
}) {
  switch (state) {
    case "dirty":
      return (
        <span
          aria-label="uncommitted changes"
          className="text-xs text-muted-foreground"
        >
          ●
        </span>
      );
    case "syncing":
      return (
        <RefreshCw
          aria-label="syncing"
          className="h-3 w-3 animate-spin text-muted-foreground"
        />
      );
    case "conflict":
      return (
        <AlertTriangle
          aria-label="conflict"
          className="h-3 w-3 text-yellow-600"
        />
      );
    case "error":
      return <X aria-label="sync error" className="h-3 w-3 text-destructive" />;
    case "cloning":
      return (
        <RefreshCw
          aria-label="cloning"
          className="h-3 w-3 animate-spin text-muted-foreground"
        />
      );
    default:
      return null;
  }
}
