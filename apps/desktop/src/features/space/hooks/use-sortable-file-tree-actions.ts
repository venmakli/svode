import { useCallback } from "react";
import type { DragEndEvent } from "@dnd-kit/core";
import { toast } from "sonner";
import { useEntrySelectionStore, type TreeNode } from "@/features/entry";
import { useEditorStore } from "@/features/editor/model";
import { nestTreeEntry, unnestTreeEntry } from "../api/tree-entry-actions";
import {
  getParentDir,
  isDescendantOf,
  type Projection,
} from "../lib/tree-dnd-utilities";
import { treeNodeHasChildren } from "../lib/tree-cache";
import {
  buildOrderMap,
  findParentTreeNode,
  findTreeNode,
} from "../lib/tree-node-queries";
import { useSpaceStore } from "../model";

interface UseSortableFileTreeActionsInput {
  spaceId: string;
  tree: TreeNode[];
  resetState: () => void;
}

export function useSortableFileTreeActions({
  spaceId,
  tree,
  resetState,
}: UseSortableFileTreeActionsInput) {
  const {
    moveEntry,
    saveOrder,
    reloadTreeParent,
    reloadTreeParents,
    reloadTreePathParent,
  } = useSpaceStore();

  return useCallback(
    async (event: DragEndEvent, currentProjection: Projection | null) => {
      resetState();

      const { active, over } = event;
      if (!over || active.id === over.id || !currentProjection) return;

      const state = useSpaceStore.getState();
      const space =
        state.spaces.find((item) => item.id === spaceId) ??
        state.rootSpaces.find((item) => item.id === spaceId);
      if (!space) return;

      const fromPath = active.id as string;
      const fromNode = findTreeNode(tree, fromPath);
      if (!fromNode) return;

      const fromFolderPath = treeNodeHasChildren(fromNode)
        ? fromPath.replace(/\/readme\.md$/i, "")
        : fromPath;
      if (isDescendantOf(currentProjection.parentPath, fromFolderPath)) {
        return;
      }

      const fromParent = treeNodeHasChildren(fromNode)
        ? getParentDir(fromPath.replace(/\/readme\.md$/i, ""))
        : getParentDir(fromPath);
      const toParent = currentProjection.parentPath;

      try {
        const { activeDocument, openDocument } =
          useEntrySelectionStore.getState();
        const { clearUnsaved, suppressPaths } = useEditorStore.getState();

        if (currentProjection.type === "child") {
          const targetNode = findTreeNode(tree, currentProjection.overPath);
          const targetIsBareFolder =
            targetNode && !targetNode.path.endsWith(".md");
          if (
            targetNode &&
            !treeNodeHasChildren(targetNode) &&
            !targetIsBareFolder
          ) {
            const nestTarget = currentProjection.overPath;
            const oldName = targetNode.name;
            suppressPaths([nestTarget, fromPath]);
            const newNestPath = await nestTreeEntry({
              spacePath: space.path,
              path: nestTarget,
              projectPath: useSpaceStore.getState().activeRootPath,
            });
            suppressPaths([newNestPath]);
            if (activeDocument === nestTarget) {
              clearUnsaved(nestTarget);
              openDocument(newNestPath, spaceId);
            }

            const newName = oldName.replace(/\.md$/i, "");
            if (newName !== oldName) {
              const order = buildOrderMap(tree);
              for (const siblings of Object.values(order)) {
                const index = siblings.indexOf(oldName);
                if (index !== -1) {
                  siblings[index] = newName;
                  break;
                }
              }
              await saveOrder(spaceId, order);
            }
            await reloadTreePathParent(spaceId, nestTarget);
            await reloadTreeParent(
              spaceId,
              newNestPath.replace(/\/readme\.md$/i, ""),
            );
          }
        }

        const currentTree = useSpaceStore.getState().fileTrees[spaceId] ?? tree;

        if (fromParent === toParent) {
          const overNode = findTreeNode(
            currentTree,
            currentProjection.overPath,
          );
          if (!overNode) return;

          const order = buildOrderMap(currentTree);
          const dirKey = toParent || ".";
          const siblings = order[dirKey];
          if (siblings) {
            const fromIndex = siblings.indexOf(fromNode.name);
            const overIndex = siblings.indexOf(overNode.name);
            if (
              fromIndex !== -1 &&
              overIndex !== -1 &&
              fromIndex !== overIndex
            ) {
              siblings.splice(fromIndex, 1);
              const adjustedIndex =
                fromIndex < overIndex ? overIndex - 1 : overIndex;
              siblings.splice(
                currentProjection.type === "after"
                  ? adjustedIndex + 1
                  : adjustedIndex,
                0,
                fromNode.name,
              );
              await saveOrder(spaceId, order);
              await reloadTreeParent(spaceId, toParent);
            }
          }
          return;
        }

        const oldParentTreeNode = fromParent
          ? findParentTreeNode(tree, fromPath)
          : null;
        const oldParentReadme = oldParentTreeNode?.path
          .toLowerCase()
          .endsWith("/readme.md")
          ? oldParentTreeNode.path
          : null;

        const isBareFolder = !fromPath.endsWith(".md");
        const isDocFolder = !isBareFolder && treeNodeHasChildren(fromNode);
        const movePath = isDocFolder
          ? fromPath.replace(/\/readme\.md$/i, "")
          : fromPath;

        if (activeDocument === fromPath) {
          clearUnsaved(fromPath);
        }

        suppressPaths([fromPath, movePath]);
        const newPath = await moveEntry(spaceId, movePath, toParent);
        if (newPath) suppressPaths([newPath]);

        if (activeDocument === fromPath && newPath && !isBareFolder) {
          const readmeFilename = fromPath.split("/").pop() ?? "README.md";
          const newDocPath = isDocFolder
            ? `${newPath}/${readmeFilename}`
            : newPath;
          openDocument(newDocPath, spaceId);
        }

        if (oldParentReadme) {
          const freshTree =
            useSpaceStore.getState().fileTrees[spaceId] ?? currentTree;
          const oldParentNode = findTreeNode(freshTree, oldParentReadme);
          if (oldParentNode && oldParentNode.children.length <= 1) {
            try {
              const currentActive =
                useEntrySelectionStore.getState().activeDocument;
              useEditorStore.getState().suppressPaths([oldParentReadme]);
              const unnestPath = await unnestTreeEntry({
                spacePath: space.path,
                path: oldParentReadme,
                projectPath: useSpaceStore.getState().activeRootPath,
              });
              useEditorStore.getState().suppressPaths([unnestPath]);
              if (currentActive === oldParentReadme) {
                useEditorStore.getState().clearUnsaved(oldParentReadme);
                useEntrySelectionStore
                  .getState()
                  .openDocument(unnestPath, spaceId);
              }
              await reloadTreePathParent(spaceId, oldParentReadme);
              await reloadTreePathParent(spaceId, unnestPath);
            } catch {
              // Folder still has non-tree children on disk; leave it nested.
            }
          }
        }

        const updatedTree = useSpaceStore.getState().fileTrees[spaceId];
        if (updatedTree) {
          const order = buildOrderMap(updatedTree);
          await saveOrder(spaceId, order);
          await reloadTreeParents(spaceId, [fromParent, toParent]);
        }
      } catch (err) {
        console.error("Failed to move entry:", err);
        toast.error("Failed to move file");
      }
    },
    [
      tree,
      spaceId,
      moveEntry,
      saveOrder,
      reloadTreeParent,
      reloadTreeParents,
      reloadTreePathParent,
      resetState,
    ],
  );
}
