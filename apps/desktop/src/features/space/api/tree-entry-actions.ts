import {
  convertBareFolderToCollection,
  convertEntryToFolder,
  convertEntryToNestedCollection,
  createEntry,
  createFolder,
  deleteEntry,
  getBacklinks,
  nestEntry,
  readEntry,
  renameEntry,
  unnestEntry,
  updateEntryField,
  type BacklinkInfoDto,
  type EntryDto,
} from "@/platform/entries/entries-api";
import type { TreeNode } from "../model/types";
import { treeNodeHasChildren, treeParentKeyForNode } from "../lib/tree-cache";

type ProjectPath = string | null;

export type BacklinkInfo = BacklinkInfoDto;

export interface TreeChildTarget {
  parentPath: string;
  parentNodePath: string;
}

function isBareFolderPath(path: string): boolean {
  return !path.endsWith(".md");
}

function readmeFolderPath(path: string): string {
  return path.replace(/\/readme\.md$/i, "");
}

export function createTreePage(input: {
  spacePath: string;
  parentPath: string | null;
  title: string;
  projectPath: ProjectPath;
}): Promise<EntryDto> {
  return createEntry({
    space: input.spacePath,
    parentPath: input.parentPath,
    title: input.title,
    projectPath: input.projectPath,
  });
}

export function createTreeFolder(input: {
  spacePath: string;
  parentPath: string | null;
  name: string;
  projectPath: ProjectPath;
}): Promise<string> {
  return createFolder({
    space: input.spacePath,
    parentPath: input.parentPath,
    name: input.name,
    projectPath: input.projectPath,
  });
}

export function renameTreeEntryPath(input: {
  spacePath: string;
  from: string;
  to: string;
  projectPath: ProjectPath;
}): Promise<string[]> {
  return renameEntry({
    space: input.spacePath,
    from: input.from,
    to: input.to,
    projectPath: input.projectPath,
  });
}

export function updateTreeEntryTitle(input: {
  spacePath: string;
  filePath: string;
  title: string;
  projectPath: ProjectPath;
}): Promise<EntryDto> {
  return updateEntryField({
    space: input.spacePath,
    filePath: input.filePath,
    field: "title",
    value: input.title,
    projectPath: input.projectPath,
  });
}

export function nestTreeEntry(input: {
  spacePath: string;
  path: string;
  projectPath: ProjectPath;
}): Promise<string> {
  return nestEntry({
    space: input.spacePath,
    path: input.path,
    projectPath: input.projectPath,
  });
}

export function unnestTreeEntry(input: {
  spacePath: string;
  path: string;
  projectPath: ProjectPath;
}): Promise<string> {
  return unnestEntry({
    space: input.spacePath,
    path: input.path,
    projectPath: input.projectPath,
  });
}

export async function resolveTreeChildTarget(input: {
  spacePath: string;
  node: TreeNode;
  projectPath: ProjectPath;
}): Promise<TreeChildTarget> {
  const childParentKey = treeParentKeyForNode(input.node);
  const knownChildren = treeNodeHasChildren(input.node);

  if (isBareFolderPath(input.node.path)) {
    return { parentPath: input.node.path, parentNodePath: input.node.path };
  }

  if (childParentKey && (knownChildren || input.node.has_schema)) {
    return { parentPath: childParentKey, parentNodePath: input.node.path };
  }

  const newPath = await nestTreeEntry({
    spacePath: input.spacePath,
    path: input.node.path,
    projectPath: input.projectPath,
  });
  return {
    parentPath: readmeFolderPath(newPath),
    parentNodePath: newPath,
  };
}

export async function makeBareFolderDocument(input: {
  spacePath: string;
  folderPath: string;
  title: string;
  projectPath: ProjectPath;
}): Promise<string> {
  const entry = await createTreePage({
    spacePath: input.spacePath,
    parentPath: input.folderPath,
    title: input.title,
    projectPath: input.projectPath,
  });
  const readmePath = `${input.folderPath}/README.md`;
  if (entry.path !== readmePath) {
    await renameTreeEntryPath({
      spacePath: input.spacePath,
      from: entry.path,
      to: readmePath,
      projectPath: input.projectPath,
    });
  }
  return readmePath;
}

export function convertTreeBareFolderToCollection(input: {
  spacePath: string;
  folderPath: string;
  projectPath: ProjectPath;
}): Promise<EntryDto> {
  return convertBareFolderToCollection({
    space: input.spacePath,
    folderPath: input.folderPath,
    projectPath: input.projectPath,
  });
}

export async function convertTreeDocumentToCollection(input: {
  spacePath: string;
  filePath: string;
  projectPath: ProjectPath;
}): Promise<EntryDto> {
  const entry = await readEntry(input.spacePath, input.filePath);
  let readmeEntry = entry;
  if (!input.filePath.toLowerCase().endsWith("/readme.md")) {
    readmeEntry = await convertEntryToFolder({
      space: input.spacePath,
      filePath: entry.path,
      projectPath: input.projectPath,
    });
  }
  await convertEntryToNestedCollection({
    space: input.spacePath,
    filePath: readmeEntry.path,
    projectPath: input.projectPath,
  });
  return readmeEntry;
}

export function getTreeEntryBacklinks(input: {
  spacePath: string;
  targetPath: string;
  projectPath: ProjectPath;
}): Promise<BacklinkInfo[]> {
  return getBacklinks({
    space: input.spacePath,
    targetPath: input.targetPath,
    projectPath: input.projectPath,
  });
}

export function deleteTreeEntry(input: {
  spacePath: string;
  path: string;
  projectPath: ProjectPath;
}): Promise<void> {
  return deleteEntry({
    space: input.spacePath,
    path: input.path,
    projectPath: input.projectPath,
  });
}
