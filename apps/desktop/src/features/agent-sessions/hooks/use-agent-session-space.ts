import { useSpace } from "@/features/space";
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
