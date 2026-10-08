import { fileName } from "./attachments";
import { mediaKindOfPath, type ChatMedia } from "./media";
import { isAbsolute, linkTarget, type PathBase } from "./text-paths";

/**
 * Media the text of the agent names (Stage 10 `08`, R3): markdown images
 * with a local path or a `data:` URL, `MEDIA:` lines, external images. A
 * path and an address are untrusted input; this only reads them.
 */

/** An image of the text as written. */
export interface TextImage {
  source: string;
  alt: string;
}

/** What a run of images of the text shows, in order. */
export type TextImagePart =
  /** Tiles, player rows and file cards shown together. */
  | { type: "media"; media: ChatMedia[] }
  /** An external image: nothing loads until the user asks. */
  | { type: "external"; url: string; host: string; alt: string }
  /** An image nothing shows: its alt text. */
  | { type: "text"; text: string };

/**
 * Bound of a `data:` image of the text, decoded, as that of media data
 * without a file (`02` C4): beyond it the image is its alt text.
 */
export const TEXT_DATA_IMAGE_LIMIT = 16 * 1024 * 1024;

const MEDIA_MARKER = "MEDIA:";
const HIDDEN_MARKERS = /\[\[(?:audio_as_voice|as_document)\]\]/g;
const DATA_IMAGE =
  /^data:(image\/[a-z0-9.+-]+)((?:;[^,;]*)*?)(;base64)?,(.*)$/is;
const TRAILING_PUNCTUATION = /[.,;:!?)"'`]+$/;

/**
 * The images of a run as the chat shows them: local files and `data:`
 * images within the bound as media shown together, external images as
 * cards, anything else as its alt text.
 */
export function textImageParts(
  images: readonly TextImage[],
  base: PathBase,
  limit = TEXT_DATA_IMAGE_LIMIT,
): TextImagePart[] {
  const parts: TextImagePart[] = [];
  const pushMedia = (media: ChatMedia) => {
    const last = parts.at(-1);
    if (last?.type === "media") last.media.push(media);
    else parts.push({ type: "media", media: [media] });
  };
  images.forEach(({ source, alt }, index) => {
    const key = `text:${index}:${source.slice(0, 256)}`;
    const data = dataImage(source);
    if (data) {
      if (data.size <= limit) {
        pushMedia({
          key,
          kind: "image",
          name: alt || null,
          mimeType: data.mimeType,
          size: data.size,
          path: null,
          data: null,
          url: source,
        });
      } else if (alt) {
        parts.push({ type: "text", text: alt });
      }
      return;
    }
    const target = /^data:/i.test(source) ? null : linkTarget(source, base);
    if (target?.kind === "web") {
      parts.push({
        type: "external",
        url: target.url,
        host: new URL(target.url).hostname,
        alt,
      });
    } else if (target?.kind === "local") {
      const { path } = target.reference;
      pushMedia({
        key,
        kind: mediaKindOfPath(path),
        name: alt || fileName(path),
        mimeType: null,
        size: null,
        path,
        data: null,
        url: null,
      });
    } else if (alt) {
      parts.push({ type: "text", text: alt });
    }
  });
  return parts;
}

/** A `data:` image URL: its type, the decoded size and the payload. */
export function dataImage(source: string): {
  mimeType: string;
  size: number;
  base64: boolean;
  payload: string;
} | null {
  const match = DATA_IMAGE.exec(source.trim());
  if (!match) return null;
  const base64 = Boolean(match[3]);
  const payload = match[4];
  let size: number;
  if (base64) {
    const length = payload.replace(/\s/g, "").replace(/=+$/, "").length;
    size = Math.floor((length * 3) / 4);
  } else {
    try {
      size = new TextEncoder().encode(decodeURIComponent(payload)).length;
    } catch {
      return null;
    }
  }
  return { mimeType: match[1].toLowerCase(), size, base64, payload };
}

/**
 * The text with its `MEDIA:` markers as markdown images, so they show as
 * the images of the text do (`08` R3): an absolute path or one from `~`,
 * also in quotes or backticks, outside fenced blocks and inline code; the
 * kind is the file's. `[[audio_as_voice]]` and `[[as_document]]` are
 * hidden. While the text streams its last line may still grow, so only a
 * line that ended counts. The rule of the runtime for tool results.
 */
export function withMediaImages(
  text: string,
  { complete }: { complete: boolean },
): string {
  if (!text.includes(MEDIA_MARKER) && !text.includes("[[")) return text;
  let fenced = false;
  let shown = "";
  for (const line of text.split(/(?<=\n)/)) {
    const start = line.trimStart();
    if (start.startsWith("```") || start.startsWith("~~~")) {
      fenced = !fenced;
      shown += line;
      continue;
    }
    if (fenced || (!complete && !line.endsWith("\n"))) {
      shown += line;
      continue;
    }
    shown += lineWithMediaImages(line.replace(HIDDEN_MARKERS, ""));
  }
  return shown;
}

function lineWithMediaImages(line: string): string {
  let kept = line;
  let from = 0;
  for (;;) {
    const start = kept.indexOf(MEDIA_MARKER, from);
    if (start < 0) return kept;
    const tokenEnd = start + MEDIA_MARKER.length;
    const before = start > 0 ? kept[start - 1] : "";
    const boundary = !before || /\s/.test(before) || "\"'(".includes(before);
    const marker =
      boundary && !inInlineCode(kept, start)
        ? markerPath(kept.slice(tokenEnd))
        : null;
    if (!marker || !namesLocalFile(marker.path)) {
      from = tokenEnd;
      continue;
    }
    const image = `![](${destination(marker.path)})`;
    kept = kept.slice(0, start) + image + kept.slice(tokenEnd + marker.end);
    from = start + image.length;
  }
}

/** The path after `MEDIA:` and where its marker ends. */
function markerPath(after: string): { path: string; end: number } | null {
  const quote = after[0];
  if (quote === '"' || quote === "'" || quote === "`") {
    const close = after.indexOf(quote, 1);
    return close > 0 ? { path: after.slice(1, close), end: close + 1 } : null;
  }
  const end = after.search(/\s/);
  const path = (end < 0 ? after : after.slice(0, end)).replace(
    TRAILING_PUNCTUATION,
    "",
  );
  return { path, end: path.length };
}

/** Whether `at` of `line` is inside a backtick span. */
function inInlineCode(line: string, at: number): boolean {
  const ticks = line.slice(0, at).split("`").length - 1;
  return ticks % 2 === 1 && line.slice(at).includes("`");
}

function namesLocalFile(path: string): boolean {
  return isAbsolute(path) || path.startsWith("~/") || path.startsWith("~\\");
}

/** A path as a markdown link destination; the link decodes it back. */
function destination(path: string): string {
  return path.replace(/[^\w/~.:-]/gu, (character) =>
    character.length === 1 && character.charCodeAt(0) < 0x80
      ? `%${character.charCodeAt(0).toString(16).toUpperCase().padStart(2, "0")}`
      : encodeURIComponent(character),
  );
}
