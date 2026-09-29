import { useCallback, type ReactNode } from "react";
import {
  Box,
  Database,
  File,
  FileText,
  FolderClosed,
  PanelsTopLeft,
} from "lucide-react";
import {
  AgentSessionNavigationItem,
  agentSessionTargetFor,
} from "@/features/agent-sessions";
import {
  openArtifact,
  openScopeOwner,
  useActiveContentSelection,
} from "@/features/artifact";
import {
  NavigationSidebarGroup,
  NavigationSidebarItem,
  PinMenuItem,
  artifactNavigationKey,
  navigationKeyId,
  spaceNavigationKey,
  useNavigationState,
  type NavigationKey,
  type NavigationPinnedItem,
} from "@/features/navigation";
import { openPage } from "@/features/page/navigation";
import { useSpace } from "@/features/space";
import { useShellStore } from "./model";
import { useOpenSessionInMainArea } from "./agent-session-peek-host";
import * as m from "@/paraglide/messages.js";

interface PinnedSidebarSectionProps {
  onActivateContent: () => void;
  onBeforeNavigation: () => Promise<boolean>;
}

/**
 * "Pinned" of the main sidebar: pinned artifacts and sessions in pin order,
 * opened in the main area. Hidden while nothing is pinned.
 */
export function PinnedSidebarSection({
  onActivateContent,
  onBeforeNavigation,
}: PinnedSidebarSectionProps) {
  const pinned = useNavigationState((state) => state.pinned);
  const mainTarget = useShellStore((state) =>
    state.mainSurface === "session" ? state.mainSessionTarget : null,
  );
  const mainKeyId = useMainAreaArtifactKeyId();
  const openArtifactItem = useOpenPinnedArtifact({
    onActivateContent,
    onBeforeNavigation,
  });
  const openSession = useOpenSessionInMainArea();

  if (pinned.length === 0) return null;

  return (
    <NavigationSidebarGroup id="pinned" label={m.navigation_pinned()}>
      {pinned.map((item) => {
        const id = navigationKeyId(item.key);
        const menu = <PinMenuItem item={item} />;
        if (item.key.kind === "session" || item.key.kind === "sessionLaunch") {
          return (
            <AgentSessionNavigationItem
              key={id}
              navigationKey={item.key}
              fallbackTitle={item.title}
              mainTarget={mainTarget}
              onOpen={(session) =>
                void openSession(agentSessionTargetFor(session), session)
              }
              menu={menu}
            />
          );
        }
        return (
          <PinnedArtifactItem
            key={id}
            item={item}
            active={mainKeyId === id}
            onOpen={() => void openArtifactItem(item)}
            menu={menu}
          />
        );
      })}
    </NavigationSidebarGroup>
  );
}

function PinnedArtifactItem({
  item,
  active,
  onOpen,
  menu,
}: {
  item: NavigationPinnedItem;
  active: boolean;
  onOpen: () => void;
  menu: ReactNode;
}) {
  const spaceName = usePinnedSpaceName(item.key);
  return (
    <NavigationSidebarItem
      title={item.title}
      icon={<PinnedArtifactIcon item={item} />}
      tooltip={spaceName ? <span>{spaceName}</span> : null}
      active={active}
      unavailable={item.available === false}
      onOpen={onOpen}
      menu={menu}
    />
  );
}

function PinnedArtifactIcon({ item }: { item: NavigationPinnedItem }) {
  if (item.icon)
    return <span className="text-sm leading-none">{item.icon}</span>;
  switch (item.key.kind) {
    case "space":
      return item.key.spaceId ? <FolderClosed /> : <Box />;
    case "collection":
      return <Database />;
    case "app":
      return <PanelsTopLeft />;
    case "attachment":
      return <File />;
    default:
      return <FileText />;
  }
}

/** The Space an artifact lives in; a Space names no other. */
function usePinnedSpaceName(key: NavigationKey): string | null {
  const rootName = useSpace((state) => state.activeRootName);
  const spaces = useSpace((state) => state.spaces);
  if (key.kind === "space" || key.kind === "session") return null;
  if (key.kind === "sessionLaunch") return null;
  if (!key.spaceId) return rootName;
  return spaces.find((space) => space.id === key.spaceId)?.name ?? null;
}

/** Identity of the artifact or Space shown in the main area, if any. */
function useMainAreaArtifactKeyId(): string | null {
  const mainSurface = useShellStore((state) => state.mainSurface);
  const { selection } = useActiveContentSelection();
  const rootId = useSpace((state) => state.activeRootId);
  if (mainSurface !== "content" || !selection) return null;
  if (selection.kind === "artifact") {
    const target = selection.request.intent.target;
    return navigationKeyId(
      artifactNavigationKey("page", target.path, target.spaceId, rootId),
    );
  }
  const owner = selection.request.owner;
  return navigationKeyId(
    owner.kind === "space"
      ? spaceNavigationKey(owner.spaceId, rootId)
      : artifactNavigationKey("page", owner.path, owner.spaceId, rootId),
  );
}

/**
 * Opens a pinned artifact or Space as the main area object, as the tree
 * does: after the navigation guard, in its Space, without revealing it in the
 * tree.
 */
function useOpenPinnedArtifact({
  onActivateContent,
  onBeforeNavigation,
}: PinnedSidebarSectionProps) {
  const activeRootId = useSpace((state) => state.activeRootId);
  const activeSpaceId = useSpace((state) => state.activeSpaceId);
  const openSpace = useSpace((state) => state.openSpace);
  const clearActiveSpace = useSpace((state) => state.clearActiveSpace);

  return useCallback(
    async (item: NavigationPinnedItem) => {
      const key = item.key;
      if (key.kind === "session" || key.kind === "sessionLaunch") return;
      if (!activeRootId || !(await onBeforeNavigation())) return;
      onActivateContent();
      const spaceId = key.spaceId ?? activeRootId;
      if (!key.spaceId) {
        if (activeSpaceId) clearActiveSpace();
      } else if (activeSpaceId !== key.spaceId) {
        void openSpace(key.spaceId);
      }
      if (key.kind === "space") {
        openScopeOwner({ kind: "space", spaceId });
        return;
      }
      const path = item.openPath ?? key.path;
      if (key.kind === "collection") {
        openScopeOwner({ kind: "collection", path, spaceId });
      } else if (key.kind === "app") {
        openScopeOwner({ kind: "app-directory", path, spaceId });
      } else if (key.kind === "attachment") {
        openArtifact({ path, spaceId, sourceShape: "file" });
      } else {
        openPage(path, spaceId);
      }
    },
    [
      activeRootId,
      activeSpaceId,
      clearActiveSpace,
      onActivateContent,
      onBeforeNavigation,
      openSpace,
    ],
  );
}
