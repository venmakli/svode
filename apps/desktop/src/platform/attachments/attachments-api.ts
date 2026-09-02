import { invokeCommand } from "@/platform/native/invoke";
import { listen, type UnlistenFn } from "@/platform/native/events";

export type AttachmentKindDto = "page" | "document" | "media";
export type AttachmentAvailabilityDto =
  | "available"
  | "limited"
  | "external_only";

export interface AttachmentItemDto {
  key: string;
  path: string;
  sourceShape: "file" | "directory";
  kind: AttachmentKindDto;
  format: string;
  availability: AttachmentAvailabilityDto;
  displayName: string;
  modified: string;
  sizeBytes: number | null;
}

export interface AttachmentsSnapshotDto {
  owner: {
    projectPath: string;
    spaceId: string | null;
    spacePath: string;
    ownerPath: string;
    repositoryPath: string;
  };
  generation: string;
  items: AttachmentItemDto[];
  diagnostics: Array<{ code: string; path: string }>;
}

export interface AttachmentsInvalidatedEventDto {
  spacePath: string;
  ownerPath: string;
  generation: number;
  changes: Array<{
    path: string;
    kind: "page" | "binary" | "boundary";
  }>;
}

export type AttachmentOwnerLifecycleEventDto =
  | {
      kind: "synced";
      projectPath: string;
      spaceId: string | null;
    }
  | {
      kind: "registered" | "removed";
      projectPath: string;
      spaceId: string;
    }
  | {
      kind: "status_changed";
      projectPath: string;
      spaceId: string;
      oldStatus: "ready" | "missing" | "broken";
      newStatus: "ready" | "missing" | "broken";
    };

export function listAttachments(input: {
  projectPath: string;
  spaceId: string | null;
  ownerPath: string;
}): Promise<AttachmentsSnapshotDto> {
  return invokeCommand<AttachmentsSnapshotDto>("attachments_list", input);
}

export interface ManagedImportSourceInfoDto {
  name: string;
  sizeBytes: number;
  mime: string;
}

export interface ManagedImportResultDto {
  contentPath: string;
  attachmentPath: string;
  markdownUrl: string;
  coverPath: string;
  fileName: string;
  mime: string;
  sizeBytes: number;
  changedPaths: string[];
}

export function inspectManagedImportSource(
  sourcePath: string,
): Promise<ManagedImportSourceInfoDto> {
  return invokeCommand<ManagedImportSourceInfoDto>(
    "attachments_inspect_import_source",
    { sourcePath },
  );
}

export function importManagedAttachment(input: {
  projectPath: string;
  spaceId: string | null;
  contentPath: string;
  sourcePath: string;
  fileName?: string | null;
}): Promise<ManagedImportResultDto> {
  return invokeCommand<ManagedImportResultDto>("attachments_import_file", {
    ...input,
  });
}

export function listenAttachmentsInvalidated(
  handler: (payload: AttachmentsInvalidatedEventDto) => void,
): Promise<UnlistenFn> {
  return listen<AttachmentsInvalidatedEventDto>(
    "attachments:invalidated",
    (event) => handler(event.payload),
  );
}

export async function listenAttachmentOwnerLifecycle(
  handler: (payload: AttachmentOwnerLifecycleEventDto) => void,
): Promise<UnlistenFn> {
  const unlisten = await Promise.all([
    listen<{ projectPath: string; spaceId?: string | null }>(
      "space:synced",
      (event) =>
        handler({
          kind: "synced",
          projectPath: event.payload.projectPath,
          spaceId: event.payload.spaceId ?? null,
        }),
    ),
    listen<{ projectPath: string; spaceId: string }>("space:added", (event) =>
      handler({ kind: "registered", ...event.payload }),
    ),
    listen<{ projectPath: string; spaceId: string }>("space:removed", (event) =>
      handler({ kind: "removed", ...event.payload }),
    ),
    listen<{
      projectPath: string;
      spaceId: string;
      oldStatus: "ready" | "missing" | "broken";
      newStatus: "ready" | "missing" | "broken";
    }>("space:status_changed", (event) =>
      handler({ kind: "status_changed", ...event.payload }),
    ),
  ]);
  return () => {
    for (const dispose of unlisten) dispose();
  };
}
