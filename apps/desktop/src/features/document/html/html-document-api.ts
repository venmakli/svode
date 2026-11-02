import {
  listenHtmlDocumentChanges,
  revokeHtmlDocument,
  serveHtmlDocument,
  setHtmlDocumentTheme,
  type HtmlDocumentFailureKindDto,
  type HtmlDocumentServingDto,
  type HtmlDocumentSourceDto,
  type HtmlThemeDto,
} from "@/platform/document/document-api";

import type { DocumentTarget } from "../model/types";

export type HtmlTheme = HtmlThemeDto;
export type HtmlDocumentServing = HtmlDocumentServingDto;

/** Why the page is not shown (Stage 11 `06` H3). */
export type HtmlDocumentRefusal = Exclude<
  HtmlDocumentFailureKindDto,
  "source_missing"
>;

export type HtmlDocumentFailure =
  | { kind: "missing" }
  | { kind: "refused"; reason: HtmlDocumentRefusal };

export class HtmlDocumentError extends Error {
  constructor(readonly failure: HtmlDocumentFailure) {
    super(failure.kind === "missing" ? "source_missing" : failure.reason);
  }
}

export async function serveDocumentPage(
  target: DocumentTarget,
  theme: HtmlTheme,
): Promise<HtmlDocumentServing> {
  try {
    return await serveHtmlDocument(servingSource(target), theme);
  } catch (error) {
    throw new HtmlDocumentError(htmlDocumentFailure(error));
  }
}

export function revokeDocumentPage(capabilityToken: string) {
  void revokeHtmlDocument(capabilityToken).catch((error: unknown) => {
    console.error("Failed to revoke an HTML Document:", error);
  });
}

export function setDocumentPageTheme(
  capabilityToken: string,
  theme: HtmlTheme,
): Promise<void> {
  return setHtmlDocumentTheme(capabilityToken, theme);
}

export function subscribeDocumentPageChanges(
  capabilityToken: string,
  onChange: () => void,
): Promise<() => void> {
  return listenHtmlDocumentChanges(capabilityToken, onChange);
}

function htmlDocumentFailure(error: unknown): HtmlDocumentFailure {
  if (error instanceof HtmlDocumentError) return error.failure;
  const kind =
    typeof error === "object" && error !== null && "kind" in error
      ? error.kind
      : null;
  switch (kind) {
    case "source_missing":
      return { kind: "missing" };
    case "symlink":
    case "unsupported_format":
    case "path_unresolved":
    case "resource_limit":
      return { kind: "refused", reason: kind };
    default:
      return { kind: "refused", reason: "source_inaccessible" };
  }
}

function servingSource(target: DocumentTarget): HtmlDocumentSourceDto {
  return target.kind === "local"
    ? { kind: "local", path: target.path }
    : {
        kind: "space",
        projectPath: target.projectPath,
        spaceId: target.spaceId,
        targetPath: target.path,
      };
}
