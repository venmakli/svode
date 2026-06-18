import { invokeCommand } from "@/platform/native/invoke";
import type { TreeNodeDto } from "@/platform/space/space-types";

export type EntryCoverDto =
  | { type: "color"; value: string }
  | { type: "image"; path: string; position?: number | null };

export interface EntryMetaDto {
  id: string;
  title: string;
  icon: string | null;
  description?: string | null;
  cover?: EntryCoverDto | null;
  created: string;
  updated: string;
  extra: Record<string, unknown>;
}

export interface EntryDto {
  meta: EntryMetaDto;
  body: string;
  path: string;
}

export interface LinkValidationResultDto {
  url: string;
  exists: boolean;
}

export function createEntry(input: {
  space: string;
  parentPath: string | null;
  title: string;
  projectPath: string | null;
}): Promise<EntryDto> {
  return invokeCommand<EntryDto>("create_entry", { ...input });
}

export function createFolder(input: {
  space: string;
  parentPath: string | null;
  name: string;
  projectPath: string | null;
}): Promise<string> {
  return invokeCommand<string>("create_folder", { ...input });
}

export function readEntry(space: string, path: string): Promise<EntryDto> {
  return invokeCommand<EntryDto>("read_entry", { space, path });
}

export function validateLinks(input: {
  space: string;
  path: string;
  projectPath: string | null;
}): Promise<LinkValidationResultDto[]> {
  return invokeCommand<LinkValidationResultDto[]>("validate_links", input);
}

export function listEntries(space: string): Promise<TreeNodeDto[]> {
  // Full recursive tree fallback for repair/manual recovery. Normal UI paths
  // load direct children through listTreeChildren.
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

export async function listTreeChildren(
  space: string,
  parentPath: string | null,
): Promise<TreeNodeDto[]> {
  const nodes = await invokeCommand<DirectTreeNodeDto[]>("list_tree_children", {
    space,
    parentPath,
  });
  return nodes.map(normalizeTreeNode);
}

export function getExpandedPaths(space: string): Promise<string[]> {
  return invokeCommand<string[]>("get_expanded_paths", { space });
}

export function saveExpandedPaths(
  space: string,
  paths: string[],
): Promise<void> {
  return invokeCommand<void>("save_expanded_paths", { space, paths });
}

export function moveEntry(input: {
  space: string;
  from: string;
  toParent: string;
  projectPath: string | null;
}): Promise<string> {
  return invokeCommand<string>("move_entry", { ...input });
}

export function saveTreeOrder(input: {
  space: string;
  order: Record<string, string[]>;
  projectPath: string | null;
}): Promise<void> {
  return invokeCommand<void>("save_tree_order", { ...input });
}
