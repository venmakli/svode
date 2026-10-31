import { useMemo } from "react";
import type { ChangesTarget } from "@/features/changes";
import { useSpace } from "@/features/space";
import { useSessionWork } from "../chat/hooks/use-session-work";
import { sessionChangesTarget } from "../chat/model/session-work";
import type { AgentSession } from "../model";

export interface AgentSessionSpace {
  /** Registered child Space id; null for the project root. */
  spaceId: string | null;
  spacePath: string;
  name: string;
  ready: boolean;
}

/** The registered Space a session belongs to, as the rest of the shell names it. */
export function useAgentSessionSpace(
  session: AgentSession | null,
): AgentSessionSpace | null {
  const activeRootName = useSpace((state) => state.activeRootName);
  const activeRootPath = useSpace((state) => state.activeRootPath);
  const spaces = useSpace((state) => state.spaces);
  if (!session) return null;

  if (session.scopeKind === "space") {
    const space = spaces.find(
      (item) => item.id === session.spaceId || item.path === session.spacePath,
    );
    const spacePath = space?.path ?? session.spacePath;
    if (!spacePath) return null;
    return {
      spaceId: space?.id ?? session.spaceId ?? null,
      spacePath,
      name: space?.name ?? spacePath,
      ready: space?.status === "ready",
    };
  }

  const spacePath = session.projectPath ?? activeRootPath;
  if (!spacePath) return null;
  return {
    spaceId: null,
    spacePath,
    name: activeRootName ?? spacePath,
    ready: true,
  };
}

/**
 * The "Changes" of a session once its Space is ready: while a chat shows it,
 * the area of its work (Stage 11 1.7) — the files its turns changed in the
 * project's Spaces; otherwise, as for a terminal session, its Space.
 */
export function useAgentSessionChangesTarget(
  session: AgentSession | null,
): ChangesTarget | null {
  const space = useAgentSessionSpace(session);
  const projectPath = useSpace((state) => state.activeRootPath);
  const rootSpaces = useSpace((state) => state.rootSpaces);
  const spaces = useSpace((state) => state.spaces);
  const sessionId = session?.id;
  const work = useSessionWork(sessionId);
  const ready = Boolean(space?.ready && projectPath);
  const spaceId = space?.spaceId ?? null;
  const spacePath = space?.spacePath ?? "";
  const name = space?.name ?? "";
  return useMemo(() => {
    if (!ready || !projectPath) return null;
    return sessionChangesTarget(
      {
        kind: spaceId ? "space" : "project",
        sourceShape: "directory",
        spacePath,
        projectPath,
        path: "",
        name,
      },
      work,
      [...rootSpaces, ...spaces],
      sessionId,
    );
  }, [
    ready,
    projectPath,
    spaceId,
    spacePath,
    name,
    work,
    rootSpaces,
    spaces,
    sessionId,
  ]);
}
