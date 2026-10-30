import { createContext, useContext } from "react";
import { toast } from "sonner";
import type { HeldMedia } from "@/features/media/app-shell";
import { openInSystem } from "../api/attachments";
import type { AgentSessionKeyDto } from "../api/chat";
import { loadMediaData, openDataImage, openMediaData } from "../api/media";
import { attachmentOf } from "../model/attachments";
import { mediaFileName, type ChatMedia } from "../model/media";
import { dataImage } from "../model/text-media";
import { useOpenAttachment } from "./use-attachment-opener";
import * as m from "@/paraglide/messages.js";

/**
 * Opens media the window holds — without a file, a `data:` image, a shown
 * external image — in the media peek of the app shell (DF-233 R1, R2).
 */
export type OpenHeldMedia = (media: HeldMedia) => void;

export const HeldMediaOpenerContext = createContext<OpenHeldMedia | null>(null);

function mediaOpenFailed(error: unknown) {
  toast.error(
    m.sessions_chat_media_open_failed({
      message: error instanceof Error ? error.message : String(error),
    }),
  );
}

/**
 * Opens a media tile (DF-233 R1): a file by the badge rule — of the project
 * in the Attachments Peek, outside it in the peek with the media viewer —,
 * an image, a video or an audio without a file and an image by its address
 * in the media peek, nothing written. Another file without a file opens
 * through a temp file in its system app, as before.
 */
export function useOpenMedia(
  session: AgentSessionKeyDto | null,
): (media: ChatMedia) => void {
  const openAttachment = useOpenAttachment();
  const openHeld = useContext(HeldMediaOpenerContext);
  return (media) => {
    if (media.path) {
      if (openAttachment) {
        openAttachment(attachmentOf(media.path, media.name ?? undefined));
      } else {
        void openInSystem(media.path);
      }
      return;
    }
    const held = heldMediaOf(session, media);
    if (held) {
      openHeld?.(held);
      return;
    }
    if (media.data && session) {
      openMediaData(session, media).catch(mediaOpenFailed);
    }
  };
}

/**
 * "Open in app" of a tile the window cannot show (R6): straight in the
 * system app, a file by its path, media without a file through a temp file.
 */
export function useOpenMediaInApp(
  session: AgentSessionKeyDto | null,
): (media: ChatMedia) => void {
  return (media) => {
    if (media.path) void openInSystem(media.path);
    else if (media.data && session) {
      openMediaData(session, media).catch(mediaOpenFailed);
    }
  };
}

/**
 * The media viewer's source of media the window holds (R2–R4): read on
 * open, freed on close; outside Svode only by its action.
 */
function heldMediaOf(
  session: AgentSessionKeyDto | null,
  media: ChatMedia,
): HeldMedia | null {
  if (media.kind === "file") return null;
  const { url, data } = media;
  const name = (mimeType: string | null) =>
    media.name ?? mediaFileName(media, mimeType ?? "");
  if (url) {
    const image = dataImage(url);
    return {
      key: media.key,
      name: name(image?.mimeType ?? media.mimeType),
      family: media.kind,
      load: async () => ({
        url,
        remote: !image,
        mimeType: image?.mimeType ?? media.mimeType,
        sizeBytes: image?.size ?? media.size,
      }),
      action: image
        ? {
            kind: "app",
            label: m.sessions_chat_media_open_in_app(),
            run: () => openDataImage(media, url),
          }
        : {
            kind: "browser",
            label: m.sessions_chat_media_open_in_browser(),
            run: () => openInSystem(url),
          },
    };
  }
  if (!data || !session) return null;
  return {
    key: media.key,
    name: name(media.mimeType),
    family: media.kind,
    load: async () => {
      const loaded = await loadMediaData(session, data);
      if (loaded.ok) {
        return {
          url: loaded.url,
          mimeType: loaded.mimeType,
          sizeBytes: loaded.size,
          release: loaded.release,
        };
      }
      const { outcome } = loaded;
      if (outcome.outcome === "error") {
        return {
          unavailable: m.sessions_chat_media_open_failed({
            message: outcome.message,
          }),
        };
      }
      return {
        unavailable:
          outcome.reason === "released"
            ? m.sessions_chat_media_released()
            : outcome.reason === "too_large"
              ? m.sessions_chat_media_too_large()
              : m.sessions_chat_media_not_provided(),
      };
    },
    action: {
      kind: "app",
      label: m.sessions_chat_media_open_in_app(),
      run: () => openMediaData(session, media),
    },
  };
}
