import {
  createPage,
  getPageBacklinks,
  nestPage,
  unnestPage,
  updatePageField,
  type PageBacklinkDto,
  type PageDto,
} from "@/platform/pages/pages-api";
import {
  createContentTreeFolder,
  deleteContentTreeItem,
  renameContentTreeItem,
} from "@/platform/space/content-tree-api";
import { convertToCollection } from "@/platform/collections/collections-api";
import type { TreeNode } from "../model/types";
import { treeNodeHasChildren, treeParentKeyForNode } from "../lib/tree-cache";

type ProjectPath = string | null;

export type BacklinkInfo = PageBacklinkDto;

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
}): Promise<PageDto> {
  return createPage({
    space: input.spacePath,
    parentPath: input.parentPath,
    title: input.title,
    allocateUniqueTitle: true,
    projectPath: input.projectPath,
  });
}

export function createTreeFolder(input: {
  spacePath: string;
  parentPath: string | null;
  name: string;
  projectPath: ProjectPath;
}): Promise<string> {
  return createContentTreeFolder({
    space: input.spacePath,
    parentPath: input.parentPath,
    name: input.name,
    projectPath: input.projectPath,
  });
}

export function renameTreeItemPath(input: {
  spacePath: string;
  from: string;
  to: string;
  projectPath: ProjectPath;
}): Promise<string[]> {
  return renameContentTreeItem({
    space: input.spacePath,
    from: input.from,
    to: input.to,
    projectPath: input.projectPath,
  });
}

export function updateTreePageTitle(input: {
  spacePath: string;
  filePath: string;
  title: string;
  projectPath: ProjectPath;
}): Promise<PageDto> {
  return updatePageField({
    space: input.spacePath,
    filePath: input.filePath,
    field: "title",
    value: input.title,
    projectPath: input.projectPath,
  });
}

export function nestTreePage(input: {
  spacePath: string;
  path: string;
  projectPath: ProjectPath;
}): Promise<string> {
  return nestPage({
    space: input.spacePath,
    path: input.path,
    projectPath: input.projectPath,
  });
}

export function unnestTreePage(input: {
  spacePath: string;
  path: string;
  projectPath: ProjectPath;
}): Promise<string> {
  return unnestPage({
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

  const newPath = await nestTreePage({
    spacePath: input.spacePath,
    path: input.node.path,
    projectPath: input.projectPath,
  });
  return {
    parentPath: readmeFolderPath(newPath),
    parentNodePath: newPath,
  };
}

export async function createBareFolderPage(input: {
  spacePath: string;
  folderPath: string;
  title: string;
  projectPath: ProjectPath;
}): Promise<string> {
  const readmePath = `${input.folderPath}/README.md`;
  await createPage({
    space: input.spacePath,
    parentPath: input.folderPath,
    title: input.title,
    asReadme: true,
    projectPath: input.projectPath,
  });
  return readmePath;
}

export async function convertTreeBareFolderToCollection(input: {
  spacePath: string;
  folderPath: string;
  projectPath: ProjectPath;
}): Promise<PageDto> {
  const conversion = await convertToCollection({
    spacePath: input.spacePath,
    path: input.folderPath,
    projectPath: input.projectPath,
  });
  return conversion.page;
}

export async function convertTreePageToCollection(input: {
  spacePath: string;
  filePath: string;
  projectPath: ProjectPath;
}): Promise<PageDto> {
  const conversion = await convertToCollection({
    spacePath: input.spacePath,
    path: input.filePath,
    projectPath: input.projectPath,
  });
  return conversion.page;
}

export function getTreePageBacklinks(input: {
  spacePath: string;
  targetPath: string;
  projectPath: ProjectPath;
}): Promise<BacklinkInfo[]> {
  return getPageBacklinks({
    space: input.spacePath,
    targetPath: input.targetPath,
    projectPath: input.projectPath,
  });
}

export function deleteTreeItem(input: {
  spacePath: string;
  path: string;
  projectPath: ProjectPath;
}): Promise<void> {
  return deleteContentTreeItem({
    space: input.spacePath,
    path: input.path,
    projectPath: input.projectPath,
  });
}
