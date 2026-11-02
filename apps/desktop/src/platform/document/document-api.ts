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
  /** RFC 3339 UTC modification time of the file. */
  modifiedAt: string;
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

export function validateDocumentSource(
  input: DocumentSourceInputDto & { expectedGeneration: string },
): Promise<void> {
  return invokeCommand("document_validate_source", { ...input });
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

export type HtmlThemeDto = "light" | "dark";

/** A file inside a Space of the project, or a local file outside it. */
export type HtmlDocumentSourceDto =
  | {
      kind: "space";
      projectPath: string;
      spaceId: string | null;
      targetPath: string;
    }
  | { kind: "local"; path: string };

export interface HtmlDocumentServingDto {
  capabilityToken: string;
  /** The entry file on the loopback origin of this serving. */
  viewportUrl: string;
  sizeBytes: number;
  /** RFC 3339 UTC modification time of the file. */
  modifiedAt: string;
}

/** Why an HTML Document is not served. */
export type HtmlDocumentFailureKindDto =
  | "source_missing"
  | "symlink"
  | "unsupported_format"
  | "path_unresolved"
  | "source_inaccessible"
  | "resource_limit";

export interface HtmlDocumentFailureDto {
  kind: HtmlDocumentFailureKindDto;
  message: string;
  limitBytes?: number;
  actualBytes?: number;
}

/** Serves the file on its own loopback origin until it is revoked. */
export function serveHtmlDocument(
  source: HtmlDocumentSourceDto,
  theme: HtmlThemeDto,
): Promise<HtmlDocumentServingDto> {
  return invokeCommand<HtmlDocumentServingDto>("html_document_serve", {
    source,
    theme,
  });
}

/** The theme the next load of the entry file gets. */
export function setHtmlDocumentTheme(
  capabilityToken: string,
  theme: HtmlThemeDto,
): Promise<void> {
  return invokeCommand("html_document_set_theme", { capabilityToken, theme });
}

export function revokeHtmlDocument(capabilityToken: string): Promise<void> {
  return invokeCommand("html_document_revoke", { capabilityToken });
}

/** A file of the served root behind `capabilityToken` changed. */
export function listenHtmlDocumentChanges(
  capabilityToken: string,
  onChange: () => void,
): Promise<UnlistenFn> {
  return listen<{ capabilityToken: string }>(
    "document:html-source-changed",
    (event) => {
      if (event.payload.capabilityToken === capabilityToken) onChange();
    },
  );
}
