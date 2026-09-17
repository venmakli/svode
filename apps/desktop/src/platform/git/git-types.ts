export interface GitAvailabilityDto {
  git: boolean;
  gitLfs: boolean;
  gitVersion: string | null;
  gitLfsVersion: string | null;
}

export type FileGitStateDto = "modified" | "untracked" | "deleted" | "conflict";

export interface FileGitStatusDto {
  path: string;
  state: FileGitStateDto;
}

export interface GitStatusDto {
  repository?: string;
  parent?: ParentPublicationDto;
  branch: string;
  ahead: number;
  behind: number;
  hasStaged: boolean;
  hasUnstaged: boolean;
  hasConflicts: boolean;
  tracking: string | null;
  files: FileGitStatusDto[];
}

export interface UnpushedCommitDto {
  sha: string;
  message: string;
  author: string;
  timestamp: string;
}

export type GitRemoteOperationDto =
  | "sync"
  | "clone"
  | "first-push"
  | "fetch"
  | "lfs-diagnostics"
  | "lfs-fetch-pull"
  | "unknown";

export type GitRemoteAuthMethodDto = "https" | "ssh" | "unknown";

export interface GitAuthChallengeDto {
  operation: GitRemoteOperationDto;
  authMethod: GitRemoteAuthMethodDto;
  remoteUrl: string | null;
  host: string | null;
  repository: string | null;
  providerHint: string | null;
  detail: string | null;
}

export type SyncResultDto =
  | {
      type: "success";
      publishedHead?: string;
      parent?: ParentPublicationDto;
      remoteStatus?: GitStatusDto;
    }
  | { type: "conflict"; files: string[] }
  | { type: "noRemote" }
  | { type: "authRequired"; challenge?: GitAuthChallengeDto | null };

export interface ParentPublicationDto {
  repository: string;
  pointer: "pending" | "local" | "published";
  target?: string;
  result?: SyncResultDto;
  error?: string | { kind: string; [key: string]: unknown };
  policySkipped?: boolean;
}

export interface GitUserPolicyDto {
  autoSync: boolean;
  autoCommitStructural: boolean;
  autoCommitSystem: boolean;
}

export interface CloneProgressDto {
  spacePath: string;
  phase: string;
  percent: number;
}

export interface PublicationStatusDto {
  childHead: string;
  child: "local" | "published" | "unpublished" | "unknown";
  inspectionError?: string | { kind: string; [key: string]: unknown };
  parent: ParentPublicationDto;
}
