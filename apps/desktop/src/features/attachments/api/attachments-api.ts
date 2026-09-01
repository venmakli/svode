import {
  listAttachments as listAttachmentsDto,
  type AttachmentsSnapshotDto,
} from "@/platform/attachments/attachments-api";

import type { AttachmentOwnerInput, AttachmentsSnapshot } from "../model/types";

export async function getAttachmentsSnapshot(
  owner: AttachmentOwnerInput,
): Promise<AttachmentsSnapshot> {
  return snapshotFromDto(await listAttachmentsDto(owner));
}

function snapshotFromDto(dto: AttachmentsSnapshotDto): AttachmentsSnapshot {
  return {
    diagnostics: dto.diagnostics,
    generation: dto.generation,
    owner: dto.owner,
    rows: dto.items.map((item) => ({ ...item })),
  };
}
