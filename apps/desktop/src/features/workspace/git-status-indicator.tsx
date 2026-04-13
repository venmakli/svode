import { RefreshCw, AlertTriangle, X, Circle } from "lucide-react";
import {
  selectFileIndicator,
  selectIndicator,
  useGitStore,
  type WorkspaceGitIndicator,
} from "@/stores/git";

interface WorkspaceIndicatorProps {
  workspacePath: string;
}

/**
 * Per-workspace git indicator (●/↻/⚠/✕). Renders nothing for clean state.
 * The cloning state is rendered separately by the sidebar (with a progress bar).
 */
export function WorkspaceGitIndicatorIcon({ workspacePath }: WorkspaceIndicatorProps) {
  const state = useGitStore((s) => selectIndicator(s, workspacePath));
  return <IndicatorIcon state={state} />;
}

interface FileIndicatorProps {
  workspacePath: string;
  filePath: string;
}

export function FileGitIndicatorIcon({ workspacePath, filePath }: FileIndicatorProps) {
  const state = useGitStore((s) => selectFileIndicator(s, workspacePath, filePath));
  if (state === "clean") return null;
  return <IndicatorIcon state={state} />;
}

function IndicatorIcon({ state }: { state: WorkspaceGitIndicator | "dirty" | "syncing" | "conflict" }) {
  switch (state) {
    case "dirty":
      return (
        <span aria-label="uncommitted changes" className="text-xs text-muted-foreground">●</span>
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
