import { useCallback } from "react";
import { retargetActiveContent } from "@/features/artifact";
import { followContentRelocation } from "@/features/page/navigation";
import type { TreeNode } from "../model/types";
import {
  buildCrossParentMovePlan,
  buildCrossParentMoveOrder,
  buildSameParentReorderOrder,
  movedPagePath,
  prepareTreeDrag,
} from "../lib/tree-dnd-commit-plan";
import type { Projection } from "../lib/tree-dnd-utilities";
import { buildOrderMap } from "../lib/tree-node-queries";
import { createFileTreeEditorSync } from "../effects/file-tree-editor-sync";
import { useSpaceStore, type SpaceState } from "../model/space-store";
import type { SpaceInfo } from "../model/types";

interface CommitFileTreeDragInput {
  fromPath: string;
  projection: Projection;
}

interface UseFileTreeDragCommandInput {
  spaceId: string;
  tree: TreeNode[];
}

function findSpace(state: SpaceState, spaceId: string): SpaceInfo | null {
  return (
    state.spaces.find((item) => item.id === spaceId) ??
    state.rootSpaces.find((item) => item.id === spaceId) ??
    null
  );
}

export function useFileTreeDragCommand({
  spaceId,
  tree,
}: UseFileTreeDragCommandInput) {
  return useCallback(
    async (input: CommitFileTreeDragInput) => {
      const state = useSpaceStore.getState();
      const space = findSpace(state, spaceId);
      if (!space) return;

      const drag = prepareTreeDrag(tree, input.fromPath, input.projection);
      if (!drag) return;

      const editorSync = createFileTreeEditorSync(spaceId, space.path);
      const currentTree = useSpaceStore.getState().fileTrees[spaceId] ?? tree;

      if (drag.fromParent === drag.toParent) {
        const order = buildSameParentReorderOrder({
          currentTree,
          fromNodeName: drag.fromNode.name,
          parentPath: drag.toParent,
          projection: input.projection,
        });
        if (order) {
          await useSpaceStore.getState().saveOrder(spaceId, order);
          await useSpaceStore
            .getState()
            .reloadTreeParent(spaceId, drag.toParent);
        }
        return;
      }

      const movePlan = buildCrossParentMovePlan(tree, drag);
      editorSync.clearInitialUnsaved(movePlan.fromPath);
      editorSync.suppressPaths([movePlan.fromPath, movePlan.movePath]);
      // The open content moves with the item before the move counts as
      // finished, so its old path is not taken for a vanished owner.
      const finishMove = useSpaceStore
        .getState()
        .beginTreePathMutation(space.path);
      let newPath: string;
      try {
        // One operation converts a leaf Page target into a folder Page and
        // an emptied folder Page parent back into a leaf.
        const moved = await useSpaceStore
          .getState()
          .moveContentItem(spaceId, movePlan.movePath, movePlan.toParent);
        newPath = moved.newPath;
        if (newPath) {
          editorSync.suppressPaths([newPath]);
          // A Page open inside a moved folder goes with it.
          followContentRelocation(
            space.path,
            spaceId,
            movePlan.movePath,
            newPath,
          );
        }

        if (newPath && movePlan.isBareFolder) {
          // An App or Collection without README open from this folder
          // follows it, as a moved Page does.
          retargetActiveContent(movePlan.fromPath, newPath, spaceId);
        } else if (newPath) {
          editorSync.reopenInitialPage(
            movePlan.fromPath,
            movedPagePath(movePlan, newPath),
          );
        }
        // An open converted parent Page goes on at its new path.
        for (const converted of moved.convertedParents) {
          editorSync.suppressPaths([converted.oldPath, converted.newPath]);
          editorSync.reopenInitialPage(converted.oldPath, converted.newPath);
        }
      } finally {
        finishMove();
      }

      const updatedTree = useSpaceStore.getState().fileTrees[spaceId];
      if (updatedTree) {
        const movedNodeName =
          newPath?.split("/").pop() ?? movePlan.fromNode.name;
        const order =
          buildCrossParentMoveOrder({
            currentTree: updatedTree,
            movedNodeName,
            parentPath: drag.toParent,
            projection: input.projection,
          }) ?? buildOrderMap(updatedTree);
        await useSpaceStore.getState().saveOrder(spaceId, order);
        await useSpaceStore
          .getState()
          .reloadTreeParents(spaceId, [drag.fromParent, drag.toParent]);
      }
    },
    [spaceId, tree],
  );
}
