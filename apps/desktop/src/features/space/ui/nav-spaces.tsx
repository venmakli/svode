import {
  DndContext,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import {
  SortableContext,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { ChevronsDownUp, ChevronsUpDown } from "lucide-react";
import * as m from "@/paraglide/messages.js";
import {
  SidebarGroup,
  SidebarGroupAction,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarMenu,
} from "@/components/ui/sidebar";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { useSpaceSidebarActions } from "../hooks/use-space-sidebar-actions";
import { getSpaceScopeActiveRevealKey } from "../hooks/use-space-scope-collapse";
import { hasRecordKey, visibleScopeChildren } from "../lib/nav-space-tree";
import { RootScopeRow } from "./root-scope-row";
import { SpaceDeleteDialog } from "./space-delete-dialog";
import { SpaceRow } from "./space-row";

interface NavSpacesProps {
  onActivateContent: () => void;
  onBeforeNavigation: () => Promise<boolean>;
  onNewSession?: (spacePath: string) => void;
  onNewTerminal?: (spacePath: string) => void;
}

export function NavSpaces({
  onActivateContent,
  onBeforeNavigation,
  onNewSession,
  onNewTerminal,
}: NavSpacesProps) {
  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: { distance: 6 },
    }),
  );
  const {
    activeContentPath,
    activeContentSpaceId,
    contentShown,
    activeRevealRequest,
    activeRootIcon,
    activeRootId,
    activeRootName,
    activeRootPath,
    deleteTarget,
    editRef,
    editingSpaceId,
    editValue,
    ensureTreeLoaded,
    fileTrees,
    handleCloneMissing,
    handleNewCollection,
    handleNewFolder,
    handleNewPage,
    handleOpenRootHome,
    handleOpenSpaceHome,
    handleRemoveBroken,
    handleRenameSpace,
    handleRootOpenChange,
    handleSidebarTreeExpansionToggle,
    handleSpaceDragEnd,
    loadTreeChildren,
    rootHomeActive,
    rootOpen,
    sidebarTreeExpansionAction,
    sidebarTreeExpansionLabel,
    getSidebarScopeCollapseState,
    setSidebarScopeCollapseState,
    setDeleteTarget,
    setEditingSpaceId,
    setEditValue,
    spaces,
    treeLoading,
    treeRefreshing,
  } = useSpaceSidebarActions({ onActivateContent, onBeforeNavigation });

  if (!activeRootId || !activeRootPath) return null;

  const rootTree = fileTrees[activeRootId] ?? [];
  const childSpaceIds = spaces.map((space) => space.id);

  return (
    <>
      <SidebarGroup>
        <SidebarGroupLabel className="group/space-header pr-8">
          <span className="truncate">{m.sidebar_content()}</span>
          <Tooltip>
            <TooltipTrigger asChild>
              <SidebarGroupAction
                aria-label={sidebarTreeExpansionLabel}
                className="size-5 text-sidebar-foreground/70 opacity-0 transition-opacity hover:bg-transparent hover:text-sidebar-foreground/70 group-hover/space-header:opacity-100 group-focus-within/space-header:opacity-100 focus-visible:opacity-100 [&>svg]:size-3"
                onClick={handleSidebarTreeExpansionToggle}
              >
                {sidebarTreeExpansionAction === "collapse" ? (
                  <ChevronsDownUp />
                ) : (
                  <ChevronsUpDown />
                )}
              </SidebarGroupAction>
            </TooltipTrigger>
            <TooltipContent side="right">
              {sidebarTreeExpansionLabel}
            </TooltipContent>
          </Tooltip>
        </SidebarGroupLabel>
        <SidebarGroupContent>
          <SidebarMenu>
            <RootScopeRow
              active={rootHomeActive}
              icon={activeRootIcon}
              name={activeRootName}
              open={rootOpen}
              tree={visibleScopeChildren(rootTree)}
              onOpenChange={handleRootOpenChange}
              onOpenHome={handleOpenRootHome}
              onNewPage={() =>
                handleNewPage({ id: activeRootId, path: activeRootPath })
              }
              onNewFolder={() =>
                handleNewFolder({ id: activeRootId, path: activeRootPath })
              }
              onNewCollection={() =>
                handleNewCollection({ id: activeRootId, path: activeRootPath })
              }
              onNewSession={
                onNewSession && (() => onNewSession(activeRootPath))
              }
              onNewTerminal={
                onNewTerminal && (() => onNewTerminal(activeRootPath))
              }
              spaceId={activeRootId}
              rootPath={activeRootPath}
              loading={treeLoading[activeRootId] ?? false}
              refreshing={treeRefreshing[activeRootId] ?? false}
              treeLoaded={hasRecordKey(fileTrees, activeRootId)}
              loadTreeChildren={loadTreeChildren}
              onActivateContent={onActivateContent}
              onBeforeNavigation={onBeforeNavigation}
            />
            <DndContext
              sensors={sensors}
              collisionDetection={closestCenter}
              onDragEnd={handleSpaceDragEnd}
            >
              <SortableContext
                items={childSpaceIds}
                strategy={verticalListSortingStrategy}
              >
                {spaces.map((space) => {
                  const tree = fileTrees[space.id] ?? [];
                  const treeLoaded = hasRecordKey(fileTrees, space.id);
                  const isActive =
                    contentShown &&
                    activeContentSpaceId === space.id &&
                    (!activeContentPath ||
                      activeContentPath.toLowerCase() === "readme.md");
                  const activeRevealKey = getSpaceScopeActiveRevealKey({
                    activeContentPath,
                    activeContentSpaceId,
                    activeRevealRequest,
                    scopeId: space.id,
                  });
                  return (
                    <SpaceRow
                      key={space.id}
                      ws={space}
                      isActive={isActive}
                      tree={visibleScopeChildren(tree)}
                      editingSpaceId={editingSpaceId}
                      editValue={editValue}
                      activeRevealKey={activeRevealKey}
                      setEditValue={setEditValue}
                      setEditingSpaceId={setEditingSpaceId}
                      handleRenameSpace={handleRenameSpace}
                      handleNewPage={handleNewPage}
                      handleNewFolder={handleNewFolder}
                      handleNewCollection={handleNewCollection}
                      onNewSession={onNewSession}
                      onNewTerminal={onNewTerminal}
                      openScopeHome={handleOpenSpaceHome}
                      setDeleteTarget={setDeleteTarget}
                      handleCloneMissing={handleCloneMissing}
                      handleRemoveBroken={handleRemoveBroken}
                      ensureTreeLoaded={ensureTreeLoaded}
                      scopeState={getSidebarScopeCollapseState(space.id)}
                      loadTreeChildren={loadTreeChildren}
                      onScopeStateChange={(state) =>
                        setSidebarScopeCollapseState(space.id, state)
                      }
                      onActivateContent={onActivateContent}
                      onBeforeNavigation={onBeforeNavigation}
                      editRef={editRef}
                      rootPath={activeRootPath}
                      loading={treeLoading[space.id] ?? false}
                      refreshing={treeRefreshing[space.id] ?? false}
                      treeLoaded={treeLoaded}
                    />
                  );
                })}
              </SortableContext>
            </DndContext>
          </SidebarMenu>
        </SidebarGroupContent>
      </SidebarGroup>

      <SpaceDeleteDialog
        target={deleteTarget}
        onClose={() => setDeleteTarget(null)}
      />
    </>
  );
}
