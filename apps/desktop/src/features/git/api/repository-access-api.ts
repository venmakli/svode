import {
  getRepositoryAccess,
  listenRepositoryAccessChanged,
  toRepositoryAccessDeniedDto,
  verifyRepositoryAccess,
  type RepositoryAccessSnapshotDto,
} from "@/platform/git/repository-access-api";

import type {
  RepositoryAccessDenial,
  RepositoryAccessSnapshot,
} from "../model/repository-access";

export async function loadRepositoryAccess(
  spacePath: string,
): Promise<RepositoryAccessSnapshot> {
  return toRepositoryAccess(await getRepositoryAccess(spacePath));
}

export async function checkRepositoryAccess(
  spacePath: string,
): Promise<RepositoryAccessSnapshot> {
  return toRepositoryAccess(await verifyRepositoryAccess(spacePath));
}

export function listenToRepositoryAccessChanges(
  handler: (repositoryId: string) => void,
) {
  return listenRepositoryAccessChanged((event) => {
    handler(event.payload.repositoryId);
  });
}

export function repositoryAccessDenialFromError(
  error: unknown,
): RepositoryAccessDenial | null {
  const denial = toRepositoryAccessDeniedDto(error);
  return denial ? { ...denial } : null;
}

function toRepositoryAccess(
  dto: RepositoryAccessSnapshotDto,
): RepositoryAccessSnapshot {
  return Object.freeze({
    checkedAt: dto.checkedAt ?? null,
    expiresAt: dto.expiresAt ?? null,
    generation: dto.generation,
    lastKnownStatus: dto.lastKnownStatus ?? null,
    reason: dto.reason ?? null,
    repositoryId: dto.repositoryId,
    status: dto.status,
  });
}
