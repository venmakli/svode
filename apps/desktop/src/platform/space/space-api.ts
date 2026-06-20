import { invokeCommand } from "@/platform/native/invoke";
import {
  listen,
  type EventCallback,
  type UnlistenFn,
} from "@/platform/native/events";
import type {
  AssetsS3ConfigDto,
  AssetsStrategyDto,
  LfsStateDto,
  SpaceDirtyEventDto,
  SpaceFileEventDto,
  SpaceConfigDto,
  SpaceGitTypeDto,
  SpaceInfoDto,
} from "./space-types";

export interface SpacePoolInputDto extends Record<string, unknown> {
  projectPath: string;
  spaceId: string | null;
}

export interface S3CredentialsInputDto extends Record<string, unknown> {
  accessKey: string;
  secretKey: string;
}

export interface CheckS3ConnectionInputDto
  extends AssetsS3ConfigDto,
    Record<string, unknown> {
  accessKey: string;
  secretKey: string;
}

export interface SetAssetsStrategyInputDto extends SpacePoolInputDto {
  strategy: AssetsStrategyDto;
  s3Config: AssetsS3ConfigDto | null;
  s3Credentials: S3CredentialsInputDto | null;
}

export interface SetAssetsStrategyResultDto {
  warnings: string[];
}

export interface LfsStateChangedEventDto {
  projectPath: string;
  spaceId: string | null;
  state: LfsStateDto;
}

export type SpaceFileEventName =
  | "file:created"
  | "file:changed"
  | "file:deleted";

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

export function countAssets(input: SpacePoolInputDto): Promise<number> {
  return invokeCommand<number>("count_assets", input);
}

export function hasS3Credentials(input: SpacePoolInputDto): Promise<boolean> {
  return invokeCommand<boolean>("has_s3_credentials", input);
}

export function checkS3Connection(
  input: CheckS3ConnectionInputDto,
): Promise<boolean> {
  return invokeCommand<boolean>("check_s3_connection", input);
}

export function applyAssetsStrategy(
  input: SetAssetsStrategyInputDto,
): Promise<SetAssetsStrategyResultDto> {
  return invokeCommand<SetAssetsStrategyResultDto>("set_assets_strategy", input);
}

export function getLfsState(input: SpacePoolInputDto): Promise<LfsStateDto> {
  return invokeCommand<LfsStateDto>("get_lfs_state", input);
}

export function repairLfs(input: SpacePoolInputDto): Promise<LfsStateDto> {
  return invokeCommand<LfsStateDto>("repair_lfs", input);
}

export function listenLfsStateChanged(
  handler: EventCallback<LfsStateChangedEventDto>,
): Promise<UnlistenFn> {
  return listen<LfsStateChangedEventDto>("space:lfs_state_changed", handler);
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

export function listenSpaceFileEvent(
  eventName: SpaceFileEventName,
  handler: EventCallback<SpaceFileEventDto>,
): Promise<UnlistenFn> {
  return listen<SpaceFileEventDto>(eventName, handler);
}

export function listenSpaceDirty(
  handler: EventCallback<SpaceDirtyEventDto>,
): Promise<UnlistenFn> {
  return listen<SpaceDirtyEventDto>("space:dirty", handler);
}

export function reindexProject(projectPath: string): Promise<void> {
  return invokeCommand<void>("reindex_project", { projectPath });
}

export function countBrokenLinks(projectPath: string): Promise<number> {
  return invokeCommand<number>("count_broken_links", { projectPath });
}
