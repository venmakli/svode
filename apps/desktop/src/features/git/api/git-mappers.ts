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
    case "Conflict":
      return { type: "Conflict", files: [...dto.files] };
    case "Success":
    case "NoRemote":
    case "AuthRequired":
      return { type: dto.type };
  }
}
