import {
  getRepositoryAccess,
  verifyRepositoryAccess,
  type RepositoryAccessSnapshotDto,
} from "@/platform/git/repository-access-api";

import type { RepositoryAccessSnapshot } from "../model/repository-access";

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
