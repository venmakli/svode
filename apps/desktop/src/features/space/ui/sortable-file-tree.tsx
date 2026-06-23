import { createContext, type ReactNode } from "react";
import { DndContext, DragOverlay, closestCenter } from "@dnd-kit/core";
import { SortableContext } from "@dnd-kit/sortable";
import { FileText } from "lucide-react";
import type { TreeNode } from "../model/types";
import {
  useSortableFileTreeDnd,
  type SortableFileTreeDndContextValue,
} from "../hooks/use-sortable-file-tree-dnd";

export const TreeDndContext = createContext<SortableFileTreeDndContextValue>({
  activeFolderPath: null,
  activeId: null,
  flatItems: [],
  flatItemsMap: new Map(),
  overId: null,
  projection: null,
});

interface SortableFileTreeProps {
  spaceId: string;
  tree: TreeNode[];
  children: ReactNode;
}

export function SortableFileTree({
  spaceId,
  tree,
  children,
}: SortableFileTreeProps) {
  const {
    activeNode,
    contextValue,
    handleDragCancel,
    handleDragEnd,
    handleDragMove,
    handleDragOver,
    handleDragStart,
    sensors,
    sortableIds,
  } = useSortableFileTreeDnd({ spaceId, tree });

  return (
    <TreeDndContext.Provider value={contextValue}>
      <DndContext
        sensors={sensors}
        collisionDetection={closestCenter}
        onDragStart={handleDragStart}
        onDragMove={handleDragMove}
        onDragOver={handleDragOver}
        onDragEnd={handleDragEnd}
        onDragCancel={handleDragCancel}
      >
        <SortableContext items={sortableIds}>
          <div data-dnd-space={spaceId}>{children}</div>
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
    </TreeDndContext.Provider>
  );
}
