import { toast } from "sonner";
import { openInSystem } from "../api/attachments";
import type { AgentSessionKeyDto } from "../api/chat";
import { openMediaData, openMediaUrl } from "../api/media";
import { attachmentOf } from "../model/attachments";
import type { ChatMedia } from "../model/media";
import { useOpenAttachment } from "./use-attachment-opener";
import * as m from "@/paraglide/messages.js";

/**
 * Opens a media tile: a file by the badge rule (DF-233 R1) — of the project
 * in the Attachments Peek, outside it in the peek with the media viewer —,
 * media without a file through a temp file in its system app, an external
 * image in the browser.
 */
export function useOpenMedia(
  session: AgentSessionKeyDto | null,
): (media: ChatMedia) => void {
  const openAttachment = useOpenAttachment();
  const failed = (error: unknown) => {
    toast.error(
      m.sessions_chat_media_open_failed({
        message: error instanceof Error ? error.message : String(error),
      }),
    );
  };
  return (media) => {
    if (media.path) {
      if (openAttachment) {
        openAttachment(attachmentOf(media.path, media.name ?? undefined));
      } else {
        void openInSystem(media.path);
      }
      return;
    }
    if (media.url) {
      openMediaUrl(media).catch(failed);
      return;
    }
    if (media.data && session) openMediaData(session, media).catch(failed);
  };
}
