import type { MediaFormatDto } from "@/platform/media/media-api";

export type MediaFormat = MediaFormatDto;

export interface MediaTarget {
  projectPath: string;
  spaceId: string | null;
  spacePath: string;
  path: string;
}

export interface MediaSourceDescriptor {
  format: MediaFormat;
  family: "image" | "audio" | "video";
  mimeType: string;
  sizeBytes: number;
  generation: string;
  width: number | null;
  height: number | null;
  animated: boolean;
  intrinsicOversized: boolean;
  inlinePreview: boolean;
  capabilityToken: string;
  sourceUrl: string;
}

export type MediaFailureKind =
  | "resource_limit"
  | "malformed"
  | "source_unavailable"
  | "source_changed"
  | "source_missing"
  | "runtime_error"
  | "external_only";

export interface MediaFailure {
  kind: MediaFailureKind;
  detail?: string;
  limitBytes?: number;
  actualBytes?: number;
}

export type MediaViewMode = "fit" | "custom";

export interface MediaViewState {
  mode: MediaViewMode;
  zoom: number;
  panX: number;
  panY: number;
}

export const DEFAULT_MEDIA_VIEW_STATE: MediaViewState = {
  mode: "fit",
  zoom: 1,
  panX: 0,
  panY: 0,
};

export type MediaSessionState =
  | { phase: "resolving" }
  | { phase: "loading"; source: MediaSourceDescriptor }
  | { phase: "ready"; source: MediaSourceDescriptor }
  | { phase: "failed"; failure: MediaFailure };

export function mediaTargetKey(target: MediaTarget) {
  return `${normalizeRuntimePath(target.spacePath)}\0${target.path}`;
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

export function mediaDisplayName(path: string) {
  return path.replaceAll("\\", "/").split("/").at(-1) ?? path;
}
