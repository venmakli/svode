import { RefreshCw, AlertTriangle, X } from "lucide-react";
import * as m from "@/paraglide/messages.js";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  selectFileChangeIndicator,
  selectIndicator,
  selectSpaceRootChangeIndicator,
  selectTreeNodeChangeIndicator,
  useGitStore,
  type GitIndicator,
  type FileChangeIndicator,
  type FileGitState,
  gitSaveShortcutLabel,
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
  isContainer?: boolean;
  pendingWrite?: boolean;
}

export function FileGitIndicatorIcon({
  spacePath,
  filePath,
  isContainer = false,
  pendingWrite = false,
}: FileIndicatorProps) {
  const state = useGitStore((s) =>
    isContainer
      ? selectTreeNodeChangeIndicator(s, spacePath, {
          path: filePath,
          isContainer,
          pendingWrite,
        })
      : selectFileChangeIndicator(s, spacePath, filePath, pendingWrite),
  );
  if (state.kind === "clean") return null;
  return <IndicatorIcon state={state} />;
}

export function SpaceRootGitIndicatorIcon({ spacePath }: SpaceIndicatorProps) {
  const state = useGitStore((s) =>
    selectSpaceRootChangeIndicator(s, spacePath),
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
  const label = indicatorLabel(state);
  switch (kind) {
    case "dirty":
      return (
        <Tooltip>
          <TooltipTrigger asChild>
            <span
              aria-label={label}
              className="inline-flex size-3 items-center justify-center text-[11px] leading-none text-muted-foreground"
            >
              {dirtyGlyph(state)}
            </span>
          </TooltipTrigger>
          <TooltipContent side="right">{label}</TooltipContent>
        </Tooltip>
      );
    case "syncing":
      return (
        <Tooltip>
          <TooltipTrigger asChild>
            <RefreshCw
              aria-label={label}
              className="h-3 w-3 animate-spin text-muted-foreground"
            />
          </TooltipTrigger>
          <TooltipContent side="right">{label}</TooltipContent>
        </Tooltip>
      );
    case "conflict":
      return (
        <Tooltip>
          <TooltipTrigger asChild>
            <AlertTriangle
              aria-label={label}
              className="h-3 w-3 text-yellow-600"
            />
          </TooltipTrigger>
          <TooltipContent side="right">{label}</TooltipContent>
        </Tooltip>
      );
    case "error":
      return (
        <Tooltip>
          <TooltipTrigger asChild>
            <X aria-label={label} className="h-3 w-3 text-destructive" />
          </TooltipTrigger>
          <TooltipContent side="right">{label}</TooltipContent>
        </Tooltip>
      );
    case "cloning":
      return (
        <Tooltip>
          <TooltipTrigger asChild>
            <RefreshCw
              aria-label={label}
              className="h-3 w-3 animate-spin text-muted-foreground"
            />
          </TooltipTrigger>
          <TooltipContent side="right">{label}</TooltipContent>
        </Tooltip>
      );
    default:
      return null;
  }
}

function dirtyGlyph(state: GitIndicator | FileChangeIndicator): string {
  if (typeof state === "string") return "●";
  if (state.kind !== "dirty") return "●";
  switch (state.scope) {
    case "descendants":
      return "○";
    case "mixed":
      return "⦿";
    case "self":
      return "●";
  }
}

function indicatorLabel(state: GitIndicator | FileChangeIndicator): string {
  if (state === "dirty") return dirtyLabel(state);
  if (typeof state !== "string" && state.kind === "dirty") {
    return dirtyLabel(state);
  }

  const kind = typeof state === "string" ? state : state.kind;
  switch (kind) {
    case "syncing":
      return m.git_status_syncing();
    case "conflict":
      return m.git_status_conflict();
    case "error":
      return m.git_status_error();
    case "cloning":
      return m.git_status_cloning();
    case "clean":
      return "";
  }
}

type DirtyFileChangeIndicator = Extract<FileChangeIndicator, { kind: "dirty" }>;

function dirtyLabel(state: "dirty" | DirtyFileChangeIndicator): string {
  if (state === "dirty") {
    return withSaveShortcut(m.git_status_changed(), "self");
  }
  switch (state.scope) {
    case "descendants":
      return withSaveShortcut(m.git_status_has_changes_inside(), "descendants");
    case "mixed":
      return withSaveShortcut(m.git_status_changed_and_inside(), "mixed");
    case "self":
      return withSaveShortcut(gitStateLabel(state.state), "self");
  }
}

function gitStateLabel(state: FileGitState | undefined): string {
  switch (state) {
    case "untracked":
      return m.git_status_untracked();
    case "deleted":
      return m.git_status_deleted();
    case "conflict":
      return m.git_status_conflict();
    case "modified":
    default:
      return m.git_status_changed();
  }
}

function withSaveShortcut(
  label: string,
  scope: "self" | "descendants" | "mixed",
): string {
  return `${label} · ${shortcutLabel(scope)}`;
}

function shortcutLabel(scope: "self" | "descendants" | "mixed"): string {
  return gitSaveShortcutLabel(scope);
}
