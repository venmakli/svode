import { useCallback, type ReactNode } from "react";
import {
  Box,
  Database,
  File,
  FileText,
  FolderClosed,
  PanelsTopLeft,
} from "lucide-react";
import { openArtifact, openScopeOwner } from "@/features/artifact";
import {
  NavigationSidebarItem,
  type NavigationKey,
  type NavigationResolvedItem,
} from "@/features/navigation";
import { openPage } from "@/features/page/navigation";
import { getSpaceSnapshot, useSpace } from "@/features/space";

interface NavigationOpenProps {
  onActivateContent: () => void;
  onBeforeNavigation: () => Promise<boolean>;
}

/** An artifact or Space row of a sidebar navigation section. */
export function NavigationArtifactItem({
  item,
  active,
  onOpen,
  menu,
  onClose,
  temporary,
  onKeep,
  pinned,
  spaceName: givenSpaceName,
}: {
  item: NavigationResolvedItem;
  active: boolean;
  onOpen: () => void;
  menu: ReactNode;
  onClose?: () => void;
  temporary?: boolean;
  onKeep?: () => void;
  pinned?: boolean;
  /** The Space of an artifact of another project than the open one. */
  spaceName?: string | null;
}) {
  const openProjectSpaceName = useNavigationSpaceName(item.key);
  const spaceName =
    givenSpaceName === undefined ? openProjectSpaceName : givenSpaceName;
  return (
    <NavigationSidebarItem
      title={item.title}
      icon={<NavigationArtifactIcon item={item} />}
      tooltip={spaceName ? <span>{spaceName}</span> : null}
      active={active}
      unavailable={item.available === false}
      onOpen={onOpen}
      menu={menu}
      onClose={onClose}
      temporary={temporary}
      onKeep={onKeep}
      pinned={pinned}
    />
  );
}

function NavigationArtifactIcon({ item }: { item: NavigationResolvedItem }) {
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
function useNavigationSpaceName(key: NavigationKey): string | null {
  const rootName = useSpace((state) => state.activeRootName);
  const spaces = useSpace((state) => state.spaces);
  if (key.kind === "space" || key.kind === "session") return null;
  if (key.kind === "sessionLaunch") return null;
  if (!key.spaceId) return rootName;
  return spaces.find((space) => space.id === key.spaceId)?.name ?? null;
}

/**
 * Opens an artifact or Space of the sidebar as the main area object, as the
 * tree does: after the navigation guard, in its Space, without revealing it
 * in the tree. The open project is read when it opens, so a project that has
 * just become active opens its own artifact.
 */
export function useOpenNavigationArtifact({
  onActivateContent,
  onBeforeNavigation,
}: NavigationOpenProps) {
  return useCallback(
    async (item: NavigationResolvedItem) => {
      const key = item.key;
      if (key.kind === "session" || key.kind === "sessionLaunch") return;
      if (!getSpaceSnapshot().activeRootId || !(await onBeforeNavigation())) {
        return;
      }
      const { activeRootId, activeSpaceId, openSpace, clearActiveSpace } =
        getSpaceSnapshot();
      if (!activeRootId) return;
      onActivateContent();
      const spaceId = key.spaceId ?? activeRootId;
      if (!key.spaceId) {
        if (activeSpaceId) clearActiveSpace();
      } else if (activeSpaceId !== key.spaceId) {
        void openSpace(key.spaceId);
      }
      if (key.kind === "space") {
        openScopeOwner({ kind: "space", spaceId }, { fromSidebar: true });
        return;
      }
      const path = item.openPath ?? key.path;
      if (key.kind === "collection") {
        openScopeOwner(
          { kind: "collection", path, spaceId },
          { fromSidebar: true },
        );
      } else if (key.kind === "app") {
        openScopeOwner(
          { kind: "app-directory", path, spaceId },
          { fromSidebar: true },
        );
      } else if (key.kind === "attachment") {
        openArtifact(
          { path, spaceId, sourceShape: "file" },
          { fromSidebar: true },
        );
      } else {
        openPage(path, spaceId, { fromSidebar: true });
      }
    },
    [onActivateContent, onBeforeNavigation],
  );
}
