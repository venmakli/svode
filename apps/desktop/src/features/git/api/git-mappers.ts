import type {
  GitAuthChallengeDto,
  GitAvailabilityDto,
  GitStatusDto,
  ParentPublicationDto,
  SyncResultDto,
} from "@/platform/git/git-types";
import type {
  GitAuthChallenge,
  GitAvailability,
  GitStatus,
  ParentPublication,
  SyncResult,
} from "../model";

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
    ...(dto.repository ? { repository: dto.repository } : {}),
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
      return {
        type: "Success",
        ...(dto.publishedHead ? { publishedHead: dto.publishedHead } : {}),
        ...(dto.parent
          ? {
              parent: toParentPublication(dto.parent),
            }
          : {}),
      };
    case "noRemote":
      return { type: "NoRemote" };
    case "authRequired":
      return {
        type: "AuthRequired",
        challenge: dto.challenge ? toGitAuthChallenge(dto.challenge) : null,
      };
    default:
      throw new Error(`Unknown git sync result: ${JSON.stringify(dto)}`);
  }
}

export function toGitAuthChallenge(dto: GitAuthChallengeDto): GitAuthChallenge {
  return {
    operation: dto.operation,
    authMethod: dto.authMethod,
    remoteUrl: dto.remoteUrl,
    host: dto.host,
    repository: dto.repository,
    providerHint: dto.providerHint,
    detail: dto.detail,
  };
}

export function toParentPublication(
  dto: ParentPublicationDto,
): ParentPublication {
  return {
    ...dto,
    error:
      typeof dto.error === "string"
        ? { kind: "git_command_failed", message: dto.error }
        : dto.error,
    result: dto.result ? toSyncResult(dto.result) : undefined,
  };
}
