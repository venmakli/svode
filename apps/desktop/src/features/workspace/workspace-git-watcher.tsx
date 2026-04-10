import { useGitWatch } from "./use-git-watch";

/** Render-less component that wires git status refresh for one workspace path. */
export function WorkspaceGitWatcher({ workspacePath }: { workspacePath: string }) {
  useGitWatch(workspacePath);
  return null;
}
