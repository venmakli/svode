import {
  createEntry,
  getExpandedPaths,
  listEntries,
  listTreeChildren,
  moveEntry,
  saveExpandedPaths,
  saveTreeOrder,
  type EntryDto,
} from "@/platform/entries/entries-api";
import { clearMcpActiveContext, setMcpActiveContext } from "@/platform/mcp";
import {
  createProject,
  createSpace,
  deleteProject,
  deleteSpace,
  ensureAssetsScope,
  ensureSpaceScaffold,
  getLastActiveProject,
  getWindowOpenIntent,
  listProjects,
  listSpaces,
  openProjectWindow,
  openProject,
  openProjectFolder,
  releaseCurrentProjectWindow,
  reorderSpaces,
} from "@/platform/space/space-api";
import type { SpaceGitType } from "../model/types";

export type SpaceEntryDto = EntryDto;

export function listRootSpaces() {
  return listProjects();
}

export function openRootProject(id: string) {
  return openProject(id);
}

export function openRootProjectWindow(id: string) {
  return openProjectWindow(id);
}

export function getCurrentWindowOpenIntent() {
  return getWindowOpenIntent();
}

export function releaseCurrentRootProjectWindow() {
  return releaseCurrentProjectWindow();
}

export function createRootSpace(input: {
  name: string;
  icon: string;
  description: string | undefined;
  path: string;
}) {
  return createProject(input);
}

export function openRootFolderSpace(path: string) {
  return openProjectFolder(path);
}

export function deleteRootSpace(id: string, deleteFiles?: boolean) {
  return deleteProject(id, deleteFiles);
}

export function getLastActiveRootSpace() {
  return getLastActiveProject();
}

export function listChildSpaces(rootPath: string) {
  return listSpaces(rootPath);
}

export function createChildSpace(input: {
  parentPath: string;
  name: string;
  icon: string;
  folderName: string;
  gitType: SpaceGitType;
}) {
  return createSpace(input);
}

export function deleteChildSpace(
  parentPath: string,
  spaceId: string,
  deleteFiles?: boolean,
) {
  return deleteSpace(parentPath, spaceId, deleteFiles);
}

export function reorderChildSpaces(
  rootPath: string,
  orderedSpaceIds: string[],
) {
  return reorderSpaces(rootPath, orderedSpaceIds);
}

export function ensureSpaceAssetsScope(spacePath: string) {
  return ensureAssetsScope(spacePath);
}

export function ensureChildSpaceScaffold(
  rootPath: string,
  childSpacePath: string,
) {
  return ensureSpaceScaffold(rootPath, childSpacePath);
}

export function createSpaceEntry(input: {
  spacePath: string;
  parentPath: string | null;
  title: string;
  projectPath: string | null;
}) {
  return createEntry({
    space: input.spacePath,
    parentPath: input.parentPath,
    title: input.title,
    projectPath: input.projectPath,
  });
}

export function listSpaceTreeEntries(spacePath: string) {
  return listEntries(spacePath);
}

export function listSpaceTreeChildren(
  spacePath: string,
  parentPath: string | null,
) {
  return listTreeChildren(spacePath, parentPath);
}

export function getSpaceExpandedPaths(spacePath: string) {
  return getExpandedPaths(spacePath);
}

export function saveSpaceExpandedPaths(spacePath: string, paths: string[]) {
  return saveExpandedPaths(spacePath, paths);
}

export function moveSpaceEntry(input: {
  spacePath: string;
  from: string;
  toParent: string;
  projectPath: string | null;
}) {
  return moveEntry({
    space: input.spacePath,
    from: input.from,
    toParent: input.toParent,
    projectPath: input.projectPath,
  });
}

export function saveSpaceTreeOrder(input: {
  spacePath: string;
  order: Record<string, string[]>;
  projectPath: string | null;
}) {
  return saveTreeOrder({
    space: input.spacePath,
    order: input.order,
    projectPath: input.projectPath,
  });
}

export function clearActiveMcpContext() {
  return clearMcpActiveContext();
}

export function setActiveMcpContext(input: {
  projectPath: string;
  activeSpaceId: string | null;
}) {
  return setMcpActiveContext(input);
}
