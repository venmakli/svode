import { searchEntriesByTitle } from "@/features/search";
import {
  pathExists,
  readLocalFile,
  searchProjectFiles,
} from "@/platform/filesystem/path-api";
import { inspectManagedImportSource } from "@/platform/attachments/attachments-api";
import {
  readClipboardFilePaths,
  savePastedImage,
} from "@/platform/native/clipboard";
import { openDialog } from "@/platform/native/dialog";
import { readPage } from "@/platform/pages/pages-api";
import { attachmentOf, type Attachment } from "../model/attachments";

export { pathExists as attachmentExists, readClipboardFilePaths, savePastedImage };

/** Files the user picks on disk; nothing when the dialog is cancelled. */
export async function pickDiskFiles(): Promise<Attachment[]> {
  const picked = await openDialog({ multiple: true, directory: false });
  if (!picked) return [];
  return (Array.isArray(picked) ? picked : [picked]).map((path) =>
    attachmentOf(path),
  );
}

/** What a mention offers: pages by title, then files by name. */
export interface MentionTarget {
  kind: "page" | "file";
  attachment: Attachment;
  /** Where it lives, relative to the project. */
  location: string;
  icon: string | null;
}

const MENTION_LIMIT = 8;

export async function searchMentionTargets(
  projectPath: string,
  query: string,
): Promise<MentionTarget[]> {
  const [pages, files] = await Promise.all([
    searchEntriesByTitle({ projectPath, query, limit: MENTION_LIMIT }).catch(
      () => ({ items: [] }),
    ),
    searchProjectFiles(projectPath, query, MENTION_LIMIT).catch(() => []),
  ]);
  const targets: MentionTarget[] = pages.items.map((item) => {
    const path = joinPath(item.spacePath, item.path);
    return {
      kind: "page",
      attachment: { path, name: item.title || item.path },
      location: relativeTo(projectPath, path),
      icon: item.icon || null,
    };
  });
  for (const path of files) {
    targets.push({
      kind: "file",
      attachment: attachmentOf(path),
      location: relativeTo(projectPath, path),
      icon: null,
    });
  }
  return targets;
}

const IMAGE_PREVIEW_LIMIT = 10 * 1024 * 1024;

/** A thumbnail of a local image within a size bound; null beyond it. */
export async function readImagePreview(path: string): Promise<Blob | null> {
  const source = await inspectManagedImportSource(path);
  if (source.sizeBytes > IMAGE_PREVIEW_LIMIT) return null;
  return readLocalFile(path);
}

export interface PagePreview {
  title: string;
  lines: string[];
}

/** The title and first lines of a page in the Space at `spacePath`. */
export async function readPagePreview(
  spacePath: string,
  path: string,
): Promise<PagePreview> {
  const page = await readPage(spacePath, path);
  const lines = page.body
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, 3);
  return { title: page.meta.title, lines };
}

function joinPath(base: string, path: string): string {
  return `${base.replace(/[\\/]+$/, "")}/${path.replace(/^[\\/]+/, "")}`;
}

export function relativeTo(root: string, path: string): string {
  const prefix = `${root.replace(/[\\/]+$/, "")}/`;
  return path.startsWith(prefix) ? path.slice(prefix.length) : path;
}
