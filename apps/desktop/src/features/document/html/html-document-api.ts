import { filePreferenceKey } from "@/features/external-open";
import {
  findHtmlDocumentApp,
  inspectLocalHtmlDocument,
  listenHtmlDocumentChanges,
  listLocalHtmlDocumentExternalApps,
  openLocalHtmlDocumentExternal,
  readLocalHtmlDocument,
  revealLocalHtmlDocumentExternal,
  revokeHtmlDocument,
  serveHtmlDocument,
  setHtmlDocumentTheme,
  type HtmlDocumentFailureKindDto,
  type HtmlDocumentServingDto,
  type HtmlDocumentSourceDto,
  type HtmlThemeDto,
} from "@/platform/document/document-api";

import type { DocumentTarget, LocalDocumentFile } from "../model/types";

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

/**
 * The App whose files include an HTML file of the project (Stage 11 `06`
 * H1): an App directory of its Space, by its path in that Space, or the
 * Space itself when it holds the `app.yaml`.
 */
export type HtmlDocumentApp =
  | { kind: "app-directory"; path: string }
  | { kind: "space" };

/** The App the HTML file at `path` belongs to, which it opens; null outside Apps. */
export async function htmlDocumentApp(input: {
  projectPath: string;
  spaceId: string | null;
  path: string;
}): Promise<HtmlDocumentApp | null> {
  const directory = await findHtmlDocumentApp({
    projectPath: input.projectPath,
    spaceId: input.spaceId,
    targetPath: input.path,
  });
  if (directory === null) return null;
  return directory === "."
    ? { kind: "space" }
    : { kind: "app-directory", path: directory };
}

/** An HTML file outside the project by its absolute path, only to view it. */
export function localHtmlDocumentFile(path: string): LocalDocumentFile {
  return {
    path,
    inspect: () => inspectLocalHtmlDocument(path),
    read: (expectedGeneration) =>
      readLocalHtmlDocument(path, expectedGeneration),
    externalOpen: {
      preferenceKey: filePreferenceKey(path),
      listApps: () => listLocalHtmlDocumentExternalApps(path),
      open: (appId) => openLocalHtmlDocumentExternal(path, appId),
      reveal: () => revealLocalHtmlDocumentExternal(path),
    },
  };
}
