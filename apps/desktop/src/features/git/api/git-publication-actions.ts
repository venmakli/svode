import {
  getGitPublicationStatus,
  getGitRemote,
  retryGitParent,
  listenGitPublication,
} from "@/platform/git/git-api";
import type {
  GitStatusDto,
  PublicationStatusDto,
} from "@/platform/git/git-types";
import {
  gitAuthChallengeFromRemoteUrl,
  useGitStore,
  selectPublication,
  type GitSyncOutcome,
} from "../model";
import { gitSyncErrorMessage } from "./git-sync-error";
import { toParentPublication } from "./git-mappers";

function apply(path: string, dto: PublicationStatusDto | null) {
  useGitStore.getState().setPublication(
    path,
    dto
      ? {
          ...dto,
          inspectionError: dto.inspectionError
            ? gitSyncErrorMessage(dto.inspectionError)
            : undefined,
          parent: toParentPublication(dto.parent),
        }
      : null,
  );
}

export function recordSavedPublication(path: string, dto: GitStatusDto) {
  if (!dto.parent) {
    apply(path, null);
    return;
  }
  if (dto.parent)
    apply(path, { childHead: "", child: "local", parent: dto.parent });
}

export function recordSyncPublication(path: string, outcome: GitSyncOutcome) {
  if (outcome.type === "Success" && !outcome.parent) {
    apply(path, null);
    return;
  }
  if (outcome.type === "Success" && outcome.parent) {
    useGitStore.getState().setPublication(path, {
      childHead: outcome.publishedHead ?? "",
      child: "published",
      parent: outcome.parent,
    });
  }
}

export async function refreshGitPublication(path: string): Promise<void> {
  const current = useGitStore.getState().beginPublicationRead(path);
  const before = selectPublication(useGitStore.getState(), path);
  const dto = await getGitPublicationStatus(path);
  if (!current()) return;
  if (
    dto &&
    before?.childHead === dto.childHead &&
    dto.parent.pointer !== "published" &&
    !dto.parent.error
  ) {
    dto.parent.error = before.parent.error;
    dto.parent.policySkipped = before.parent.policySkipped;
    if (before.parent.result?.type === "Conflict")
      dto.parent.result = {
        type: "conflict",
        files: before.parent.result.files,
      };
    if (before.parent.result?.type === "AuthRequired")
      dto.parent.result = {
        type: "authRequired",
        challenge: before.parent.result.challenge,
      };
  }
  apply(path, dto);
}

export async function retryParentPublication(
  path: string,
  pending = selectPublication(useGitStore.getState(), path),
) {
  if (!pending?.childHead || !pending.parent.target) {
    await refreshGitPublication(path);
    return;
  }
  const dto = await retryGitParent({
    spacePath: path,
    expectedHead: pending.childHead,
    expectedParent: pending.parent.repository,
    expectedTarget: pending.parent.target,
  });
  if (selectPublication(useGitStore.getState(), path) === pending)
    apply(path, dto);
}

export function listenPublicationOutcomes() {
  return listenGitPublication((event) => apply(event.spacePath, event));
}

export async function getParentAuthChallenge(path: string) {
  const remoteUrl = await getGitRemote(path);
  return remoteUrl
    ? gitAuthChallengeFromRemoteUrl({ remoteUrl, operation: "sync" })
    : null;
}
