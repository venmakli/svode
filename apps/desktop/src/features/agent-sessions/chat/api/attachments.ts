import { searchEntriesByTitle } from "@/features/search";
import type { SvodeDraggedResource } from "@/features/space/resource-drag";
import {
  homeDirectory,
  pathExists,
  pathKind,
  readLocalFile,
  searchProjectFiles,
  type PathKindDto,
} from "@/platform/filesystem/path-api";
import { inspectManagedImportSource } from "@/platform/attachments/attachments-api";
import {
  readClipboardFilePaths,
  savePastedImage,
} from "@/platform/native/clipboard";
import { openDialog } from "@/platform/native/dialog";
import { openPath } from "@/platform/native/shell";
import { readPage } from "@/platform/pages/pages-api";
import {
  attachmentKind,
  attachmentOf,
  fileName,
  folderAttachment,
  type Attachment,
} from "../model/attachments";
import { isNetworkPath } from "@/shared/lib/local-paths";

export { pathExists as attachmentExists, readClipboardFilePaths, savePastedImage };
export type { PathKindDto as LocalPathKind };

/**
 * Whether `path` names a file or a folder; null when nothing is there. A
 * link opens what it cannot read as well.
 */
export async function localPathKind(path: string): Promise<PathKindDto | null> {
  return (await pathKind(path))?.kind ?? null;
}

/**
 * What a drop attaches: a file or a folder that can be read, else null. A
 * network share is refused without looking at it (`08` security).
 */
async function readableKind(path: string): Promise<PathKindDto | null> {
  if (isNetworkPath(path)) return null;
  const local = await pathKind(path).catch(() => null);
  return local?.readable ? local.kind : null;
}

/** A web page in the browser, a folder in the file manager, a file in its app. */
export { openPath as openInSystem };

let home: Promise<string | null> | null = null;

/** The home folder `~` names; read once. */
export function homeFolder(): Promise<string | null> {
  home ??= homeDirectory().catch(() => null);
  return home;
}

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

/**
 * What a drop attaches (`08` R5), or the names of what is not there or
 * cannot be read: then nothing is attached.
 */
export type DroppedAttachments =
  | { ok: true; attachments: Attachment[] }
  | { ok: false; unavailable: string[] };

/** Files and folders of the OS: a folder links its directory. */
export async function droppedPathAttachments(
  paths: string[],
): Promise<DroppedAttachments> {
  const kinds = await Promise.all(
    paths.map((path) => readableKind(path)),
  );
  const unavailable = paths.filter((_, index) => kinds[index] === null);
  if (unavailable.length > 0) {
    return { ok: false, unavailable: unavailable.map((path) => fileName(path)) };
  }
  return {
    ok: true,
    attachments: paths.map((path, index) =>
      kinds[index] === "directory" ? folderAttachment(path) : attachmentOf(path),
    ),
  };
}

/**
 * A sidebar resource: a page by its title, as an `@` mention gives it, a
 * file by its name, a folder or a collection by its directory.
 */
export async function droppedResourceAttachment(
  resource: SvodeDraggedResource,
): Promise<DroppedAttachments> {
  const title = resource.title || undefined;
  const name = title ?? fileName(resource.relativePath);
  const relative = resource.relativePath.split(/[\\/]/);
  if (
    /^([\\/]|[A-Za-z]:)/.test(resource.relativePath) ||
    relative.includes("..")
  ) {
    return { ok: false, unavailable: [name] };
  }
  const path = joinPath(resource.spacePath, resource.relativePath);
  const kind = await readableKind(path);
  if (kind === null) return { ok: false, unavailable: [name] };
  if (kind === "file") {
    return {
      ok: true,
      attachments: [
        attachmentKind(path) === "page"
          ? attachmentOf(path, title)
          : attachmentOf(path),
      ],
    };
  }
  if (resource.kind === "file") {
    // A page with its own directory is its README.
    const readme = joinPath(path, "README.md");
    if ((await readableKind(readme)) === "file") {
      return { ok: true, attachments: [attachmentOf(readme, name)] };
    }
  }
  return { ok: true, attachments: [folderAttachment(path, name)] };
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
