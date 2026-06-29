import type {
  GitAvailabilityDto,
  GitStatusDto,
  SyncResultDto,
} from "@/platform/git/git-types";
import type { GitAvailability, GitStatus, SyncResult } from "../model";

export function toGitAvailability(dto: GitAvailabilityDto): GitAvailability {
  return {
    git: dto.git,
    gitLfs: dto.gitLfs,
    gitVersion: dto.gitVersion,
    gitLfsVersion: dto.gitLfsVersion,
  };
}

export function toGitStatus(dto: GitStatusDto): GitStatus {
  return {
    branch: dto.branch,
    ahead: dto.ahead,
    behind: dto.behind,
    hasStaged: dto.hasStaged,
    hasUnstaged: dto.hasUnstaged,
    hasConflicts: dto.hasConflicts,
    tracking: dto.tracking,
    files: dto.files.map((file) => ({
      path: file.path,
      state: file.state,
    })),
  };
}

export function toSyncResult(dto: SyncResultDto): SyncResult {
  switch (dto.type) {
    case "conflict":
      return { type: "Conflict", files: [...dto.files] };
    case "success":
      return { type: "Success" };
    case "noRemote":
      return { type: "NoRemote" };
    case "authRequired":
      return { type: "AuthRequired" };
    default:
      throw new Error(`Unknown git sync result: ${JSON.stringify(dto)}`);
  }
}
