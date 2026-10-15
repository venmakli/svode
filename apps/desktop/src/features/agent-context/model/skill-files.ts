import type { AttachmentRow } from "@/features/attachments";

import type { AgentContextSkillFile } from "./types";

/**
 * A skill file as a row of the Attachments Table: a folder is a branch, a
 * Markdown file reads as a Page, documents and media keep their types.
 */
export function skillFileRow(file: AgentContextSkillFile): AttachmentRow {
  const folder = file.kind === "directory";
  return {
    availability: file.availability,
    contentPath: folder ? null : file.path,
    displayName: file.name,
    format: file.format,
    hasApp: false,
    hasChildren: folder,
    icon: null,
    key: `${file.kind}:${file.path}`,
    kind: file.kind === "markdown" ? "page" : file.kind,
    modified: file.modifiedAt ?? "",
    ownerPath: folder ? file.path : null,
    path: file.path,
    sizeBytes: file.sizeBytes,
    sourcePath: file.path,
    sourceShape: folder ? "directory" : "file",
  };
}
