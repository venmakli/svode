import { useCallback } from "react";
import type { TreeNode } from "../model/types";
import { nestTreeEntry, unnestTreeEntry } from "../api/tree-entry-actions";
import {
  buildCrossParentMovePlan,
  buildNestConversionOrder,
  buildSameParentReorderOrder,
  getChildNestConversionPlan,
  movedDocumentPath,
  prepareTreeDrag,
  readmeFolderPath,
  type CrossParentMovePlan,
} from "../lib/tree-dnd-commit-plan";
import type { Projection } from "../lib/tree-dnd-utilities";
import { buildOrderMap, findTreeNode } from "../lib/tree-node-queries";
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

async function convertProjectedChildTarget(input: {
  space: SpaceInfo;
  spaceId: string;
  tree: TreeNode[];
  fromPath: string;
  projection: Projection;
  editorSync: ReturnType<typeof createFileTreeEditorSync>;
}) {
  const nestPlan = getChildNestConversionPlan(input.tree, input.projection);
  if (!nestPlan) return;

  input.editorSync.suppressPaths([nestPlan.targetPath, input.fromPath]);
  const newNestPath = await nestTreeEntry({
    spacePath: input.space.path,
    path: nestPlan.targetPath,
    projectPath: useSpaceStore.getState().activeRootPath,
  });
  input.editorSync.suppressPaths([newNestPath]);
  input.editorSync.reopenInitialDocument(nestPlan.targetPath, newNestPath);

  const order = buildNestConversionOrder(input.tree, nestPlan);
  if (order) {
    await useSpaceStore.getState().saveOrder(input.spaceId, order);
  }
  await useSpaceStore
    .getState()
    .reloadTreePathParent(input.spaceId, nestPlan.targetPath);
  await useSpaceStore
    .getState()
    .reloadTreeParent(input.spaceId, readmeFolderPath(newNestPath));
}

async function maybeUnnestEmptyOldParent(input: {
  space: SpaceInfo;
  spaceId: string;
  currentTree: TreeNode[];
  movePlan: CrossParentMovePlan;
  editorSync: ReturnType<typeof createFileTreeEditorSync>;
}) {
  if (!input.movePlan.oldParentReadme) return;

  const freshTree =
    useSpaceStore.getState().fileTrees[input.spaceId] ?? input.currentTree;
  const oldParentNode = findTreeNode(freshTree, input.movePlan.oldParentReadme);
  if (!oldParentNode || oldParentNode.children.length > 1) return;

  try {
    const currentActive = input.editorSync.activeDocument();
    input.editorSync.suppressPaths([input.movePlan.oldParentReadme]);
    const unnestPath = await unnestTreeEntry({
      spacePath: input.space.path,
      path: input.movePlan.oldParentReadme,
      projectPath: useSpaceStore.getState().activeRootPath,
    });
    input.editorSync.suppressPaths([unnestPath]);
    input.editorSync.reopenDocumentSnapshot(
      currentActive,
      input.movePlan.oldParentReadme,
      unnestPath,
    );
    await useSpaceStore
      .getState()
      .reloadTreePathParent(input.spaceId, input.movePlan.oldParentReadme);
    await useSpaceStore
      .getState()
      .reloadTreePathParent(input.spaceId, unnestPath);
  } catch {
    // Folder still has non-tree children on disk; leave it nested.
  }
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

      const editorSync = createFileTreeEditorSync(spaceId);

      await convertProjectedChildTarget({
        space,
        spaceId,
        tree,
        fromPath: input.fromPath,
        projection: input.projection,
        editorSync,
      });

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
      const newPath = await useSpaceStore
        .getState()
        .moveEntry(spaceId, movePlan.movePath, movePlan.toParent);
      if (newPath) {
        editorSync.suppressPaths([newPath]);
      }

      if (newPath && !movePlan.isBareFolder) {
        editorSync.reopenInitialDocument(
          movePlan.fromPath,
          movedDocumentPath(movePlan, newPath),
        );
      }

      await maybeUnnestEmptyOldParent({
        space,
        spaceId,
        currentTree,
        movePlan,
        editorSync,
      });

      const updatedTree = useSpaceStore.getState().fileTrees[spaceId];
      if (updatedTree) {
        const order = buildOrderMap(updatedTree);
        await useSpaceStore.getState().saveOrder(spaceId, order);
        await useSpaceStore
          .getState()
          .reloadTreeParents(spaceId, [drag.fromParent, drag.toParent]);
      }
    },
    [spaceId, tree],
  );
}
