import { invokeCommand } from "@/platform/native/invoke";
import { listen, type UnlistenFn } from "@/platform/native/events";
import type { ExternalAppDto } from "@/platform/project-openers";

export type DocumentFormatDto =
  | "pdf"
  | "docx"
  | "xlsx"
  | "pptx"
  | "doc"
  | "xls"
  | "ppt"
  | "docm"
  | "xlsm"
  | "pptm"
  | "odt"
  | "ods"
  | "odp";

export interface DocumentSourceDescriptorDto {
  format: DocumentFormatDto;
  sizeBytes: number;
  generation: string;
}

export interface DocumentSourceInvalidatedDto {
  spacePath: string;
  changes: Array<{ path: string; kind: "page" | "binary" | "boundary" }>;
}

export interface DocumentSourceInputDto {
  projectPath: string;
  spaceId: string | null;
  targetPath: string;
}

export function inspectDocumentSource(
  input: DocumentSourceInputDto,
): Promise<DocumentSourceDescriptorDto> {
  return invokeCommand<DocumentSourceDescriptorDto>("document_inspect_source", {
    ...input,
  });
}

export async function readDocumentSource(
  input: DocumentSourceInputDto & { expectedGeneration: string },
): Promise<Uint8Array> {
  const response = await invokeCommand<ArrayBuffer | Uint8Array>(
    "document_read_source",
    { ...input },
  );
  return response instanceof Uint8Array ? response : new Uint8Array(response);
}

export function listDocumentExternalApps(
  input: DocumentSourceInputDto,
): Promise<ExternalAppDto[]> {
  return invokeCommand<ExternalAppDto[]>("document_list_external_apps", {
    ...input,
  });
}

/** Opens the file in `appId`, or in the OS default application for `null`. */
export function openDocumentExternal(
  input: DocumentSourceInputDto,
  appId: string | null,
): Promise<void> {
  return invokeCommand("document_open_external", { ...input, appId });
}

export function revealDocumentExternal(
  input: DocumentSourceInputDto,
): Promise<void> {
  return invokeCommand("document_reveal_external", { ...input });
}

export function listenDocumentSourceInvalidated(
  handler: (payload: DocumentSourceInvalidatedDto) => void,
): Promise<UnlistenFn> {
  return listen<DocumentSourceInvalidatedDto>(
    "attachments:invalidated",
    (event) => handler(event.payload),
  );
}
