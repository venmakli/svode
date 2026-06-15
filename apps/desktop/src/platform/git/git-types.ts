export interface GitAvailabilityDto {
  git: boolean;
  gitLfs: boolean;
  gitVersion: string | null;
}

export type FileGitStateDto = "modified" | "untracked" | "conflict";

export interface FileGitStatusDto {
  path: string;
  state: FileGitStateDto;
}

export interface GitStatusDto {
  branch: string;
  ahead: number;
  behind: number;
  hasStaged: boolean;
  hasUnstaged: boolean;
  hasConflicts: boolean;
  tracking: string | null;
  files: FileGitStatusDto[];
}

export type SyncResultDto =
  | { type: "Success" }
  | { type: "Conflict"; files: string[] }
  | { type: "NoRemote" }
  | { type: "AuthRequired" };

export interface CloneProgressDto {
  spacePath: string;
  phase: string;
  percent: number;
}
