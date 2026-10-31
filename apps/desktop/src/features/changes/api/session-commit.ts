import { useGitStore } from "@/features/git";
import {
  commitPathsAndMaybeSync,
  explicitCommitRefusal,
  type GitCommitRefusal,
} from "@/features/git/editor";
import type { ChangesTarget } from "../model/scope";
import { sessionArea, sessionAreaParts } from "../model/session-scope";

/**
 * Commit the uncommitted work of a chat session (Stage 11 1.7): only the
 * paths of its area, Space by Space; the backend splits each into version
 * groups. A Page holding a source conflict in one of those Spaces refuses.
 */
export async function commitSessionArea(
  target: ChangesTarget,
): Promise<GitCommitRefusal | null> {
  const parts = sessionAreaParts(
    sessionArea(target, useGitStore.getState().statuses),
  );
  for (const part of parts) {
    const refusal = explicitCommitRefusal(part.spacePath, {
      kind: "space",
      path: "",
      label: "space",
    });
    if (refusal) return refusal;
  }
  for (const part of parts) {
    await commitPathsAndMaybeSync(
      part.spacePath,
      part.paths,
      target.projectPath ?? undefined,
    );
  }
  return null;
}
