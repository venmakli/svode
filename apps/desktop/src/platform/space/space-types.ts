export type SpaceGitTypeDto = "inline" | "independent" | "submodule";

export type SpaceStatusDto = "ready" | "missing" | "broken";

export type LfsStateDto = "n/a" | "ready" | "missing-creds" | "pulling";

export interface SpaceInfoDto {
  id: string;
  name: string;
  icon: string;
  description: string;
  path: string;
  hasSpaces: boolean;
  lastOpened: string | null;
  status: SpaceStatusDto;
  lfsState: LfsStateDto;
}

export interface GitSpaceConfigDto {
  autoSync?: boolean;
}

export type AssetsStrategyDto = "local" | "in-git" | "lfs-remote" | "lfs-s3";

export interface AssetsS3ConfigDto {
  endpoint: string;
  bucket: string;
  region: string;
}

export interface AssetsSpaceConfigDto {
  strategy: AssetsStrategyDto;
  s3?: AssetsS3ConfigDto;
}

export interface SpaceRefDto {
  id: string;
  path: string;
  repo?: string;
}

export interface AgentConfigDto {
  clis?: string[];
  defaultModel?: string;
  systemPrompt?: string;
  maxTurns?: number;
  maxTimeout?: number;
}

export interface SpaceDefaultsDto {
  agent?: AgentConfigDto;
}

export interface SpaceConfigDto {
  name: string;
  description: string;
  icon: string;
  spaces?: SpaceRefDto[];
  agent?: AgentConfigDto;
  defaults?: SpaceDefaultsDto;
  git?: GitSpaceConfigDto;
  assets?: AssetsSpaceConfigDto;
}

export interface TreeNodeDto {
  name: string;
  path: string;
  title: string;
  icon: string | null;
  description?: string | null;
  has_changes: boolean;
  has_schema: boolean;
  parent?: string | null;
  kind?: "document" | "folder" | "collection";
  hasChildren?: boolean;
  has_children?: boolean;
  children: TreeNodeDto[];
}

export type SpaceFileEventKindDto =
  | "document"
  | "schema"
  | "folder"
  | "unknown";

export interface SpaceFileEventDto {
  space?: string;
  path: string;
  kind?: SpaceFileEventKindDto;
  isDir?: boolean;
  parentPath?: string | null;
  affectsTree?: boolean;
  affectsMetadata?: boolean;
  writeNonce?: string;
}

export interface SpaceDirtyEventDto {
  space: string;
  affectsTree?: boolean;
}
