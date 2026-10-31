import { useEffect, useMemo } from "react";
import {
  refreshGitStatus,
  useGitStore,
  useRepositoryIds,
} from "@/features/git";
import type { ChangesTarget } from "../model/scope";
import {
  sessionArea,
  sessionWorkSpaces,
  type SessionArea,
} from "../model/session-scope";

/**
 * The area of a session target over the current Git status and repository
 * of every Space its work touched; null for any other target. With `refresh`, the statuses
 * of the Spaces besides the session's own (which its control reads) are
 * read again.
 */
export function useSessionArea(
  target: ChangesTarget,
  refresh = true,
): SessionArea | null {
  const statuses = useGitStore((state) => state.statuses);
  const session = target.kind === "session" ? target : null;
  const repositories = useRepositoryIds(
    session ? sessionWorkSpaces(session) : [],
  );
  const spaces = session
    ? sessionWorkSpaces(session)
        .filter((spacePath) => spacePath !== session.spacePath)
        .join("\n")
    : "";
  useEffect(() => {
    if (!refresh) return;
    for (const spacePath of spaces.split("\n").filter(Boolean)) {
      void refreshGitStatus(spacePath);
    }
  }, [refresh, spaces]);
  return useMemo(
    () => (session ? sessionArea(session, statuses, repositories) : null),
    [session, statuses, repositories],
  );
}
