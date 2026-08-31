import { invokeCommand } from "@/platform/native/invoke";
import type { TreeNodeDto } from "./space-types";

export function createContentTreeFolder(input: {
  space: string;
  parentPath: string | null;
  name: string;
  projectPath: string | null;
}): Promise<string> {
  return invokeCommand<string>("create_folder", { ...input });
}

export function listContentTree(space: string): Promise<TreeNodeDto[]> {
  return invokeCommand<TreeNodeDto[]>("list_entries", { space });
}

type DirectTreeNodeDto = Omit<TreeNodeDto, "children"> & {
  children?: TreeNodeDto[];
};

function normalizeTreeNode(node: DirectTreeNodeDto): TreeNodeDto {
  return {
    ...node,
    hasChildren: node.hasChildren ?? node.has_children,
    children: (node.children ?? []).map(normalizeTreeNode),
  };
}

export async function listContentTreeChildren(
  space: string,
  parentPath: string | null,
): Promise<TreeNodeDto[]> {
  const nodes = await invokeCommand<DirectTreeNodeDto[]>("list_tree_children", {
    space,
    parentPath,
  });
  return nodes.map(normalizeTreeNode);
}

export function getContentTreeExpandedPaths(space: string): Promise<string[]> {
  return invokeCommand<string[]>("get_expanded_paths", { space });
}

export function saveContentTreeExpandedPaths(
  space: string,
  paths: string[],
): Promise<void> {
  return invokeCommand<void>("save_expanded_paths", { space, paths });
}

export function moveContentTreeItem(input: {
  space: string;
  from: string;
  toParent: string;
  projectPath: string | null;
}): Promise<string> {
  return invokeCommand<string>("move_entry", { ...input });
}

export function renameContentTreeItem(input: {
  space: string;
  from: string;
  to: string;
  projectPath: string | null;
}): Promise<string[]> {
  return invokeCommand<string[]>("rename_entry", { ...input });
}

export function deleteContentTreeItem(input: {
  space: string;
  path: string;
  projectPath: string | null;
}): Promise<void> {
  return invokeCommand<void>("delete_entry", { ...input });
}

export function saveContentTreeOrder(input: {
  space: string;
  order: Record<string, string[]>;
  projectPath: string | null;
}): Promise<void> {
  return invokeCommand<void>("save_tree_order", { ...input });
}

export function readContentTreeOrder(
  space: string,
): Promise<Record<string, string[]>> {
  return invokeCommand<Record<string, string[]>>("read_tree_order", { space });
}
