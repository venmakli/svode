import type {
  ContentObject,
  PageFolderContents,
} from "@/features/content-actions";
import type { TreeNode } from "../model/types";
import { isReadmePath } from "./tree-patches";

/** The object a content tree node stands for in its action menu. */
export function treeNodeContentObject(
  node: TreeNode,
  contents: PageFolderContents | null = null,
): ContentObject {
  if (node.has_schema) return { kind: "collection" };
  if (node.kind === "app" || node.has_app) return { kind: "app" };
  if (!node.path.endsWith(".md")) return { kind: "folder" };
  return isReadmePath(node.path)
    ? { kind: "page", form: "folder", contents }
    : { kind: "page", form: "leaf" };
}
