import type { ArtifactRegistryKind } from "@/features/artifact";
import {
  chatAttachmentKind,
  type ChatAttachmentLocation,
} from "@/features/agent-sessions";
import {
  AUDIO_EXTS,
  DOCUMENT_EXTS,
  IMAGE_EXTS,
  VIDEO_EXTS,
} from "@/platform/upload/media-types";
import { isNetworkPath } from "@/shared/lib/local-paths";

/**
 * Where a badge, link or changed file of the chat opens (Stage 10 `04`,
 * DF-233 R1, Stage 11 `06` H1): an object of the project in a peek, an
 * HTML file of the project after asking whether it is a file of an App,
 * media and HTML outside the project in the same peek only to view them,
 * anything else in its system application.
 */
export type ChatAttachmentRoute =
  | { kind: ArtifactRegistryKind; location: ChatAttachmentLocation }
  | { kind: "html"; location: ChatAttachmentLocation }
  | { kind: "local-media" }
  | { kind: "local-document" }
  | { kind: "system" };

const MEDIA_EXTENSIONS = new Set<string>([
  ...IMAGE_EXTS,
  ...VIDEO_EXTS,
  ...AUDIO_EXTS,
]);
const DOCUMENT_EXTENSIONS = new Set<string>(DOCUMENT_EXTS);

export function chatAttachmentRoute(
  path: string,
  location: ChatAttachmentLocation | null,
): ChatAttachmentRoute {
  const kind = viewerKind(path);
  if (location && kind) return { kind, location };
  // A network path is not a local object: never shown, not even read.
  if (isNetworkPath(path)) return { kind: "system" };
  if (kind === "media") return { kind: "local-media" };
  if (kind === "html") return { kind: "local-document" };
  return { kind: "system" };
}

/** An HTML file of the project: its App when it is a file of one. */
export function htmlRoute(
  location: ChatAttachmentLocation,
  appDirectory: string | null,
): ChatAttachmentRoute {
  return appDirectory === null
    ? { kind: "document", location }
    : { kind: "page", location: { ...location, path: appDirectory } };
}

function viewerKind(path: string): ArtifactRegistryKind | "html" | null {
  if (chatAttachmentKind(path) === "page") return "page";
  const dot = path.lastIndexOf(".");
  const extension = dot >= 0 ? path.slice(dot).toLowerCase() : "";
  if (extension === ".html" || extension === ".htm") return "html";
  if (MEDIA_EXTENSIONS.has(extension)) return "media";
  if (DOCUMENT_EXTENSIONS.has(extension)) return "document";
  return null;
}
