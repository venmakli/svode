import type { TElement, Value } from "platejs";
import type {
  AgentMessageSegmentDto,
  AgentPromptPartDto,
} from "@/platform/agent-runtime/agent-runtime-api";
import {
  isDrivePath,
  isNetworkPath,
  pathKey,
  withoutVerbatimPrefix,
} from "./local-paths";

/**
 * A file in a draft or a user message (Stage 10 `04`, attachments): a link
 * by its absolute path, never a copy of the file.
 */
export interface Attachment {
  path: string;
  name: string;
}

export type AttachmentKind = "page" | "image" | "file" | "folder";

const IMAGE_EXTENSIONS = new Set([
  "png",
  "jpg",
  "jpeg",
  "gif",
  "webp",
  "svg",
  "avif",
  "heic",
  "bmp",
  "tiff",
]);

export function fileExtension(path: string): string {
  const name = fileName(path);
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
}

/**
 * What a badge shows by the path alone. A folder's path ends with its
 * separator, as the URI of a linked directory does (`02` C6), so a replayed
 * message shows it as a folder too.
 */
export function attachmentKind(path: string): AttachmentKind {
  if (/[\\/]$/.test(path)) return "folder";
  const extension = fileExtension(path);
  if (extension === "md") return "page";
  return IMAGE_EXTENSIONS.has(extension) ? "image" : "file";
}

export function fileName(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).at(-1) ?? path;
}

export function attachmentOf(path: string, name?: string): Attachment {
  return { path, name: name ?? fileName(path) };
}

/** A folder or a collection: its path ends with the separator. */
export function folderAttachment(path: string, name?: string): Attachment {
  const separator = path.includes("/") || !path.includes("\\") ? "/" : "\\";
  const folder = /[\\/]$/.test(path) ? path : path + separator;
  return attachmentOf(folder, name);
}

/** A draft as written: text and attachments in order. */
export type DraftPart =
  | { type: "text"; text: string }
  | { type: "attachment"; attachment: Attachment };

/** The Plate element of an attachment badge in the composer. */
export const ATTACHMENT_ELEMENT = "chat_attachment";

export interface AttachmentElement extends TElement {
  type: typeof ATTACHMENT_ELEMENT;
  path: string;
  name: string;
  children: [{ text: "" }];
}

export function attachmentElement(attachment: Attachment): AttachmentElement {
  return {
    type: ATTACHMENT_ELEMENT,
    path: attachment.path,
    name: attachment.name,
    children: [{ text: "" }],
  };
}

/** Adjacent texts joined, empty ones dropped. */
export function normalizeDraftParts(parts: DraftPart[]): DraftPart[] {
  const normalized: DraftPart[] = [];
  for (const part of parts) {
    if (part.type === "text") {
      if (!part.text) continue;
      const last = normalized.at(-1);
      if (last?.type === "text") {
        normalized[normalized.length - 1] = {
          type: "text",
          text: last.text + part.text,
        };
        continue;
      }
    }
    normalized.push(part);
  }
  return normalized;
}

/** Nothing to send: no attachment and only blank text. */
export function isDraftBlank(parts: DraftPart[]): boolean {
  return parts.every(
    (part) => part.type === "text" && part.text.trim().length === 0,
  );
}

export function draftAttachments(parts: DraftPart[]): Attachment[] {
  return parts.flatMap((part) =>
    part.type === "attachment" ? [part.attachment] : [],
  );
}

/** The one-block editor value of a draft; inline badges sit between texts. */
export function draftValue(parts: DraftPart[]): Value {
  const children: Value[number]["children"] = [];
  for (const part of normalizeDraftParts(parts)) {
    if (part.type === "text") {
      // The empty text after a badge takes the next text.
      if (children.at(-1)?.text === "") children.pop();
      children.push({ text: part.text });
    } else {
      if (children.length === 0) children.push({ text: "" });
      children.push(attachmentElement(part.attachment));
      children.push({ text: "" });
    }
  }
  if (children.length === 0) children.push({ text: "" });
  return [{ type: "p", children }];
}

/**
 * The draft an editor value holds. An open mention search is not part of
 * it: its query lives in the combobox until a choice inserts a badge.
 */
export function draftParts(value: Value): DraftPart[] {
  const parts: DraftPart[] = [];
  value.forEach((block, index) => {
    if (index > 0) parts.push({ type: "text", text: "\n" });
    for (const child of block.children) {
      if (typeof child.text === "string") {
        parts.push({ type: "text", text: child.text });
      } else if (
        child.type === ATTACHMENT_ELEMENT &&
        typeof child.path === "string" &&
        typeof child.name === "string"
      ) {
        parts.push({
          type: "attachment",
          attachment: { path: child.path, name: child.name },
        });
      }
    }
  });
  return normalizeDraftParts(parts);
}

/** The prompt of a draft: text and file links in the order they were typed. */
export function promptParts(parts: DraftPart[]): AgentPromptPartDto[] {
  return normalizeDraftParts(parts).map((part) =>
    part.type === "text"
      ? { type: "text", text: part.text }
      : { type: "file", path: part.attachment.path, name: part.attachment.name },
  );
}

/** A part of a user message as the timeline shows it. */
export type MessagePart =
  | { type: "text"; text: string }
  | { type: "attachment"; attachment: Attachment }
  /** An image the agent replayed without a file. */
  | { type: "image"; name: string | null };

/** `[@name](file://…)`: how Claude Code and Codex adapters replay a link. */
const REPLAYED_LINK = /\[@([^\]\n]+)\]\((file:\/\/[^)\s]+)\)/g;

/**
 * The parts of a user message: its segments, or its text when it has
 * none; links the adapter replayed as text become badges again, anything
 * unrecognized stays text. An image right after the badge of its own image
 * file is that badge: the prompt sent both the link and the image.
 */
export function messageParts(
  segments: AgentMessageSegmentDto[],
  text: string,
): MessagePart[] {
  if (segments.length === 0) return textParts(text);
  const parts: MessagePart[] = [];
  for (const segment of segments) {
    if (segment.type === "text") {
      parts.push(...textParts(segment.text));
      continue;
    }
    const path = segment.uri ? fileUriToPath(segment.uri) : null;
    if (path) {
      parts.push({
        type: "attachment",
        attachment: attachmentOf(path, segment.name ?? undefined),
      });
    } else if (segment.type === "image") {
      const previous = parts.at(-1);
      const ofPrevious =
        previous?.type === "attachment" &&
        attachmentKind(previous.attachment.path) === "image";
      if (!ofPrevious) parts.push({ type: "image", name: segment.name });
    } else {
      parts.push({ type: "text", text: `@${segment.name}` });
    }
  }
  return parts;
}

function textParts(text: string): MessagePart[] {
  const parts: MessagePart[] = [];
  let last = 0;
  for (const match of text.matchAll(REPLAYED_LINK)) {
    const path = fileUriToPath(match[2]);
    if (!path) continue;
    if (match.index > last) {
      parts.push({ type: "text", text: text.slice(last, match.index) });
    }
    parts.push({
      type: "attachment",
      attachment: attachmentOf(path, decodedName(match[1])),
    });
    last = match.index + match[0].length;
  }
  if (last < text.length) parts.push({ type: "text", text: text.slice(last) });
  return parts;
}

/** Claude Code replays a name percent-encoded, as in its URI. */
function decodedName(name: string): string {
  try {
    return decodeURIComponent(name);
  } catch {
    return name;
  }
}

/**
 * The absolute path of a local `file://` URI, or null for any other URI;
 * a URI of a network share, by its host or its path, is not local.
 */
export function fileUriToPath(uri: string): string | null {
  if (!uri.startsWith("file://")) return null;
  let path: string;
  try {
    path = decodeURIComponent(uri.slice("file://".length));
  } catch {
    return null;
  }
  if (path.startsWith("localhost/")) path = path.slice("localhost".length);
  if (!path.startsWith("/") || isNetworkPath(path)) return null;
  // `file:///C:/work/a.md` names a Windows drive path.
  return /^\/[A-Za-z]:[\\/]/.test(path) ? path.slice(1) : path;
}

/** Where a file lies in the project: its Space and its path in that Space. */
export interface AttachmentLocation {
  spaceId: string;
  spacePath: string;
  /** Relative to the Space root. */
  path: string;
}

/**
 * The innermost Space of `spaces` that holds `path`, or null for a file
 * outside the project. A Windows path matches its Space whatever its case
 * and separators; the path in the Space is `/`-separated.
 */
export function locateAttachment(
  path: string,
  spaces: readonly { id: string; path: string }[],
): AttachmentLocation | null {
  const local = withoutVerbatimPrefix(path);
  const key = pathKey(local);
  let found: AttachmentLocation | null = null;
  for (const space of spaces) {
    const root = space.path.replace(/[\\/]+$/, "");
    const rootKey = pathKey(root);
    if (!key.startsWith(`${rootKey}/`)) continue;
    if (found && found.spacePath.length >= root.length) continue;
    const relative = local.slice(withoutVerbatimPrefix(root).length + 1);
    found = {
      spaceId: space.id,
      spacePath: root,
      path: isDrivePath(local) ? relative.replace(/\\/g, "/") : relative,
    };
  }
  return found;
}
