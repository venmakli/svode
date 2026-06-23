import { invokeCommand } from "@/platform/native/invoke";
import type { TreeNodeDto } from "@/platform/space/space-types";

export type EntryCoverDto =
  | { type: "color"; value: string }
  | { type: "image"; path: string; position?: number | null };

export interface EntryMetaDto {
  title: string;
  icon: string | null;
  description?: string | null;
  cover?: EntryCoverDto | null;
  created: string;
  updated: string;
  extra: Record<string, unknown>;
}

export interface EntryWarningDto {
  kind: string;
  message: string;
}

export interface EntryDto {
  meta: EntryMetaDto;
  body: string;
  path: string;
  warnings?: EntryWarningDto[];
}

export interface LinkValidationResultDto {
  url: string;
  exists: boolean;
}

export interface BacklinkInfoDto {
  sourceSpaceId: string | null;
  sourcePath: string;
  linkCount: number;
}

export interface WriteEntryInputDto extends Record<string, unknown> {
  space: string;
  path: string;
  content: string;
  skipRename: boolean;
  projectPath: string | null;
}

export interface WriteResultDto {
  new_path: string | null;
  modified_files: string[];
  modified_sources?: { spaceId: string | null; path: string }[];
  write_nonce: string;
}

export function createEntry(input: {
  space: string;
  parentPath: string | null;
  title: string;
  contextualDefaults?: Record<string, unknown> | null;
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

export function renameEntry(input: {
  space: string;
  from: string;
  to: string;
  projectPath: string | null;
}): Promise<string[]> {
  return invokeCommand<string[]>("rename_entry", { ...input });
}

export function readEntry(space: string, path: string): Promise<EntryDto> {
  return invokeCommand<EntryDto>("read_entry", { space, path });
}

export function writeEntry(input: WriteEntryInputDto): Promise<WriteResultDto> {
  return invokeCommand<WriteResultDto>("write_entry", input);
}

export function updateEntryField(input: {
  space: string;
  filePath: string;
  field: string;
  value: unknown;
  projectPath: string | null;
}): Promise<EntryDto> {
  return invokeCommand<EntryDto>("update_entry_field", { ...input });
}

export function deleteEntry(input: {
  space: string;
  path: string;
  projectPath: string | null;
}): Promise<void> {
  return invokeCommand<void>("delete_entry", { ...input });
}

export function duplicateEntry(input: {
  space: string;
  filePath: string;
  projectPath: string | null;
}): Promise<EntryDto> {
  return invokeCommand<EntryDto>("duplicate_entry", { ...input });
}

export function getBacklinks(input: {
  space: string;
  targetPath: string;
  projectPath: string | null;
}): Promise<BacklinkInfoDto[]> {
  return invokeCommand<BacklinkInfoDto[]>("get_backlinks", { ...input });
}

export function nestEntry(input: {
  space: string;
  path: string;
  projectPath: string | null;
}): Promise<string> {
  return invokeCommand<string>("nest_entry", { ...input });
}

export function unnestEntry(input: {
  space: string;
  path: string;
  projectPath: string | null;
}): Promise<string> {
  return invokeCommand<string>("unnest_entry", { ...input });
}

export function convertBareFolderToCollection(input: {
  space: string;
  folderPath: string;
  projectPath: string | null;
}): Promise<EntryDto> {
  return invokeCommand<EntryDto>("convert_bare_folder_to_collection", {
    ...input,
  });
}

export function convertEntryToFolder(input: {
  space: string;
  filePath: string;
  projectPath: string | null;
}): Promise<EntryDto> {
  return invokeCommand<EntryDto>("convert_entry_to_folder", { ...input });
}

export function convertEntryToLeaf(input: {
  space: string;
  filePath: string;
  projectPath: string | null;
}): Promise<EntryDto> {
  return invokeCommand<EntryDto>("convert_entry_to_leaf", { ...input });
}

export function convertEntryToNestedCollection(input: {
  space: string;
  filePath: string;
  projectPath: string | null;
}): Promise<string> {
  return invokeCommand<string>("convert_entry_to_nested_collection", {
    ...input,
  });
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
