import { useState } from "react";
import {
  ContentHeaderMenu,
  contentActionGroups,
} from "@/features/content-actions";
import { RepositoryAccessPreflightDialog } from "@/features/git";
import { useSpaceSidebarGit } from "@/features/git/sidebar";
import type { NavigationItem } from "@/features/navigation";
import { useRequestSpaceRename } from "../hooks/use-request-space-rename";
import type { DeleteSpaceTarget } from "../hooks/use-space-sidebar-dialog-state";
import { useSpaceScopeActions } from "../hooks/use-space-scope-actions";
import { useSpaceStore } from "../model";
import { SpaceDeleteDialog } from "./space-delete-dialog";

interface SpaceHomeActionsProps {
  spaceId: string;
  spacePath: string;
  projectPath: string;
  pinItem: NavigationItem;
  readOnly?: boolean;
  /** Leaves the open home page before an action opens another object. */
  onBeforeNavigation?: () => Promise<boolean>;
}

const noop = () => undefined;

function useScopeCreateHandlers({
  spaceId,
  spacePath,
  projectPath,
  onBeforeNavigation,
}: SpaceHomeActionsProps) {
  const reloadTreeParent = useSpaceStore((state) => state.reloadTreeParent);
  const { handleNewCollection, handleNewFolder, handleNewPage } =
    useSpaceScopeActions({
      activeRootPath: projectPath,
      onActivateContent: noop,
      onBeforeNavigation,
      reloadTreeParent,
    });
  const scope = { id: spaceId, path: spacePath };
  return {
    "new-page": () => void handleNewPage(scope),
    "new-folder": () => void handleNewFolder(scope),
    "new-collection": () => void handleNewCollection(scope),
  };
}

/**
 * The header menu of a Space home page: the actions of its sidebar row
 * except sessions and terminals. Rename edits the name in the sidebar row.
 */
export function SpaceHomeActions(props: SpaceHomeActionsProps) {
  const { spaceId, spacePath, projectPath, pinItem, readOnly } = props;
  const createHandlers = useScopeCreateHandlers(props);
  const { dirty, commitAll, recovery } = useSpaceSidebarGit(
    spacePath,
    projectPath,
  );
  const requestRename = useRequestSpaceRename();
  const space = useSpaceStore((state) =>
    state.spaces.find((item) => item.id === spaceId),
  );
  const [deleteTarget, setDeleteTarget] = useState<DeleteSpaceTarget | null>(
    null,
  );

  return (
    <>
      <ContentHeaderMenu
        groups={contentActionGroups({
          object: { kind: "space", unsavedChanges: dirty },
          readOnly,
        })}
        pinItem={pinItem}
        handlers={{
          ...createHandlers,
          "save-all": commitAll,
          rename: () => requestRename(spaceId),
          "remove-space": () =>
            setDeleteTarget({ id: spaceId, name: space?.name ?? "" }),
        }}
      />
      <RepositoryAccessPreflightDialog recovery={recovery} />
      <SpaceDeleteDialog
        target={deleteTarget}
        onClose={() => setDeleteTarget(null)}
      />
    </>
  );
}

/** The header menu of the project root's home page. */
export function ProjectRootHomeActions(props: SpaceHomeActionsProps) {
  const createHandlers = useScopeCreateHandlers(props);
  return (
    <ContentHeaderMenu
      groups={contentActionGroups({
        object: { kind: "project-root" },
        readOnly: props.readOnly,
      })}
      pinItem={props.pinItem}
      handlers={createHandlers}
    />
  );
}
