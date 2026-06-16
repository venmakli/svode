/**
 * Allowed asset extensions and MIME types.
 *
 * Mirrors the backend whitelist in `src-tauri/src/storage/assets.rs::mime_for`.
 * Single source of truth for file picker `accept` lists and post-select
 * validation. Keep in sync with backend if a format is added.
 */

export const IMAGE_EXTS = [
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".svg",
  ".avif",
  ".ico",
] as const;

export const VIDEO_EXTS = [".mp4", ".mov", ".webm", ".mkv"] as const;

export const AUDIO_EXTS = [".mp3", ".wav", ".ogg", ".flac", ".m4a"] as const;

export const IMAGE_MIMES = [
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "image/svg+xml",
  "image/avif",
  "image/x-icon",
  "image/vnd.microsoft.icon",
] as const;

export const VIDEO_MIMES = [
  "video/mp4",
  "video/quicktime",
  "video/webm",
  "video/x-matroska",
] as const;

export const AUDIO_MIMES = [
  "audio/mpeg",
  "audio/wav",
  "audio/x-wav",
  "audio/ogg",
  "audio/flac",
  "audio/x-flac",
  "audio/mp4",
  "audio/x-m4a",
] as const;

export type MediaKind = "image" | "video" | "audio" | "file";

const EXTS_BY_KIND: Record<Exclude<MediaKind, "file">, readonly string[]> = {
  image: IMAGE_EXTS,
  video: VIDEO_EXTS,
  audio: AUDIO_EXTS,
};

const MIMES_BY_KIND: Record<Exclude<MediaKind, "file">, readonly string[]> = {
  image: IMAGE_MIMES,
  video: VIDEO_MIMES,
  audio: AUDIO_MIMES,
};

export function isFileOfKind(file: File, kind: MediaKind): boolean {
  if (kind === "file") return true;

  const mime = file.type.toLowerCase();
  if (mime && (MIMES_BY_KIND[kind] as readonly string[]).includes(mime)) {
    return true;
  }

  const name = file.name.toLowerCase();
  const dot = name.lastIndexOf(".");
  if (dot === -1) return false;
  const ext = name.slice(dot);
  return (EXTS_BY_KIND[kind] as readonly string[]).includes(ext);
}
