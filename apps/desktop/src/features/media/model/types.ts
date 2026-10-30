import type { ExternalOpenTarget } from "@/features/external-open";
import type {
  MediaFormatDto,
  MediaSourceSessionDto,
} from "@/platform/media/media-api";

export type MediaFormat = MediaFormatDto;

/** A file of a Space, by its path inside it. */
export interface SpaceMediaTarget {
  kind?: undefined;
  projectPath: string;
  spaceId: string | null;
  spacePath: string;
  path: string;
}

/**
 * A file outside the Space, only to view it: no Changes and no full page.
 * Its owner resolves it inside its own boundary: it issues the capability
 * and validates the external open.
 */
export interface LocalMediaFile {
  /** The file's path, for its name and format. */
  path: string;
  createSource(): Promise<MediaSourceSessionDto>;
  externalOpen: ExternalOpenTarget;
}

/**
 * Media the window holds itself, only to view it: data in its memory or an
 * address its owner already shows. Nothing is written to view it; its owner
 * reads it on open, frees it on close and names its one way out of Svode.
 */
export interface HeldMedia {
  /** Unique among the media of its owner. */
  key: string;
  name: string;
  family: MediaSourceDescriptor["family"];
  /** Reads the media for the viewer, or why it is unavailable. */
  load(): Promise<HeldMediaContent>;
  /** Opens the media outside Svode, only on the user's action. */
  action: HeldMediaAction;
}

export type HeldMediaContent =
  | {
      /** A `blob:` or `data:` address, or an external one (`remote`). */
      url: string;
      /** Loaded without CORS mode and without a referrer. */
      remote?: boolean;
      mimeType: string | null;
      sizeBytes: number | null;
      /** Frees what `load` took; runs once the viewer closes. */
      release?(): void;
    }
  /** The reason as the owner names it. */
  | { unavailable: string };

export interface HeldMediaAction {
  kind: "app" | "browser";
  label: string;
  run(): Promise<void>;
}

export type MediaTarget =
  | SpaceMediaTarget
  | ({ kind: "local" } & LocalMediaFile)
  | ({ kind: "held" } & HeldMedia);

export interface MediaSourceDescriptor {
  /** `null` while unknown, for media the window holds. */
  format: MediaFormat | null;
  family: "image" | "audio" | "video";
  mimeType: string;
  sizeBytes: number | null;
  generation: string;
  width: number | null;
  height: number | null;
  animated: boolean;
  intrinsicOversized: boolean;
  inlinePreview: boolean;
  requiresRangeRequests: boolean;
  /** Names one loaded source; a capability for a file. */
  capabilityToken: string;
  sourceUrl: string;
  /** An external address: loaded without CORS mode and without a referrer. */
  remote?: boolean;
  durationSeconds?: number;
}

export interface MediaRuntimeMetadata {
  durationSeconds?: number;
  height?: number;
  width?: number;
}

export type MediaFailureKind =
  /** Held media whose data is gone; `detail` is the reason to show. */
  | "unavailable"
  | "resource_limit"
  | "malformed"
  | "source_unavailable"
  | "source_changed"
  | "source_missing"
  | "runtime_error"
  | "external_only"
  | "unsupported_codec"
  | "unusable_range"
  | "playback_error";

export interface MediaFailure {
  kind: MediaFailureKind;
  detail?: string;
  limitBytes?: number;
  actualBytes?: number;
}

export type MediaViewMode = "fit" | "custom";

export interface MediaPlaybackViewState {
  currentTime: number;
  muted: boolean;
  playbackRate: number;
  volume: number;
}

export interface MediaViewState {
  mode: MediaViewMode;
  zoom: number;
  panX: number;
  panY: number;
  playback: MediaPlaybackViewState;
}

export const DEFAULT_MEDIA_VIEW_STATE: MediaViewState = {
  mode: "fit",
  zoom: 1,
  panX: 0,
  panY: 0,
  playback: {
    currentTime: 0,
    muted: false,
    playbackRate: 1,
    volume: 1,
  },
};

export type MediaSessionState =
  | { phase: "resolving" }
  | { phase: "loading"; source: MediaSourceDescriptor }
  | { phase: "ready"; source: MediaSourceDescriptor }
  | { phase: "failed"; failure: MediaFailure };

export function mediaTargetKey(target: MediaTarget) {
  if (target.kind === "held") return `held\0${target.key}`;
  return target.kind === "local"
    ? `local\0${normalizeRuntimePath(target.path)}`
    : `${normalizeRuntimePath(target.spacePath)}\0${target.path}`;
}

export function normalizeRuntimePath(value: string) {
  const normalized = value.replaceAll("\\", "/").replace(/\/+$/u, "");
  return /^[A-Za-z]:\//u.test(normalized)
    ? normalized.toLowerCase()
    : normalized;
}

export function mediaFormatFromPath(path: string): MediaFormat | null {
  const extension = path.split(".").at(-1)?.toLowerCase();
  if (extension === "jpg") return "jpeg";
  if (extension === "3gp") return "three_gp";
  switch (extension) {
    case "png":
    case "jpeg":
    case "webp":
    case "gif":
    case "svg":
    case "avif":
    case "ico":
    case "mp3":
    case "wav":
    case "m4a":
    case "aac":
    case "flac":
    case "ogg":
    case "opus":
    case "mp4":
    case "m4v":
    case "mov":
    case "webm":
    case "mkv":
    case "avi":
    case "wmv":
    case "mpg":
    case "mpeg":
    case "wma":
    case "aiff":
      return extension;
    default:
      return null;
  }
}

const MIME_FORMATS: Record<string, MediaFormat> = {
  "image/svg+xml": "svg",
  "image/x-icon": "ico",
  "image/vnd.microsoft.icon": "ico",
  "audio/mpeg": "mp3",
  "audio/mp4": "m4a",
  "audio/wave": "wav",
  "video/quicktime": "mov",
  "video/x-matroska": "mkv",
  "video/x-msvideo": "avi",
  "video/3gpp": "three_gp",
  "video/x-ms-wmv": "wmv",
  "audio/x-ms-wma": "wma",
};

/** The format a MIME type names; `null` for any other type. */
export function mediaFormatFromMime(mimeType: string): MediaFormat | null {
  const type = mimeType.split(";")[0].trim().toLowerCase();
  const subtype = type.split("/")[1]?.replace(/^x-/u, "");
  return (
    MIME_FORMATS[type] ?? (subtype ? mediaFormatFromPath(`.${subtype}`) : null)
  );
}

export function mediaFamilyFromFormat(
  format: MediaFormat,
): MediaSourceDescriptor["family"] {
  switch (format) {
    case "png":
    case "jpeg":
    case "webp":
    case "gif":
    case "svg":
    case "avif":
    case "ico":
      return "image";
    case "mp3":
    case "wav":
    case "m4a":
    case "aac":
    case "flac":
    case "ogg":
    case "opus":
    case "wma":
    case "aiff":
      return "audio";
    case "mp4":
    case "m4v":
    case "mov":
    case "webm":
    case "mkv":
    case "avi":
    case "wmv":
    case "mpg":
    case "mpeg":
    case "three_gp":
      return "video";
  }
}

export function mediaDisplayName(path: string) {
  return path.replaceAll("\\", "/").split("/").at(-1) ?? path;
}
