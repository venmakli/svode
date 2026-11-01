import type { ReactNode } from "react";
import { useGitAvailability } from "../hooks/use-git-availability";
import { GitMissingDialog } from "./git-missing-dialog";

interface GitGateProps {
  /** Shown while Git is checked and behind the dialog when it is unusable. */
  fallback: ReactNode;
  /**
   * The screens that need Git, mounted only once a supported Git is found.
   * `recheckGit` lets them hand a Git refusal back to this check.
   */
  children: (recheckGit: () => Promise<void>) => ReactNode;
}

/**
 * Git is checked before anything that needs it: a missing or too old Git
 * blocks the window with its dialog until "Check again" finds a supported one.
 */
export function GitGate({ fallback, children }: GitGateProps) {
  const { available, availability, recheck } = useGitAvailability();

  if (available === true) return children(recheck);

  return (
    <>
      {fallback}
      <GitMissingDialog
        open={available === false}
        availability={availability}
        onRecheck={recheck}
      />
    </>
  );
}
