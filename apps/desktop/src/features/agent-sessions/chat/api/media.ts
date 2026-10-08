import {
  readAgentMedia,
  type AgentMediaOutcomeDto,
  type AgentSessionKeyDto,
} from "@/platform/agent-runtime/agent-runtime-api";
import {
  createLocalMediaSource,
  revokeMediaSource,
} from "@/platform/media/media-api";
import { savePastedImage } from "@/platform/native/clipboard";
import { openPath } from "@/platform/native/shell";
import { mediaFileName, type ChatMedia } from "../model/media";
import { dataImage } from "../model/text-media";

export type { AgentMediaOutcomeDto };

/** A local file the window streams by a capability of its own. */
export interface LocalMediaSource {
  url: string;
  token: string;
  mimeType: string;
  width: number | null;
  height: number | null;
}

/** Why a local file is not shown. */
export type LocalMediaFailure = "missing" | "too_large" | "error";

export type LocalMediaOutcome =
  | { ok: true; source: LocalMediaSource }
  | { ok: false; failure: LocalMediaFailure };

/**
 * A local file for display, read where it lies: a stream with ranges, so a
 * video seeks without reading the whole file (`08` R2).
 */
export async function loadLocalMedia(path: string): Promise<LocalMediaOutcome> {
  try {
    const source = await createLocalMediaSource(path);
    return {
      ok: true,
      source: {
        url: source.sourceUrl,
        token: source.capabilityToken,
        mimeType: source.mimeType,
        width: source.width,
        height: source.height,
      },
    };
  } catch (error) {
    return { ok: false, failure: localMediaFailure(error) };
  }
}

export function releaseLocalMedia(token: string): void {
  void revokeMediaSource(token).catch(() => undefined);
}

function localMediaFailure(error: unknown): LocalMediaFailure {
  const kind =
    typeof error === "object" && error !== null && "kind" in error
      ? error.kind
      : null;
  if (kind === "source_missing") return "missing";
  if (kind === "resource_limit") return "too_large";
  return "error";
}

/**
 * An image the window loads by its address, decoded: its size, known
 * before it is shown. No referrer leaves with the request.
 */
export function loadImage(
  url: string,
): Promise<{ width: number; height: number }> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.referrerPolicy = "no-referrer";
    image.onload = () =>
      resolve({ width: image.naturalWidth, height: image.naturalHeight });
    image.onerror = () => reject(new Error("The image did not load"));
    image.src = url;
  });
}

/** The data of a media segment the runtime holds for an item. */
export function readMediaData(
  session: AgentSessionKeyDto,
  itemId: string,
  segmentId: string,
): Promise<AgentMediaOutcomeDto> {
  return readAgentMedia(session, itemId, segmentId).catch(
    (error: unknown): AgentMediaOutcomeDto => ({
      outcome: "error",
      message: error instanceof Error ? error.message : String(error),
    }),
  );
}

export function mediaBlob(data: string, mimeType: string): Blob {
  const binary = atob(data);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return new Blob([bytes], { type: mimeType });
}

/**
 * Opens an image of the text by its address: an external one in the
 * browser, a `data:` one as media without a file.
 */
export async function openMediaUrl(media: ChatMedia): Promise<void> {
  if (!media.url) throw new Error("The media has no address");
  const data = dataImage(media.url);
  if (!data) {
    await openPath(media.url);
    return;
  }
  const blob = data.base64
    ? mediaBlob(data.payload, data.mimeType)
    : new Blob([decodeURIComponent(data.payload)], { type: data.mimeType });
  await openFile(
    new File([blob], mediaFileName(media, data.mimeType), {
      type: data.mimeType,
    }),
  );
}

/**
 * Opens media without a file in its system app (`08` R2): on the user's
 * click its data is written into the system temp directory, as a pasted
 * image is (`04`). The only disk write of agent media.
 */
export async function openMediaData(
  session: AgentSessionKeyDto,
  media: ChatMedia,
): Promise<void> {
  if (!media.data) throw new Error("The media has no data");
  const outcome = await readAgentMedia(
    session,
    media.data.itemId,
    media.data.segmentId,
  );
  if (outcome.outcome !== "available") {
    throw new Error(
      outcome.outcome === "error" ? outcome.message : outcome.reason,
    );
  }
  await openFile(
    new File(
      [mediaBlob(outcome.data, outcome.mimeType)],
      mediaFileName(media, outcome.mimeType),
      { type: outcome.mimeType },
    ),
  );
}

async function openFile(file: File): Promise<void> {
  await openPath(await savePastedImage(file));
}
