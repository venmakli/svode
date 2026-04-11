/**
 * Allowed asset extensions and MIME types.
 *
 * Mirrors the backend whitelist in `src-tauri/src/storage/assets.rs::mime_for`.
 * Single source of truth for file picker `accept` lists and post-select
 * validation. Keep in sync with backend — if you add a format here, add it
 * to `mime_for` too.
 *
 * Extensions are lowercase with leading dot (format expected by
 * `<input accept>`). MIME arrays are used for post-select validation of
 * files coming via drag-and-drop, which bypass the file picker's `accept`.
 */

export const IMAGE_EXTS = [
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.webp',
  '.svg',
  '.avif',
  '.ico',
] as const;

export const VIDEO_EXTS = ['.mp4', '.mov', '.webm', '.mkv'] as const;

export const AUDIO_EXTS = [
  '.mp3',
  '.wav',
  '.ogg',
  '.flac',
  '.m4a',
] as const;

export const IMAGE_MIMES = [
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'image/svg+xml',
  'image/avif',
  'image/x-icon',
  'image/vnd.microsoft.icon',
] as const;

export const VIDEO_MIMES = [
  'video/mp4',
  'video/quicktime',
  'video/webm',
  'video/x-matroska',
] as const;

export const AUDIO_MIMES = [
  'audio/mpeg',
  'audio/wav',
  'audio/x-wav',
  'audio/ogg',
  'audio/flac',
  'audio/x-flac',
  'audio/mp4',
  'audio/x-m4a',
] as const;

export type MediaKind = 'image' | 'video' | 'audio' | 'file';

const EXTS_BY_KIND: Record<Exclude<MediaKind, 'file'>, readonly string[]> = {
  image: IMAGE_EXTS,
  video: VIDEO_EXTS,
  audio: AUDIO_EXTS,
};

const MIMES_BY_KIND: Record<Exclude<MediaKind, 'file'>, readonly string[]> = {
  image: IMAGE_MIMES,
  video: VIDEO_MIMES,
  audio: AUDIO_MIMES,
};

/**
 * Validate that a File matches the expected media kind. Checks MIME type
 * first (set by the browser from content sniffing / OS) and falls back to
 * the file extension when MIME is empty or generic.
 *
 * Returns `true` for `kind === 'file'` (no restriction — the file node
 * accepts any format).
 */
export function isFileOfKind(file: File, kind: MediaKind): boolean {
  if (kind === 'file') return true;

  const mime = file.type.toLowerCase();
  if (mime && (MIMES_BY_KIND[kind] as readonly string[]).includes(mime)) {
    return true;
  }

  const name = file.name.toLowerCase();
  const dot = name.lastIndexOf('.');
  if (dot === -1) return false;
  const ext = name.slice(dot);
  return (EXTS_BY_KIND[kind] as readonly string[]).includes(ext);
}
