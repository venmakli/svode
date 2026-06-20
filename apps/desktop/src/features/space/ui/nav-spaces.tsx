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
import * as m from "@/paraglide/messages.js";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Checkbox } from "@/components/ui/checkbox";
import {
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarMenu,
} from "@/components/ui/sidebar";
import { useSpaceSidebarActions } from "../hooks/use-space-sidebar-actions";
import { hasRecordKey, visibleScopeChildren } from "../lib/nav-space-tree";
import { CreateSpaceDialog } from "./create-space-dialog";
import { RootScopeRow } from "./root-scope-row";
import { SpaceRow } from "./space-row";

interface NavSpacesProps {
  onActivateContent: () => void;
  onOpenSpaceSettings: (spacePath: string) => void;
}

export function NavSpaces({
  onActivateContent,
  onOpenSpaceSettings,
}: NavSpacesProps) {
  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: { distance: 6 },
    }),
  );
  const {
    activeDocument,
    activeDocumentSpaceId,
    activeRootIcon,
    activeRootId,
    activeRootName,
    activeRootPath,
    createDialogOpen,
    deleteFiles,
    deleteTarget,
    editRef,
    editingSpaceId,
    editValue,
    ensureTreeLoaded,
    fileTrees,
    handleCloneMissing,
    handleDeleteSpace,
    handleNewCollection,
    handleNewFolder,
    handleNewPage,
    handleOpenRootHome,
    handleOpenSpaceHome,
    handleRemoveBroken,
    handleRenameSpace,
    handleRootOpenChange,
    handleSpaceDragEnd,
    loadTreeChildren,
    rootHomeActive,
    rootOpen,
    setCreateDialogOpen,
    setDeleteFiles,
    setDeleteTarget,
    setEditingSpaceId,
    setEditValue,
    spaces,
    treeLoading,
    treeRefreshing,
  } = useSpaceSidebarActions({ onActivateContent });

  if (!activeRootId || !activeRootPath) return null;

  const rootTree = fileTrees[activeRootId] ?? [];
  const childSpaceIds = spaces.map((space) => space.id);

  return (
    <>
      <SidebarGroup>
        <SidebarGroupLabel>{m.sidebar_content()}</SidebarGroupLabel>
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
              onAddSpace={() => setCreateDialogOpen(true)}
              onProjectSettings={() => onOpenSpaceSettings(activeRootPath)}
              spaceId={activeRootId}
              rootPath={activeRootPath}
              loading={treeLoading[activeRootId] ?? false}
              refreshing={treeRefreshing[activeRootId] ?? false}
              treeLoaded={hasRecordKey(fileTrees, activeRootId)}
              loadTreeChildren={loadTreeChildren}
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
                    activeDocumentSpaceId === space.id &&
                    (!activeDocument ||
                      activeDocument.toLowerCase() === "readme.md");
                  return (
                    <SpaceRow
                      key={space.id}
                      ws={space}
                      isActive={isActive}
                      tree={visibleScopeChildren(tree)}
                      editingSpaceId={editingSpaceId}
                      editValue={editValue}
                      setEditValue={setEditValue}
                      setEditingSpaceId={setEditingSpaceId}
                      handleRenameSpace={handleRenameSpace}
                      handleNewPage={handleNewPage}
                      handleNewFolder={handleNewFolder}
                      handleNewCollection={handleNewCollection}
                      openSpaceSettings={onOpenSpaceSettings}
                      openScopeHome={handleOpenSpaceHome}
                      setDeleteTarget={setDeleteTarget}
                      handleCloneMissing={handleCloneMissing}
                      handleRemoveBroken={handleRemoveBroken}
                      ensureTreeLoaded={ensureTreeLoaded}
                      loadTreeChildren={loadTreeChildren}
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

      <CreateSpaceDialog
        open={createDialogOpen}
        onOpenChange={setCreateDialogOpen}
      />

      <AlertDialog
        open={!!deleteTarget}
        onOpenChange={(open) => {
          if (!open) {
            setDeleteTarget(null);
            setDeleteFiles(false);
          }
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{m.space_delete_title()}</AlertDialogTitle>
            <AlertDialogDescription>
              {m.space_delete_description()}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <label className="flex cursor-pointer items-center gap-2 py-2">
            <Checkbox
              checked={deleteFiles}
              onCheckedChange={(checked) => setDeleteFiles(checked === true)}
            />
            <span className="text-sm text-destructive">
              {m.space_delete_files()}
            </span>
          </label>
          <AlertDialogFooter>
            <AlertDialogCancel>{m.project_cancel()}</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={() => deleteTarget && handleDeleteSpace(deleteTarget.id)}
            >
              {m.space_delete()}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
