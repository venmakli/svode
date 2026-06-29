import { invokeCommand } from "@/platform/native/invoke";

export interface GitIdentityDto {
  name: string;
  email: string;
}

export type GitIdentityFieldSourceDto = "local" | "global" | "missing";
export type RepoIdentitySourceDto = "local" | "global" | "missing" | "partial";

export interface IdentityFieldSourcesDto {
  name: GitIdentityFieldSourceDto;
  email: GitIdentityFieldSourceDto;
}

export interface GlobalIdentityResultDto {
  global: GitIdentityDto | null;
  source: "global" | "missing";
}

export interface RepoIdentityResultDto {
  local: GitIdentityDto | null;
  localName?: string | null;
  localEmail?: string | null;
  effective: GitIdentityDto | null;
  fieldSources?: IdentityFieldSourcesDto;
  source: RepoIdentitySourceDto;
}

export interface FanoutPreviewEntryDto {
  spacePath: string;
  spaceName: string;
  currentLocal: GitIdentityDto | null;
  currentEffective?: GitIdentityDto | null;
  source?: RepoIdentitySourceDto;
  fieldSources?: IdentityFieldSourcesDto;
  willReplace: boolean;
}

export interface SaveRepoIdentityInputDto extends Record<string, unknown> {
  repoPath: string;
  name: string | null;
  email: string | null;
}

export interface SaveProjectIdentityInputDto extends Record<string, unknown> {
  rootPath: string;
  name: string | null;
  email: string | null;
  targetSpaces: string[];
}

export interface SaveGlobalIdentityInputDto extends Record<string, unknown> {
  name: string;
  email: string;
}

export function getGlobalIdentity(): Promise<GlobalIdentityResultDto> {
  return invokeCommand<GlobalIdentityResultDto>("get_git_identity");
}

export function saveGlobalIdentity(
  input: SaveGlobalIdentityInputDto,
): Promise<void> {
  return invokeCommand<void>("set_git_identity", input);
}

export function getRepoIdentity(
  repoPath: string,
): Promise<RepoIdentityResultDto> {
  return invokeCommand<RepoIdentityResultDto>("get_repo_identity", {
    repoPath,
  });
}

export function getProjectFanoutPreview(
  rootPath: string,
): Promise<FanoutPreviewEntryDto[]> {
  return invokeCommand<FanoutPreviewEntryDto[]>("get_project_fanout_preview", {
    rootPath,
  });
}

export function saveRepoIdentity(
  input: SaveRepoIdentityInputDto,
): Promise<void> {
  return invokeCommand<void>("set_repo_identity", input);
}

export function saveProjectIdentity(
  input: SaveProjectIdentityInputDto,
): Promise<void> {
  return invokeCommand<void>("set_project_identity", input);
}
