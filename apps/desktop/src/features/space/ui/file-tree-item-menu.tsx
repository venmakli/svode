import {
  ContentActionMenuItems,
  contentActionGroups,
  type ContentActionHandlers,
} from "@/features/content-actions";
import type { NavigationItem } from "@/features/navigation";
import type { TreeNode } from "../model/types";
import { treeNodeContentObject } from "../lib/tree-node-content-object";
import { usePageFolderContents } from "../hooks/use-page-folder-contents";

/** The items of a content tree node's menu, mounted while the menu is open. */
export function FileTreeItemMenuItems({
  node,
  spacePath,
  pinItem,
  handlers,
}: {
  node: TreeNode;
  spacePath: string | null;
  pinItem: NavigationItem | null;
  handlers: ContentActionHandlers;
}) {
  const object = treeNodeContentObject(node);
  const folderPage = object.kind === "page" && object.form === "folder";
  const contents = usePageFolderContents(
    spacePath,
    folderPage ? node.path : null,
  );
  const groups = contentActionGroups({
    object: treeNodeContentObject(node, contents),
  });
  return (
    <ContentActionMenuItems
      groups={groups}
      pinItem={pinItem}
      handlers={handlers}
    />
  );
}
