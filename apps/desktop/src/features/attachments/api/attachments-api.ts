import {
  importManagedAttachment,
  listAttachments as listAttachmentsDto,
  listenAttachmentOwnerLifecycle,
  listenAttachmentsInvalidated,
  type AttachmentOwnerLifecycleEventDto,
  type AttachmentsInvalidatedEventDto,
  type AttachmentsSnapshotDto,
  type ManagedImportResultDto,
} from "@/platform/attachments/attachments-api";
import type { UnlistenFn } from "@/platform/native/events";
import { pickMediaFilePaths } from "@/platform/filesystem/native-file-picker";

import type { AttachmentOwnerInput, AttachmentsSnapshot } from "../model/types";

export async function getAttachmentsSnapshot(
  owner: AttachmentOwnerInput,
): Promise<AttachmentsSnapshot> {
  return snapshotFromDto(await listAttachmentsDto(owner));
}

export async function pickAttachmentImportSource(): Promise<string | null> {
  const [sourcePath] = await pickMediaFilePaths("file", false);
  return sourcePath ?? null;
}

export function importAttachmentFile(
  input: Parameters<typeof importManagedAttachment>[0],
): Promise<ManagedImportResultDto> {
  return importManagedAttachment(input);
}

export function subscribeAttachmentsInvalidated(
  handler: (event: AttachmentsInvalidatedEventDto) => void,
): Promise<UnlistenFn> {
  return listenAttachmentsInvalidated(handler);
}

export function subscribeAttachmentOwnerLifecycle(
  handler: (event: AttachmentOwnerLifecycleEventDto) => void,
): Promise<UnlistenFn> {
  return listenAttachmentOwnerLifecycle(handler);
}

export type { AttachmentOwnerLifecycleEventDto };

function snapshotFromDto(dto: AttachmentsSnapshotDto): AttachmentsSnapshot {
  return {
    diagnostics: dto.diagnostics,
    generation: dto.generation,
    owner: dto.owner,
    rows: dto.items.map((item) => ({ ...item })),
  };
}
