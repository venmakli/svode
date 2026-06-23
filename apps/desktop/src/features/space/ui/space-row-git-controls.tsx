import { Loader2, Save } from "lucide-react";
import * as m from "@/paraglide/messages.js";
import {
  DropdownMenuItem,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import { Progress } from "@/components/ui/progress";
import {
  SpaceGitActivityIndicator,
  useSpaceSidebarGit,
  type SpaceSidebarGitCloneProgress,
} from "@/features/git/sidebar";
import type { LfsState } from "../model";
import { LfsIndicatorIcon } from "./nav-space-indicators";

interface SpaceRowGitControlsProps {
  lfsState: LfsState;
  loading: boolean;
  refreshing: boolean;
  rootPath: string;
  spacePath: string;
}

function cloneProgressLabel(cloning: SpaceSidebarGitCloneProgress): string {
  switch (cloning.status) {
    case "starting":
      return m.git_clone_progress();
    case "failed":
      return cloning.error ?? m.git_clone_failed();
    case "progress":
      return `${cloning.phase ?? m.git_clone_progress()} ${cloning.percent}%`;
  }
}

export function useSpaceRowGitControls({
  lfsState,
  loading,
  refreshing,
  rootPath,
  spacePath,
}: SpaceRowGitControlsProps) {
  const { cloning, dirty, commitAll } = useSpaceSidebarGit(spacePath, rootPath);

  return {
    cloning,
    dirty,
    dropdownItem: dirty ? (
      <>
        <DropdownMenuSeparator />
        <DropdownMenuItem onClick={commitAll}>
          <Save />
          {m.git_save_all()}
        </DropdownMenuItem>
      </>
    ) : null,
    inlineActivity: (
      <span className="ml-auto flex items-center gap-1">
        <LfsIndicatorIcon lfsState={lfsState} />
        <SpaceGitActivityIndicator
          spacePath={spacePath}
          loading={loading || refreshing}
        />
      </span>
    ),
    lfsActivity:
      !cloning && lfsState === "pulling" ? (
        <div className="flex items-center gap-1.5 px-2 pb-1">
          <Loader2 className="animate-spin text-muted-foreground" />
          <p className="truncate text-[10px] text-muted-foreground">
            {m.storage_repair_lfs_pulling()}
          </p>
        </div>
      ) : null,
    progress: cloning ? (
      <div className="px-2 pb-1">
        <Progress value={cloning.percent} className="h-1" />
        <p className="mt-0.5 truncate text-[10px] text-muted-foreground">
          {cloneProgressLabel(cloning)}
        </p>
      </div>
    ) : null,
  };
}
