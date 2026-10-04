import {
  NewSessionSidebarItem,
  useAgentSessionSpace,
  useResolvedAgentSession,
  type NewSessionSpaceRef,
} from "@/features/agent-sessions";
import { useActiveContentSelection } from "@/features/artifact";
import { useSpace } from "@/features/space";
import { useShellStore } from "./model";
import { useStartSessionInMainArea } from "./agent-session-peek-host";

/** "New session" of the main sidebar. */
export function NewSessionSidebarRow() {
  const space = useNewSessionSpace();
  const startSession = useStartSessionInMainArea();
  return (
    <NewSessionSidebarItem
      space={space}
      onStart={(scope) => void startSession(scope)}
    />
  );
}

/**
 * The Space of the main area object, a session's own Space included; the
 * project root while the main area is empty or shows the Graph. An open peek
 * does not change it.
 */
function useNewSessionSpace(): NewSessionSpaceRef | null {
  const mainSurface = useShellStore((state) => state.mainSurface);
  const sessionTarget = useShellStore((state) =>
    state.mainSurface === "session" ? state.mainSessionTarget : null,
  );
  const session = useResolvedAgentSession(sessionTarget);
  const sessionSpace = useAgentSessionSpace(session);
  const { selection } = useActiveContentSelection();
  const rootId = useSpace((state) => state.activeRootId);

  if (mainSurface === "session") {
    return sessionSpace ? { spaceId: sessionSpace.spaceId } : null;
  }
  if (mainSurface !== "content" || !selection) return { spaceId: null };
  const spaceId =
    selection.kind === "artifact"
      ? selection.request.intent.target.spaceId
      : selection.request.owner.spaceId;
  return { spaceId: spaceId && spaceId !== rootId ? spaceId : null };
}
