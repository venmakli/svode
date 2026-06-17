import { invokeCommand } from "@/platform/native/invoke";
import type {
  SpaceConfigDto,
  SpaceGitTypeDto,
  SpaceInfoDto,
} from "./space-types";

export function listProjects(): Promise<SpaceInfoDto[]> {
  return invokeCommand<SpaceInfoDto[]>("list_projects");
}

export function openProject(id: string): Promise<SpaceConfigDto> {
  return invokeCommand<SpaceConfigDto>("open_project", { id });
}

export interface CreateProjectInput {
  name: string;
  icon: string;
  description?: string;
  path: string;
}

export function createProject(
  input: CreateProjectInput,
): Promise<SpaceInfoDto> {
  return invokeCommand<SpaceInfoDto>("create_project", { ...input });
}

export function openProjectFolder(path: string): Promise<SpaceInfoDto> {
  return invokeCommand<SpaceInfoDto>("open_project_folder", { path });
}

export function cloneProject(
  url: string,
  targetPath: string,
): Promise<SpaceInfoDto> {
  return invokeCommand<SpaceInfoDto>("project_clone", { url, targetPath });
}

export function deleteProject(
  id: string,
  deleteFiles?: boolean,
): Promise<void> {
  return invokeCommand<void>("delete_project", { id, deleteFiles });
}

export function getLastActiveProject(): Promise<string | null> {
  return invokeCommand<string | null>("get_last_active_project");
}

export function listSpaces(spacePath: string): Promise<SpaceInfoDto[]> {
  return invokeCommand<SpaceInfoDto[]>("list_spaces", { spacePath });
}

export function getSpaceConfig(spacePath: string): Promise<SpaceConfigDto> {
  return invokeCommand<SpaceConfigDto>("get_space_config", { spacePath });
}

export function saveSpaceConfig(
  spacePath: string,
  configData: SpaceConfigDto,
  projectPath?: string | null,
): Promise<void> {
  return invokeCommand<void>("save_space_config", {
    spacePath,
    configData,
    projectPath,
  });
}

export function reorderSpaces(
  projectPath: string,
  orderedSpaceIds: string[],
): Promise<SpaceInfoDto[]> {
  return invokeCommand<SpaceInfoDto[]>("reorder_spaces", {
    projectPath,
    orderedSpaceIds,
  });
}

export function ensureSpaceScaffold(
  projectPath: string,
  spacePath: string,
): Promise<void> {
  return invokeCommand<void>("ensure_space_scaffold", {
    projectPath,
    spacePath,
  });
}

export function ensureAssetsScope(spacePath: string): Promise<void> {
  return invokeCommand<void>("ensure_assets_scope", { spacePath });
}

export interface CreateSpaceInput {
  parentPath: string;
  name: string;
  icon: string;
  folderName: string;
  gitType: SpaceGitTypeDto;
}

export function createSpace(input: CreateSpaceInput): Promise<SpaceInfoDto> {
  return invokeCommand<SpaceInfoDto>("create_space", { ...input });
}

export function deleteSpace(
  parentPath: string,
  spaceId: string,
  deleteFiles?: boolean,
): Promise<void> {
  return invokeCommand<void>("delete_space", {
    parentPath,
    spaceId,
    deleteFiles,
  });
}

export function cloneMissingSpace(
  projectPath: string,
  spaceId: string,
): Promise<void> {
  return invokeCommand<void>("clone_missing_space", { projectPath, spaceId });
}

export interface CloneSpaceInput {
  url: string;
  targetPath: string;
  projectPath: string;
  gitType: SpaceGitTypeDto;
}

export function cloneSpace(input: CloneSpaceInput): Promise<void> {
  return invokeCommand<void>("git_clone_space", { ...input });
}

export interface RegisterClonedSpaceInput {
  parentPath: string;
  folderName: string;
  fallbackName: string;
  fallbackIcon: string;
  url: string;
  gitType: SpaceGitTypeDto;
}

export function registerClonedSpace(
  input: RegisterClonedSpaceInput,
): Promise<void> {
  return invokeCommand<void>("register_cloned_space", { ...input });
}

export function removeMissingSpace(
  projectPath: string,
  spaceId: string,
): Promise<void> {
  return invokeCommand<void>("remove_missing_space", { projectPath, spaceId });
}

export function watchSpace(space: string): Promise<void> {
  return invokeCommand<void>("watch_space", { space });
}

export function unwatchSpace(space: string): Promise<void> {
  return invokeCommand<void>("unwatch_space", { space });
}

export function reindexProject(projectPath: string): Promise<void> {
  return invokeCommand<void>("reindex_project", { projectPath });
}
