import { RefreshCw, AlertTriangle, X } from "lucide-react";
import {
  selectFileChangeIndicator,
  selectIndicator,
  useGitStore,
  type GitIndicator,
  type FileChangeIndicator,
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
  pendingWrite?: boolean;
}

export function FileGitIndicatorIcon({
  spacePath,
  filePath,
  pendingWrite = false,
}: FileIndicatorProps) {
  const state = useGitStore((s) =>
    selectFileChangeIndicator(s, spacePath, filePath, pendingWrite),
  );
  if (state.kind === "clean") return null;
  return <IndicatorIcon state={state} />;
}

function IndicatorIcon({
  state,
}: {
  state: GitIndicator | FileChangeIndicator;
}) {
  const kind = typeof state === "string" ? state : state.kind;
  switch (kind) {
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
