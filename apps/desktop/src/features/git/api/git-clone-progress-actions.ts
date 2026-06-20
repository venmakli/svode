import { useGitStore, type GitCloneProgress } from "../model";

export function setSpaceCloneProgress(
  spacePath: string,
  progress: GitCloneProgress | null,
): void {
  useGitStore.getState().setCloning(spacePath, progress);
}
