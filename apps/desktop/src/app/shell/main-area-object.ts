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
  navigationKeyId,
  pathNavigationKey,
  spaceNavigationKey,
  useNavigationItemDisplay,
  type NavigationItem,
} from "@/features/navigation";
import { useSpace } from "@/features/space";
import { itemNavigationKey } from "./item-navigation";
import { useShellStore } from "./model";

/**
 * The one object of the main area as navigation sees it. A Space is its main
 * page; an artifact carries a title from its path until its source is read;
 * an item of a fixed Collection expanded over its owner carries the name its
 * screen shows, empty until its source is read (`shown`).
 */
export type MainAreaObject =
  | { kind: "space"; item: NavigationItem }
  | { kind: "artifact"; item: NavigationItem }
  | { kind: "item"; item: NavigationItem; shown: boolean }
  | {
      kind: "session";
      item: NavigationItem;
      session: AgentSession;
      target: AgentSessionTarget;
    };

/**
 * The object shown in the main area, or null while it is empty, shows the
 * Graph, or shows a session the catalog does not list.
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
  const itemKey =
    mainSurface === "content" &&
    selection?.kind === "scope-owner" &&
    selection.request.intent.kind === "item"
      ? itemNavigationKey(
          selection.request.owner,
          selection.request.intent.item,
          rootId,
        )
      : null;
  const itemDisplay = useNavigationItemDisplay(
    itemKey ? navigationKeyId(itemKey) : "",
  );

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
  if (itemKey) {
    return {
      kind: "item",
      item: { key: itemKey, title: itemDisplay?.title ?? "" },
      shown: itemDisplay !== undefined,
    };
  }
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
        key: pathNavigationKey(
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
      key: pathNavigationKey(
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
