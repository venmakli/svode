import * as m from "@/paraglide/messages.js";
import { Progress } from "@/components/ui/progress";
import {
  SpaceGitActivityIndicator,
  useSpaceSidebarGit,
  type SpaceSidebarGitCloneProgress,
} from "@/features/git/sidebar";
import type { LfsMissing, LfsState, LfsUnsent } from "../model";
import { RepositoryAccessPreflightDialog } from "@/features/git";
import { LfsIndicatorIcon } from "./nav-space-indicators";

interface SpaceRowGitControlsProps {
  lfsState: LfsState;
  lfsMissing: LfsMissing | null;
  lfsUnsent: LfsUnsent | null;
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
  lfsMissing,
  lfsUnsent,
  loading,
  refreshing,
  rootPath,
  spacePath,
}: SpaceRowGitControlsProps) {
  const { cloning, dirty, commitAll, recovery } = useSpaceSidebarGit(
    spacePath,
    rootPath,
  );

  return {
    cloning,
    commitAll,
    dirty,
    inlineActivity: (
      <span className="ml-auto flex items-center gap-1">
        <LfsIndicatorIcon
          lfsState={lfsState}
          lfsMissing={lfsMissing}
          lfsUnsent={lfsUnsent}
          spacePath={spacePath}
        />
        <SpaceGitActivityIndicator
          spacePath={spacePath}
          loading={loading || refreshing}
        />
      </span>
    ),
    progress: (
      <>
        <RepositoryAccessPreflightDialog recovery={recovery} />
        {cloning ? (
          <div className="px-2 pb-1">
            <Progress value={cloning.percent} className="h-1" />
            <p className="mt-0.5 truncate text-[10px] text-muted-foreground">
              {cloneProgressLabel(cloning)}
            </p>
          </div>
        ) : null}
      </>
    ),
  };
}
