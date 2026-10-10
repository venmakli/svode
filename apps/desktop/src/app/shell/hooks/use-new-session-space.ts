import {
  useAgentSessionSpace,
  useResolvedAgentSession,
  type NewSessionSpaceRef,
} from "@/features/agent-sessions";
import { useActiveContentSelection } from "@/features/artifact";
import { useSpace } from "@/features/space";
import { useShellStore } from "../model";

/**
 * The Space "New session" starts in: that of the main area object, a
 * session's or a new session draft's own Space included; the project root
 * while the main area is empty or shows the Graph. An open peek does not
 * change it.
 */
export function useNewSessionSpace(): NewSessionSpaceRef | null {
  const mainSurface = useShellStore((state) => state.mainSurface);
  const sessionTarget = useShellStore((state) =>
    state.mainSurface === "session" ? state.mainSessionTarget : null,
  );
  const draftSpacePath = useShellStore((state) =>
    state.mainSurface === "session"
      ? (state.mainSessionDraft?.spacePath ?? null)
      : null,
  );
  const session = useResolvedAgentSession(sessionTarget);
  const sessionSpace = useAgentSessionSpace(session);
  const { selection } = useActiveContentSelection();
  const rootId = useSpace((state) => state.activeRootId);
  const spaces = useSpace((state) => state.spaces);

  if (mainSurface === "session") {
    if (draftSpacePath !== null) {
      const space = spaces.find((item) => item.path === draftSpacePath);
      return { spaceId: space?.id ?? null };
    }
    return sessionSpace ? { spaceId: sessionSpace.spaceId } : null;
  }
  if (mainSurface !== "content" || !selection) return { spaceId: null };
  const spaceId =
    selection.kind === "artifact"
      ? selection.request.intent.target.spaceId
      : selection.request.owner.spaceId;
  return { spaceId: spaceId && spaceId !== rootId ? spaceId : null };
}
