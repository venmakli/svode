import { useCallback, useMemo, useState } from "react";
import { useShallowStableArray } from "@/shared/hooks/use-shallow-stable-array";
import { DndContext, DragOverlay } from "@dnd-kit/core";
import { SortableContext } from "@dnd-kit/sortable";
import { FileText } from "lucide-react";
import {
  useActiveContentOpenedFromSidebar,
  useActiveContentPath,
  useActiveContentShown,
  useActiveContentSpaceId,
} from "@/features/artifact";
import { SidebarMenuSub } from "@/components/ui/sidebar";
import type { TreeNode } from "../model/types";
import { useSpaceStore } from "../model";
import { useTreeRenameRequest } from "../model/tree-rename-request";
import { useSortableFileTreeDnd } from "../hooks/use-sortable-file-tree-dnd";
import { useVirtualFileTree } from "../hooks/use-virtual-file-tree";
import {
  buildFileTreeRows,
  treeNodeActivatable,
} from "../lib/file-tree-rows";
import { FileTreeItem, TreeChildLoadingRow } from "./file-tree-item";

const NO_EXPANDED_PATHS: string[] = [];

interface SortableFileTreeProps {
  spaceId: string;
  tree: TreeNode[];
  loadTreeChildren: (
    spaceId: string,
    parentPath?: string | null,
  ) => Promise<void>;
  onActivateContent?: () => void;
  onBeforeNavigation?: () => Promise<boolean>;
  projectPath: string;
  spacePath: string;
}

/**
 * The content tree of one Space: a flat list of its visible rows, of which
 * only those in the visible area of the sidebar are mounted, with DnD.
 */
export function SortableFileTree({
  spaceId,
  tree: treeProp,
  loadTreeChildren,
  onActivateContent,
  onBeforeNavigation,
  projectPath,
  spacePath,
}: SortableFileTreeProps) {
  const tree = useShallowStableArray(treeProp);
  const expandedPaths = useSpaceStore(
    (state) => state.expandedPaths[spaceId] ?? NO_EXPANDED_PATHS,
  );
  const loadingParents = useSpaceStore(
    (state) => state.treeParentLoading[spaceId],
  );
  const expandedSet = useMemo(() => new Set(expandedPaths), [expandedPaths]);
  const rows = useMemo(
    () => buildFileTreeRows(tree, expandedSet, loadingParents),
    [expandedSet, loadingParents, tree],
  );

  const {
    activeId,
    activeNode,
    handleDragCancel,
    handleDragEnd,
    handleDragMove,
    handleDragOver,
    handleDragStart,
    collisionDetection,
    rowDndState,
    sensors,
    sortableIds,
  } = useSortableFileTreeDnd({
    spaceId,
    tree,
    expandedSet,
    nodeByPath: rows.nodeByPath,
  });

  const activeContentPath = useActiveContentPath();
  const activeContentSpaceId = useActiveContentSpaceId();
  const contentShown = useActiveContentShown();
  const openedFromSidebar = useActiveContentOpenedFromSidebar();
  const activeNodePath =
    contentShown && activeContentSpaceId === spaceId ? activeContentPath : null;
  const activeTreeNode =
    activeNodePath === null ? undefined : rows.nodeByPath.get(activeNodePath);
  const activeRowPath =
    activeTreeNode && treeNodeActivatable(activeTreeNode)
      ? activeTreeNode.path
      : null;

  const renameTarget = useTreeRenameRequest((state) =>
    state.target?.spaceId === spaceId ? state.target.path : null,
  );
  // The row clears the request as it takes it, so its path stays kept
  // until the row holds the rename itself and lets it go.
  const [requestedRename, setRequestedRename] = useState<string | null>(null);
  if (renameTarget !== null && renameTarget !== requestedRename) {
    setRequestedRename(renameTarget);
  }
  const [rowsKeptMounted, setRowsKeptMounted] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const handleKeepMountedChange = useCallback(
    (path: string, keepMounted: boolean) => {
      if (!keepMounted) {
        setRequestedRename((current) => (current === path ? null : current));
      }
      setRowsKeptMounted((current) => {
        if (current.has(path) === keepMounted) return current;
        const next = new Set(current);
        if (keepMounted) next.add(path);
        else next.delete(path);
        return next;
      });
    },
    [],
  );
  const keepMountedPaths = useMemo(() => {
    const paths = [...rowsKeptMounted];
    // A requested rename is taken by its row, so the row has to exist.
    if (requestedRename) paths.push(requestedRename);
    // The drag source stays mounted while it is dragged out of view.
    if (activeId) paths.push(activeId);
    return paths;
  }, [activeId, requestedRename, rowsKeptMounted]);

  const { listRef, virtualizer, virtualItems, listHeight } =
    useVirtualFileTree({
      rows,
      keepMountedPaths,
      revealPath: activeRowPath,
      revealEnabled: !openedFromSidebar,
    });
  const scrollMargin = virtualizer.options.scrollMargin;

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={collisionDetection}
      onDragStart={handleDragStart}
      onDragMove={handleDragMove}
      onDragOver={handleDragOver}
      onDragEnd={handleDragEnd}
      onDragCancel={handleDragCancel}
    >
      <SortableContext items={sortableIds}>
        <div data-dnd-space={spaceId}>
          <SidebarMenuSub
            ref={listRef}
            className="ml-4 border-l-0 pl-2"
            style={{ position: "relative", height: listHeight }}
          >
            {virtualItems.map((item) => {
              const row = rows.rows[item.index];
              const offset = item.start - scrollMargin + row.spaceBefore;
              if (row.kind === "loading") {
                return (
                  <TreeChildLoadingRow
                    key={row.key}
                    depth={row.depth}
                    index={item.index}
                    position={row.index}
                    offset={offset}
                    measureRef={virtualizer.measureElement}
                  />
                );
              }
              const dnd = rowDndState(row.node.path);
              return (
                <FileTreeItem
                  key={row.key}
                  node={row.node}
                  depth={row.depth}
                  expandable={row.expandable}
                  expanded={row.expanded}
                  isActive={activeRowPath === row.node.path}
                  index={item.index}
                  offset={offset}
                  measureRef={virtualizer.measureElement}
                  onKeepMountedChange={handleKeepMountedChange}
                  sortableDisabled={dnd.sortableDisabled}
                  dropType={dnd.dropType}
                  dropRelativeDepth={dnd.dropRelativeDepth}
                  nestTarget={dnd.nestTarget}
                  spaceId={spaceId}
                  loadTreeChildren={loadTreeChildren}
                  onActivateContent={onActivateContent}
                  onBeforeNavigation={onBeforeNavigation}
                  projectPath={projectPath}
                  spacePath={spacePath}
                />
              );
            })}
          </SidebarMenuSub>
        </div>
      </SortableContext>
      <DragOverlay dropAnimation={null}>
        {activeNode && (
          <div className="flex items-center gap-2 rounded-md bg-sidebar-accent px-2 py-1.5 text-sm shadow-md opacity-80">
            {activeNode.icon ? (
              <span className="h-4 w-4 shrink-0 text-center leading-4">
                {activeNode.icon}
              </span>
            ) : (
              <FileText className="h-4 w-4 shrink-0" />
            )}
            <span className="truncate">{activeNode.title}</span>
          </div>
        )}
      </DragOverlay>
    </DndContext>
  );
}
