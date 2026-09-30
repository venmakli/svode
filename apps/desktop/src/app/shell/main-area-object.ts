import {
  agentSessionNavigationKey,
  useResolvedAgentSession,
  type AgentSession,
  type AgentSessionTarget,
} from "@/features/agent-sessions";
import {
  useActiveContentSelection,
  type ActiveContentSelection,
} from "@/features/artifact";
import {
  artifactNavigationKey,
  spaceNavigationKey,
  type NavigationItem,
} from "@/features/navigation";
import { useSpace } from "@/features/space";
import { useShellStore } from "./model";

/**
 * The one object of the main area as navigation sees it. A Space is its main
 * page; an artifact carries a title from its path until its source is read.
 */
export type MainAreaObject =
  | { kind: "space"; item: NavigationItem }
  | { kind: "artifact"; item: NavigationItem }
  | {
      kind: "session";
      item: NavigationItem;
      session: AgentSession;
      target: AgentSessionTarget;
    };

/**
 * The object shown in the main area, or null while it is empty, shows the
 * Graph or the Sessions screen, or shows a session the catalog does not list.
 */
export function useMainAreaObject(): MainAreaObject | null {
  const mainSurface = useShellStore((state) => state.mainSurface);
  const sessionTarget = useShellStore((state) =>
    state.mainSurface === "session" ? state.mainSessionTarget : null,
  );
  const session = useResolvedAgentSession(sessionTarget);
  const { selection } = useActiveContentSelection();
  const rootId = useSpace((state) => state.activeRootId);
  const rootName = useSpace((state) => state.activeRootName);
  const spaces = useSpace((state) => state.spaces);

  if (mainSurface === "session") {
    if (!sessionTarget || !session) return null;
    return {
      kind: "session",
      item: { key: agentSessionNavigationKey(session), title: session.title },
      session,
      target: sessionTarget,
    };
  }
  if (mainSurface !== "content" || !selection) return null;
  const spaceName = (spaceId: string | null) =>
    (spaceId && spaceId !== rootId
      ? spaces.find((space) => space.id === spaceId)?.name
      : rootName) ?? "";
  return contentObject(selection, rootId, spaceName);
}

function contentObject(
  selection: ActiveContentSelection,
  rootId: string | null,
  spaceName: (spaceId: string | null) => string,
): MainAreaObject {
  if (selection.kind === "artifact") {
    const target = selection.request.intent.target;
    const page =
      target.sourceShape === "directory" || /\.md$/i.test(target.path);
    return {
      kind: "artifact",
      item: {
        key: artifactNavigationKey(
          page ? "page" : "attachment",
          target.path,
          target.spaceId,
          rootId,
        ),
        title: pathTitle(target.path),
      },
    };
  }
  const owner = selection.request.owner;
  if (owner.kind === "space") {
    return {
      kind: "space",
      item: {
        key: spaceNavigationKey(owner.spaceId, rootId),
        title: spaceName(owner.spaceId),
      },
    };
  }
  return {
    kind: "artifact",
    item: {
      key: artifactNavigationKey(
        owner.kind === "collection" ? "collection" : "app",
        owner.path,
        owner.spaceId,
        rootId,
      ),
      title: pathTitle(owner.path),
    },
  };
}

/** The last segment of a path without a Markdown extension or README. */
function pathTitle(path: string): string {
  const segments = path.split("/").filter(Boolean);
  const last = segments.at(-1) ?? path;
  const name = /^readme\.md$/i.test(last) ? (segments.at(-2) ?? last) : last;
  return name.replace(/\.md$/i, "");
}
