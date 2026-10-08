import type {
  AgentActivityItemDto,
  AgentMediaKindDto,
  AgentMediaSegmentDto,
} from "@/platform/agent-runtime/agent-runtime-api";
import { fileExtension, fileName } from "./attachments";
import type { TimelineTurn } from "./timeline";

type ToolCallItem = Extract<AgentActivityItemDto, { kind: "tool_call" }>;

/**
 * One media the chat shows (Stage 10 `08` R2): a file by its path, data the
 * runtime holds for an item, or both.
 */
export interface ChatMedia {
  /** Unique among the media shown together. */
  key: string;
  kind: AgentMediaKindDto;
  /** Null when neither the agent nor the path names it. */
  name: string | null;
  mimeType: string | null;
  size: number | null;
  /** Absolute path of the local file. */
  path: string | null;
  /** The data the runtime holds without a file, read by item and segment. */
  data: { itemId: string; segmentId: string } | null;
}

export function chatMediaOf(
  itemId: string,
  segment: AgentMediaSegmentDto,
): ChatMedia {
  return {
    key: `${itemId}:${segment.id}`,
    kind: segment.kind,
    name: segment.name ?? (segment.path ? fileName(segment.path) : null),
    mimeType: segment.mimeType,
    size: segment.size,
    path: segment.path,
    data: segment.hasData ? { itemId, segmentId: segment.id } : null,
  };
}

/**
 * A tool call that created media: its row stays outside a folded turn
 * (`08` R2). What the agent only looked at — kinds `read` and `search` —
 * folds as before.
 */
export function createsMedia(item: ToolCallItem): boolean {
  return (
    item.media.length > 0 && item.tool !== "read" && item.tool !== "search"
  );
}

/** The media a turn created, by the rule of rows kept outside its fold. */
export function turnCreatedMediaCount(turn: TimelineTurn): number {
  let count = 0;
  for (const entry of turn.entries) {
    if (entry.kind !== "tools") continue;
    for (const { item } of entry.rows) {
      if (createsMedia(item)) count += item.media.length;
    }
  }
  return count;
}

/** Media shown together, split by how each kind is shown. */
export interface MediaGroups {
  /** Images and videos: tiles in the layout. */
  tiles: ChatMedia[];
  /** Player rows. */
  audio: ChatMedia[];
  /** File cards. */
  files: ChatMedia[];
}

export function groupMedia(media: readonly ChatMedia[]): MediaGroups {
  return {
    tiles: media.filter(
      (entry) => entry.kind === "image" || entry.kind === "video",
    ),
    audio: media.filter((entry) => entry.kind === "audio"),
    files: media.filter((entry) => entry.kind === "file"),
  };
}

/** The tiles of a layout: all of them, or four with the last one "+N". */
export interface TileLayout {
  kind: "single" | "pair" | "triple" | "grid";
  shown: number;
  /** Beyond zero, the last shown tile is "+more" and opens the rest. */
  more: number;
}

/**
 * One tile uncropped, two side by side, three as a large one on the left
 * and two on the right, four as 2×2; five and more as 2×2 whose last tile
 * "+N" opens the rest, then all of them in a grid.
 */
export function tileLayout(count: number, expanded: boolean): TileLayout {
  if (count <= 1) return { kind: "single", shown: count, more: 0 };
  if (count === 2) return { kind: "pair", shown: 2, more: 0 };
  if (count === 3) return { kind: "triple", shown: 3, more: 0 };
  if (count === 4 || expanded) return { kind: "grid", shown: count, more: 0 };
  return { kind: "grid", shown: 4, more: count - 3 };
}

/** A part of an agent message: its text, or the media at that place. */
export type MessagePart =
  | { type: "text"; text: string }
  | { type: "media"; media: ChatMedia[] };

/**
 * An agent message with its media at their places in the text (`offset`
 * in UTF-16 units, the unit of JavaScript strings). Media with only blank
 * text between them show together; a segment without a place goes last.
 */
export function agentMessageParts(
  itemId: string,
  text: string,
  segments: readonly AgentMediaSegmentDto[],
): MessagePart[] {
  if (segments.length === 0) return [{ type: "text", text }];
  const placed = segments
    .map((segment, index) => ({
      segment,
      index,
      at: Math.min(Math.max(segment.offset ?? text.length, 0), text.length),
    }))
    .sort((left, right) => left.at - right.at || left.index - right.index);
  const parts: MessagePart[] = [];
  let cursor = 0;
  for (const { segment, at } of placed) {
    const between = text.slice(cursor, at);
    const last = parts.at(-1);
    const media = chatMediaOf(itemId, segment);
    if (last?.type === "media" && between.trim() === "") {
      last.media.push(media);
    } else {
      if (between.trim() !== "") parts.push({ type: "text", text: between });
      parts.push({ type: "media", media: [media] });
    }
    cursor = at;
  }
  const rest = text.slice(cursor);
  if (rest.trim() !== "") parts.push({ type: "text", text: rest });
  return parts;
}

/** What names a media without a name: its kind. */
export function mediaTypeLabel(media: ChatMedia): string | null {
  const extension = media.path ? fileExtension(media.path) : "";
  if (extension) return extension.toUpperCase();
  const subtype = media.mimeType?.split("/")[1]?.split(/[;+]/)[0];
  return subtype ? subtype.toUpperCase() : null;
}

/** A file name for media without a file: its name, else by its MIME type. */
export function mediaFileName(media: ChatMedia, mimeType: string): string {
  if (media.name && /\.[A-Za-z0-9]+$/.test(media.name)) return media.name;
  const subtype = mimeType.split("/")[1]?.split(/[;+]/)[0] ?? "bin";
  const extension =
    subtype === "jpeg" ? "jpg" : subtype === "mpeg" ? "mp3" : subtype;
  return `${media.name ?? media.kind}.${extension.replace(/[^A-Za-z0-9]/g, "") || "bin"}`;
}
