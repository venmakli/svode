import { listen, type UnlistenFn } from "@/platform/native/events";
import { convertFileSrc, invokeCommand } from "@/platform/native/invoke";

export type MediaFormatDto =
  | "png"
  | "jpeg"
  | "webp"
  | "gif"
  | "svg"
  | "avif"
  | "ico"
  | "mp3"
  | "wav"
  | "m4a"
  | "aac"
  | "flac"
  | "ogg"
  | "opus"
  | "mp4"
  | "m4v"
  | "mov"
  | "webm"
  | "mkv"
  | "avi"
  | "wmv"
  | "mpg"
  | "mpeg"
  | "three_gp"
  | "wma"
  | "aiff";

export interface MediaSourceInputDto {
  projectPath: string;
  spaceId: string | null;
  targetPath: string;
}

export interface MediaSourceSessionDto {
  format: MediaFormatDto;
  family: "image" | "audio" | "video";
  mimeType: string;
  sizeBytes: number;
  generation: string;
  width: number | null;
  height: number | null;
  animated: boolean;
  intrinsicOversized: boolean;
  inlinePreview: boolean;
  requiresRangeRequests: boolean;
  capabilityToken: string;
}

export interface MediaSourceInvalidatedDto {
  spacePath: string;
  changes: Array<{ path: string; kind: "page" | "binary" | "boundary" }>;
}

export async function createMediaSource(
  input: MediaSourceInputDto,
): Promise<MediaSourceSessionDto & { sourceUrl: string }> {
  const source = await invokeCommand<MediaSourceSessionDto>(
    "media_create_source",
    { ...input },
  );
  return {
    ...source,
    sourceUrl: convertFileSrc(source.capabilityToken, "svode-media"),
  };
}

export function validateMediaSource(
  input: MediaSourceInputDto & { expectedGeneration: string },
): Promise<void> {
  return invokeCommand("media_validate_source", { ...input });
}

export function revokeMediaSource(capabilityToken: string): Promise<void> {
  return invokeCommand("media_revoke_source", { capabilityToken });
}

export function openMediaExternal(input: MediaSourceInputDto): Promise<void> {
  return invokeCommand("media_open_external", { ...input });
}

export function listenMediaSourceInvalidated(
  handler: (payload: MediaSourceInvalidatedDto) => void,
): Promise<UnlistenFn> {
  return listen<MediaSourceInvalidatedDto>("attachments:invalidated", (event) =>
    handler(event.payload),
  );
}
