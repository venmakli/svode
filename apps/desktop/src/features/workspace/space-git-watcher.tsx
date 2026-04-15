import { useGitWatch } from "./use-git-watch";

/** Render-less component that wires git status refresh for one space path. */
export function SpaceGitWatcher({ spacePath }: { spacePath: string }) {
  useGitWatch(spacePath);
  return null;
}
